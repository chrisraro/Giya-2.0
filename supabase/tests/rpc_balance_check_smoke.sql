-- ============================================================================
-- rpc_balance_check_smoke.sql (pgTAP)
-- Smoke tests for 0056: public.balance_check and public.balance_check_
-- findings, task 2.2. Runs entirely inside one transaction and rolls back.
-- Execute as a privileged role (postgres) against a database with migrations
-- 0001-0056 applied.
--
-- Fixture strategy: mirror rpc_campaigns_sweep_smoke.sql / rpc_points_expiry_
-- smoke.sql. One business (owner registers via register_business under
-- set-local-role authenticated), six consumers created by inserting directly
-- into auth.users (the on_auth_user_created trigger creates profiles +
-- consumers). business_customers and points_transactions rows are seeded
-- directly as the privileged role, standing in for whatever writer produced
-- them - this suite is about the READER (balance_check), not the six writers,
-- which already have their own suites proving their own atomicity
-- (rpc_award_smoke.sql, rpc_claim_smoke.sql, rls_admin_smoke.sql's clawback
-- section, rpc_points_expiry_smoke.sql).
--
-- Consumer ids are chosen to sort in a KNOWN, deterministic order
-- (f2... < f3... < f4... < f5... < f6... < f7...) so the rotating-cursor
-- assertions below can name the EXACT pair each call touches, not just "some
-- pair, not necessarily which" - see the ROTATION block for why that
-- determinism is what makes the self-clearing proof tight rather than
-- circumstantial.
--
-- ON "concurrent-write safety": this suite cannot spin up a second, truly
-- concurrent database SESSION (no dblink or equivalent is installed in this
-- project, and no other pgTAP suite in this repo does either - grep finds
-- zero uses of dblink/pg_sleep for race simulation here). The property
-- 0056's header proves is a STRUCTURAL one - a single `with` statement gets
-- one MVCC snapshot for its whole duration, so a concurrent writer's commit
-- can never appear on only one side of the comparison - and that guarantee
-- does not depend on any runtime state a fixture could vary. What IS proven
-- here, as the closest honest runtime substitute (matching this repo's own
-- precedent of "sequential state simulation" for races it cannot spin up two
-- connections for - see cancel_claim's redeem-vs-cancel coverage in
-- rpc_claim_smoke.sql): a pair with a RICH, heterogeneous ledger (five rows
-- across four transaction types, standing in for many committed writer
-- transactions accumulated over time) still reconciles to zero drift, i.e.
-- the single-statement sum is not merely correct for a trivial one-row case.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(35);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('f1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-balchk-owner@example.com', '{"full_name": "Balance Check Owner"}'::jsonb),
  ('f2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-balchk-clean@example.com', '{"full_name": "Clean Pair"}'::jsonb),
  ('f3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-balchk-drift@example.com', '{"full_name": "Drifted Pair"}'::jsonb),
  ('f4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-balchk-rich@example.com', '{"full_name": "Rich Ledger Pair"}'::jsonb),
  ('f5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-balchk-rot1@example.com', '{"full_name": "Rotation Pair 1"}'::jsonb),
  ('f6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-balchk-rot2@example.com', '{"full_name": "Rotation Pair 2"}'::jsonb),
  ('f7777777-7777-4777-8777-777777777777', 'authenticated', 'authenticated',
   'giya-balchk-rot3@example.com', '{"full_name": "Rotation Pair 3"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "f1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Balance Check Cafe', 'cafe', 'cebu', '56 Ledger Row')::text),
  true);
reset role;

-- Pair A ("clean"): two earn rows summing to 500, cache agrees.
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'f2222222-2222-4222-8222-222222222222', 500);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.biz')::uuid, 'f2222222-2222-4222-8222-222222222222', 'earn', 300, 300),
  (current_setting('test.biz')::uuid, 'f2222222-2222-4222-8222-222222222222', 'earn', 200, 500);

-- Pair B ("drifted"): one earn row of 500, cache says 650 - a genuine,
-- constructed mismatch (the class of bug this whole task exists to catch;
-- no real writer produces this, which is exactly why it has to be
-- constructed directly as the privileged role rather than through any RPC).
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'f3333333-3333-4333-8333-333333333333', 650);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.biz')::uuid, 'f3333333-3333-4333-8333-333333333333', 'earn', 500, 500);

-- Pair F ("rich ledger"): five rows across four types, cache agrees with the
-- signed sum (1000 - 300 + 50 - 100 - 20 = 630).
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 630);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'earn',     1000, 1000),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'redeem',   -300,  700),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'adjust',     50,  750),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'expire',   -100,  650),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'clawback',  -20,  630);

-- ------------------------------------------------------ table fence + RLS
select has_table('public', 'balance_check_findings', 'balance_check_findings exists');

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.balance_check_findings'::regclass),
  'RLS is enabled on balance_check_findings');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'balance_check_findings'),
  0,
  'balance_check_findings carries zero policies (deny-all by construction)');

