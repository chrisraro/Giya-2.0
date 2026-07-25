-- ============================================================================
-- rpc_sweeps_smoke.sql (pgTAP)
-- Smoke tests for 0028: the two scheduled sweeps.
--
-- Covers public.sweep_stuck_receipts (the doc 36 dead-letter half a database
-- can honestly do alone), the pg_cron schedule rows themselves, that the
-- schedule did not break public.expire_claims, and the service_role-only
-- grants on every function 0028 touches.
--
-- The three receipt cases are the whole point of the design and are asserted
-- as a matched set, because each one alone is easy to get right:
--   * STUCK AND OUT OF BUDGET  -> rejected / manual / 'processing_failed'
--   * STUCK BUT WITHIN BUDGET  -> untouched (a retry could still save it)
--   * OUT OF BUDGET BUT RECENT -> untouched (merely slow is not dead)
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0028 applied. pgTAP
-- lives in the extensions schema.
--
-- Fixture strategy: identical to rpc_award_smoke.sql and rpc_record_visit_
-- smoke.sql. Insert directly into auth.users (the on_auth_user_created trigger
-- creates profiles + consumers), create the tenant via register_business under
-- set-local-role authenticated, then seed receipts as the privileged role
-- (standing in for the service-role pipeline). Every fixture id is captured
-- from its own "returning id" CTE and never looked up by name or by a global
-- select over the table, so live data can never be picked up instead of the
-- fixture's own rows.
--
-- now() is transaction-frozen, which is what makes the age arithmetic below
-- exact: the ages the fixtures are inserted with and the cutoff the function
-- computes are read from the same instant.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(23);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('e1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-sweep-owner@example.com', '{"full_name": "Sweep Owner"}'::jsonb),
  ('e3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-sweep-consumer@example.com', '{"full_name": "Sweep Consumer"}'::jsonb);

-- the owner registers the tenant; the business id comes straight back from the
-- RPC (0003_auth_plumbing.sql), so the tenant is never looked up by name
select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Sweep Cafe', 'cafe', 'cebu', '41 Reconciler Row')::text),
  true);
reset role;

-- Three receipts, all at 'processing', differing only in the two facts the
-- sweep is allowed to reason about: how long they have sat, and how much of
-- the attempt budget they have spent. `updated_at` is set explicitly on INSERT
-- because touch_receipts (0017) is a BEFORE UPDATE trigger and does not fire
-- here, which is exactly how a fixture can be older than its transaction.
--
-- ocr.max_attempts is 3 at platform scope (seeded by 0017), and this tenant
-- sets no business-scope override, so 3 is the effective budget for all three.
with r as (
     insert into public.receipts
       (business_id, user_id, status, image_path, image_hash, sha256, updated_at)
     values
       (current_setting('test.biz')::uuid,
        'e3333333-3333-4333-8333-333333333333',
        'processing',
        'e3333333-3333-4333-8333-333333333333/sweep-dead.jpg',
        'ffffffffffffffff', 'sweep-dead-sha-0000000000000000000000000000000000',
        now() - interval '48 hours')
     returning id)
select set_config('test.dead', (select id::text from r), true);

with r as (
     insert into public.receipts
       (business_id, user_id, status, image_path, image_hash, sha256, updated_at)
     values
       (current_setting('test.biz')::uuid,
        'e3333333-3333-4333-8333-333333333333',
        'processing',
        'e3333333-3333-4333-8333-333333333333/sweep-inbudget.jpg',
        'eeeeeeeeeeeeeeee', 'sweep-inbudget-sha-00000000000000000000000000000',
        now() - interval '48 hours')
     returning id)
select set_config('test.inbudget', (select id::text from r), true);

with r as (
     insert into public.receipts
       (business_id, user_id, status, image_path, image_hash, sha256, updated_at)
     values
       (current_setting('test.biz')::uuid,
        'e3333333-3333-4333-8333-333333333333',
        'processing',
        'e3333333-3333-4333-8333-333333333333/sweep-recent.jpg',
        'dddddddddddddddd', 'sweep-recent-sha-000000000000000000000000000000',
        now() - interval '5 minutes')
     returning id)
select set_config('test.recent', (select id::text from r), true);

-- attempt history. The dead one and the recent one have spent all three
-- attempts; the in-budget one has spent one of three.
insert into public.ocr_results (receipt_id, attempt, engine, engine_version, error)
select current_setting('test.dead')::uuid, a, 'google-vision', 'unknown',
       'OCR_UNAVAILABLE: provider timed out'
  from generate_series(1, 3) as a;

insert into public.ocr_results (receipt_id, attempt, engine, engine_version, error)
values (current_setting('test.inbudget')::uuid, 1, 'google-vision', 'unknown',
        'OCR_UNAVAILABLE: provider timed out');

insert into public.ocr_results (receipt_id, attempt, engine, engine_version, error)
select current_setting('test.recent')::uuid, a, 'google-vision', 'unknown',
       'OCR_UNAVAILABLE: provider timed out'
  from generate_series(1, 3) as a;

-- ------------------------------------------------------------ preconditions
-- 1. the threshold is data, not code
select is(
  (select value #>> '{}' from public.settings
    where scope = 'platform' and key = 'receipts.stuck_processing_hours'),
  '24',
  'receipts.stuck_processing_hours is registered at platform scope');

-- 2. the candidate scan has its partial index (0012 pattern)
select ok(
  exists (select 1 from pg_indexes
           where schemaname = 'public' and indexname = 'receipts_stuck_idx'),
  'receipts_stuck_idx exists for the stuck candidate scan');

-- ------------------------------------------------------------ the sweep
select set_config('test.swept',
  public.sweep_stuck_receipts(200)::text, true);

-- 3. exactly one of the three fixtures qualified
select is(
  current_setting('test.swept'),
  '1',
  'the sweep moved exactly one receipt');

-- 4-7. the genuinely dead receipt lands in doc 36's dead-letter state
select is(
  (select status from public.receipts where id = current_setting('test.dead')::uuid),
  'rejected',
  'a stuck receipt past its attempt budget is rejected');

select is(
  (select reject_reason from public.receipts where id = current_setting('test.dead')::uuid),
  'manual',
  'the dead-letter rejection reason is manual');

select is(
  (select reject_note from public.receipts where id = current_setting('test.dead')::uuid),
  'processing_failed',
  'the dead-letter note is processing_failed');

select ok(
  (select processed_at is not null and reviewed_by is null and reviewed_at is null
     from public.receipts where id = current_setting('test.dead')::uuid),
  'processed_at is stamped and no human is recorded as the reviewer');

-- 8-9. a receipt still within its attempt budget is not touched, however long
-- it has sat: a retry could still save it, and this function cannot retry
select is(
  (select status from public.receipts where id = current_setting('test.inbudget')::uuid),
  'processing',
  'a stuck receipt still within its attempt budget is left processing');

select ok(
  (select reject_reason is null and reject_note is null and processed_at is null
     from public.receipts where id = current_setting('test.inbudget')::uuid),
  'the in-budget receipt is left completely untouched');

-- 10-11. a receipt that is merely recent is not touched, however many attempts
-- it has spent: slow is not dead
select is(
  (select status from public.receipts where id = current_setting('test.recent')::uuid),
  'processing',
  'a recent receipt is left processing even with its attempt budget spent');

select ok(
  (select reject_reason is null and reject_note is null and processed_at is null
     from public.receipts where id = current_setting('test.recent')::uuid),
  'the recent receipt is left completely untouched');

-- 12. idempotent: the swept receipt is no longer a candidate, and the other two
-- still are not
select is(
  public.sweep_stuck_receipts(200)::text,
  '0',
  'a second run finds nothing, so the sweep cannot double-reject');

-- 13. no ledger row was written by any of this. The sweep touches exactly one
-- table, and a receipt at 'processing' has no earn row by construction, so a
-- rejection here can never orphan or contradict the ledger.
select is(
  (select count(*)::text from public.points_transactions
    where receipt_id in (current_setting('test.dead')::uuid,
                         current_setting('test.inbudget')::uuid,
                         current_setting('test.recent')::uuid)),
  '0',
  'the sweep writes no points ledger rows');