select ok(
  not has_table_privilege('anon', 'public.balance_check_findings', 'SELECT')
  and not has_table_privilege('authenticated', 'public.balance_check_findings', 'SELECT'),
  'anon and authenticated cannot select balance_check_findings');

select ok(
  has_table_privilege('service_role', 'public.balance_check_findings', 'SELECT'),
  'service_role can select balance_check_findings');

select ok(
  not has_table_privilege('service_role', 'public.balance_check_findings', 'INSERT')
  and not has_table_privilege('service_role', 'public.balance_check_findings', 'UPDATE')
  and not has_table_privilege('service_role', 'public.balance_check_findings', 'DELETE')
  and not has_table_privilege('service_role', 'public.balance_check_findings', 'TRUNCATE'),
  'service_role cannot write balance_check_findings directly - only public.balance_check may');

select throws_ok(
  $$ truncate public.balance_check_findings $$,
  'P0001',
  'balance_check_findings cannot be truncated (integrity evidence)',
  'the no-truncate statement trigger fires even for a role that still holds the privilege');

-- ------------------------------------------------------------ grants (I-A)
select ok(
  not has_function_privilege('anon', 'public.balance_check(integer)', 'EXECUTE'),
  'anon cannot execute public.balance_check');

select ok(
  not has_function_privilege('authenticated', 'public.balance_check(integer)', 'EXECUTE'),
  'authenticated cannot execute public.balance_check');

select ok(
  has_function_privilege('service_role', 'public.balance_check(integer)', 'EXECUTE'),
  'service_role can execute public.balance_check');

-- ------------------------------------------------------------ never touches the money path
select set_config('test.pt_count_before',
  (select count(*)::text from public.points_transactions), true);
select set_config('test.bc_balance_before',
  (select points_balance::text from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'), true);

-- This is a live, shared project: business_customers can carry rows this
-- suite did not create (real historical data, or another suite's fixtures).
-- p_limit is set generously (10000) so the run below covers EVERY existing
-- candidate, and the expected return value is read from a COUNT taken in the
-- same instant, not a hardcoded literal - the assertion is "this run checked
-- everything that existed", which holds regardless of how much unrelated
-- data is already live.
select set_config('test.bc_total_before_check1',
  (select count(*)::text from public.business_customers), true);

-- ------------------------------------------------------------ the check: A, B, F (+ whatever else is live)
select set_config('test.processed_1', public.balance_check(10000)::text, true);

select is(
  current_setting('test.processed_1'),
  current_setting('test.bc_total_before_check1'),
  'the first run checks every candidate that exists at that instant (at least A, B and F)');

select is(
  (select count(*)::text from public.points_transactions),
  current_setting('test.pt_count_before'),
  'balance_check writes zero points_transactions rows');

select is(
  (select points_balance::text from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'),
  current_setting('test.bc_balance_before'),
  'balance_check leaves the drifted pair''s cached balance untouched - detection only, never auto-corrected');

-- 12-14. Pair A: clean
select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f2222222-2222-4222-8222-222222222222'),
  500, 'pair A cached_balance recorded correctly');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f2222222-2222-4222-8222-222222222222'),
  500, 'pair A ledger_sum recorded correctly');
select ok(
  not (select drifted from public.balance_check_findings
        where business_id = current_setting('test.biz')::uuid
          and consumer_id = 'f2222222-2222-4222-8222-222222222222'),
  'pair A (clean) is NOT flagged as drifted');

-- 15-17. Pair B: genuinely drifted
select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'),
  650, 'pair B cached_balance recorded correctly');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'),
  500, 'pair B ledger_sum recorded correctly');
select ok(
  (select drifted from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'),
  'pair B (genuinely drifted, 650 cached vs 500 ledger) IS flagged as drifted');

-- 18-20. Pair F: rich, heterogeneous ledger still reconciles (the
-- "concurrent-write safety" proxy - see file header)
select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f4444444-4444-4444-8444-444444444444'),
  630, 'pair F cached_balance recorded correctly');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f4444444-4444-4444-8444-444444444444'),
  630, 'pair F ledger_sum (five rows, four types) sums correctly in one statement');
select ok(
  not (select drifted from public.balance_check_findings
        where business_id = current_setting('test.biz')::uuid
          and consumer_id = 'f4444444-4444-4444-8444-444444444444'),
  'pair F (rich ledger, clean) is NOT flagged as drifted');

-- ------------------------------------------------------------ p_limit=0 edge case
select is(
  public.balance_check(0)::text,
  '0',
  'p_limit=0 checks nothing and returns 0 (no error)');

-- ============================================================================
-- ROTATION: genuine self-clearing under a TIGHT p_limit, proven by naming the
-- EXACT pair each call touches (deterministic consumer-id ordering - see file
-- header). Three fresh, never-checked pairs (C, D, E) are added AFTER the
-- first run above, so at this point A/B/F already carry a real checked_at and
-- C/D/E carry none (null sorts first). This is the same shape rpc_points_
-- expiry_smoke.sql and rpc_campaigns_sweep_smoke.sql use for their own I2/I1
-- self-clearing proofs: a p_limit=200/8-fixture "second run is 0" cannot tell
-- "rotated" from "stuck"; a p_limit=1 run that reaches a LATER pair only once
-- EARLIER ones have had their turn can.
-- ============================================================================
insert into public.business_customers (business_id, consumer_id, points_balance)
values
  (current_setting('test.biz')::uuid, 'f5555555-5555-4555-8555-555555555555', 100),
  (current_setting('test.biz')::uuid, 'f6666666-6666-4666-8666-666666666666', 100),
  (current_setting('test.biz')::uuid, 'f7777777-7777-4777-8777-777777777777', 100);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.biz')::uuid, 'f5555555-5555-4555-8555-555555555555', 'earn', 100, 100),
  (current_setting('test.biz')::uuid, 'f6666666-6666-4666-8666-666666666666', 'earn', 100, 100),
  (current_setting('test.biz')::uuid, 'f7777777-7777-4777-8777-777777777777', 'earn', 100, 100);

-- 22. call 1/4, p_limit=1: only C/D/E are unchecked (null sorts first); the
-- smallest consumer_id among them is f5... (C)
select is(public.balance_check(1)::text, '1', 'rotation call 1 processes exactly one pair');
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f5555555-5555-4555-8555-555555555555'),
  1, 'rotation call 1 touched pair C (f5..., the smallest never-checked consumer_id)');
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id in ('f6666666-6666-4666-8666-666666666666',
                           'f7777777-7777-4777-8777-777777777777')),
  0, 'rotation call 1 did NOT touch D or E - the whole budget went to one pair, not spread or repeated');

-- 25. call 2/4: D (f6...) is next - E is also still null but sorts after D
select is(public.balance_check(1)::text, '1', 'rotation call 2 processes exactly one pair');
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f6666666-6666-4666-8666-666666666666'),
  1, 'rotation call 2 touched pair D (f6...), NOT re-selecting C');

-- 27. call 3/4: E (f7...) is the last never-checked pair
select is(public.balance_check(1)::text, '1', 'rotation call 3 processes exactly one pair');
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f7777777-7777-4777-8777-777777777777'),
  1, 'rotation call 3 touched pair E (f7...), NOT re-selecting C or D');

-- 29. all of C, D, E have now been checked exactly once
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id in ('f5555555-5555-4555-8555-555555555555',
                           'f6666666-6666-4666-8666-666666666666',
                           'f7777777-7777-4777-8777-777777777777')),
  3, 'C, D and E all now have exactly one finding each - coverage genuinely advanced');

-- 30-31. call 4/4: C/D/E are now the MOST recently checked pairs in the whole
-- table (their checked_at is strictly newer than every other candidate's,
-- including A/B/F AND any unrelated live row this suite did not create), so
-- the cursor MUST rotate to something outside {C, D, E} next - proving
-- rotation is not limited to the fixtures added most recently, it cycles the
-- WHOLE candidate set. Which specific older pair it lands on is not asserted
-- (this is a live, shared project - some other pre-existing row could sort
-- first); what matters, and is fully determined regardless of what else is
-- live, is that it is NOT one of the three just-rotated pairs.
select is(public.balance_check(1)::text, '1', 'rotation call 4 processes exactly one pair');
select ok(
  not exists (
    select 1 from public.balance_check_findings f
     where f.checked_at = (select max(checked_at) from public.balance_check_findings)
       and f.business_id = current_setting('test.biz')::uuid
       and f.consumer_id in ('f5555555-5555-4555-8555-555555555555',
                              'f6666666-6666-4666-8666-666666666666',
                              'f7777777-7777-4777-8777-777777777777')
  ),
  'call 4''s freshest checked_at belongs to a pair OUTSIDE {C, D, E} - the cursor rotated back into the older candidate pool rather than re-selecting one of the trio it just finished');

-- ------------------------------------------------------------ the schedule
select is(
  (select schedule from cron.job where jobname = 'integrity.balance_check'),
  '40 18 * * *',
  'integrity.balance_check runs daily at 02:40 Manila (40 18 UTC) per doc 39''s sample slot');

select ok(
  (select active from cron.job where jobname = 'integrity.balance_check')
  and (select command from cron.job where jobname = 'integrity.balance_check')
      = 'select public.balance_check(500);',
  'integrity.balance_check is active and calls the function directly with the documented default');

select * from finish();

rollback;