-- 14-15. the effective attempt budget is the BUSINESS-scope value when the
-- tenant sets one, matching the settings loader's own precedence. A fourth
-- fixture, stuck for 48h with 4 spent attempts: over the platform budget of 3,
-- under this tenant's 5. It must survive the sweep while the override stands
-- and be swept the moment it is removed, which is what proves the override is
-- the reason and not the fixture.
insert into public.settings (scope, business_id, key, value)
values ('business', current_setting('test.biz')::uuid, 'ocr.max_attempts', '5'::jsonb);

with r as (
     insert into public.receipts
       (business_id, user_id, status, image_path, image_hash, sha256, updated_at)
     values
       (current_setting('test.biz')::uuid,
        'e3333333-3333-4333-8333-333333333333',
        'processing',
        'e3333333-3333-4333-8333-333333333333/sweep-override.jpg',
        'cccccccccccccccc', 'sweep-override-sha-00000000000000000000000000000',
        now() - interval '48 hours')
     returning id)
select set_config('test.override', (select id::text from r), true);

insert into public.ocr_results (receipt_id, attempt, engine, engine_version, error)
select current_setting('test.override')::uuid, a, 'google-vision', 'unknown',
       'OCR_UNAVAILABLE: provider timed out'
  from generate_series(1, 4) as a;

select is(
  public.sweep_stuck_receipts(200)::text,
  '0',
  'a business-scope ocr.max_attempts override keeps the receipt out of the sweep');

delete from public.settings
 where scope = 'business'
   and business_id = current_setting('test.biz')::uuid
   and key = 'ocr.max_attempts';

select is(
  public.sweep_stuck_receipts(200)::text,
  '1',
  'removing the override puts the same receipt back over the platform budget');

-- ------------------------------------------------------------ expire_claims
-- Not a re-run of rpc_claim_smoke.sql, which owns the reversal ledger, the
-- balance restore and the inventory cap. All that is asserted here is that
-- scheduling it did not break it: the function still exists with the same
-- signature, the scheduled command is exactly the call, and running that
-- command is a clean no-op when nothing has lapsed.
select is(
  public.expire_claims(200)::text,
  '0',
  'expire_claims still runs and expires nothing when nothing has lapsed');

-- ------------------------------------------------------------ the schedules
-- 17-19. both jobs registered, on the doc 39 offsets, calling the real
-- functions. cron.job rows live outside this transaction, so these read the
-- deployed schedule rather than anything the fixtures created.
select is(
  (select schedule from cron.job where jobname = 'claims.expiry_sweep'),
  '7 * * * *',
  'claims.expiry_sweep runs hourly at :07 per doc 39');

select is(
  (select schedule from cron.job where jobname = 'receipts.stuck_sweep'),
  '50 * * * *',
  'receipts.stuck_sweep runs hourly at :50');

select ok(
  (select bool_and(active) from cron.job
    where jobname in ('claims.expiry_sweep', 'receipts.stuck_sweep'))
  and (select command from cron.job where jobname = 'claims.expiry_sweep')
      = 'select public.expire_claims(200);'
  and (select command from cron.job where jobname = 'receipts.stuck_sweep')
      = 'select public.sweep_stuck_receipts(200);',
  'both jobs are active and call the sweep functions directly');

-- ------------------------------------------------------------ grants
-- 20-23. system sweeps, service_role only, the 0016 pairing. No consumer and
-- no staff member may drain the expiry queue or reject a receipt, and no client
-- role may read the scheduler's error strings through sweep_job_health.
select ok(
  not has_function_privilege('anon', 'public.sweep_stuck_receipts(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
        'public.sweep_stuck_receipts(integer)', 'EXECUTE'),
  'anon and authenticated cannot execute sweep_stuck_receipts');

select ok(
  not has_function_privilege('anon', 'public.expire_claims(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
        'public.expire_claims(integer)', 'EXECUTE'),
  'anon and authenticated cannot execute expire_claims');

select ok(
  has_function_privilege('service_role', 'public.sweep_stuck_receipts(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.expire_claims(integer)', 'EXECUTE'),
  'service_role can execute both sweeps');

select ok(
  not has_function_privilege('anon', 'public.sweep_job_health(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
        'public.sweep_job_health(integer)', 'EXECUTE')
  and has_function_privilege('service_role',
        'public.sweep_job_health(integer)', 'EXECUTE'),
  'sweep_job_health is service_role only, so cron error strings stay operational');

select * from finish();

rollback;
