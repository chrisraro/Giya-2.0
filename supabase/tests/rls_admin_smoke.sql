-- ============================================================================
-- rls_admin_smoke.sql (pgTAP)
-- Smoke tests for 0031: the admin SELECT policies 0017 and 0022 deferred, and
-- the clawback RPC (doc 37 consequences ladder step 5).
--
-- The shape of every policy assertion here is the same pair, and the pair is
-- the point: an ADMIN session reads a row belonging to a tenant it has no
-- membership of, and a NON-ADMIN session with a real membership of a DIFFERENT
-- tenant does not. One half alone proves nothing - a policy of `using (true)`
-- passes the first assertion and is a catastrophe.
--
-- The admin session is produced the only way it can be: by setting
-- request.jwt.claims with app_metadata.is_platform_admin, which is exactly what
-- private.custom_access_token_hook (0003) stamps at token issuance and exactly
-- what private.is_admin() reads. The fixture therefore tests the same predicate
-- production evaluates, not a stand-in for it.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0031 applied. pgTAP
-- lives in the extensions schema.
--
-- Fixture strategy: identical to rls_receipts_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- create two tenants via register_business under set-local-role authenticated
-- capturing the returned business id, then seed receipts, evidence and ledger
-- rows as the privileged role (which stands in for the service-role pipeline,
-- the only writer of those tables).
--
-- HARD RULE, inherited from rls_receipts_smoke.sql and just as load-bearing
-- here: every fixture id is captured off its own "insert ... returning" CTE.
-- Nothing is looked up by name or by any predicate over a whole table - this
-- database also holds live data, and this suite's assertions about a
-- PLATFORM-WIDE audience are exactly the ones a live row would corrupt. Every
-- count below is scoped to a fixture id.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(43);

-- ---------------------------------------------------------------- fixtures
-- Six users: a platform admin, a support-role admin (doc 01's read-only row of
-- the matrix, which the clawback RPC must refuse), two business owners and two
-- consumers.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('a1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-admin-platform@example.com', '{"full_name": "Platform Admin"}'::jsonb),
  ('a2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-admin-support@example.com', '{"full_name": "Support Admin"}'::jsonb),
  ('a3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-admin-owner1@example.com', '{"full_name": "Admin Suite Owner One"}'::jsonb),
  ('a4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-admin-owner2@example.com', '{"full_name": "Admin Suite Owner Two"}'::jsonb),
  ('a5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-admin-consumer1@example.com', '{"full_name": "Admin Suite Consumer"}'::jsonb),
  ('a6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-admin-consumer2@example.com', '{"full_name": "Other Admin Consumer"}'::jsonb);

insert into public.platform_admins (user_id, role, is_active)
values
  ('a1111111-1111-4111-8111-111111111111', 'admin', true),
  ('a2222222-2222-4222-8222-222222222222', 'support', true);

-- Two tenants, ids captured straight off the RPC's return value.
select set_config('request.jwt.claims',
  '{"sub": "a3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.abiz1',
  (select public.register_business('Admin Suite Cafe', 'cafe', 'cebu', '1 Admin Street')::text),
  true);
reset role;

select set_config('request.jwt.claims',
  '{"sub": "a4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.abiz2',
  (select public.register_business('Admin Suite Rival', 'restaurant', 'manila', '2 Admin Ave')::text),
  true);
reset role;

-- Receipts. ar3 is the one this migration exists for: business_id null, so
-- 0017's staff policy cannot see it and 0017's own comment says no audience on
-- this database could.
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_number, receipt_date, total_centavos)
  values
    (current_setting('test.abiz1')::uuid, 'a5555555-5555-4555-8555-555555555555',
     'approved', 'a5555555/ar1.jpg', 'aa00bb11cc22dd33', 'sha-admin-ar1',
     'AR-001', now() - interval '1 day', 100000),
    (current_setting('test.abiz2')::uuid, 'a6666666-6666-4666-8666-666666666666',
     'approved', 'a6666666/ar2.jpg', 'bb00cc11dd22ee33', 'sha-admin-ar2',
     'AR-002', now() - interval '1 day', 60000),
    (null, 'a5555555-5555-4555-8555-555555555555',
     'review', 'a5555555/ar3.jpg', 'cc00dd11ee22ff33', 'sha-admin-ar3',
     'AR-003', now() - interval '2 hours', 42000),
    (current_setting('test.abiz1')::uuid, 'a5555555-5555-4555-8555-555555555555',
     'approved', 'a5555555/ar4.jpg', 'dd00ee11ff223344', 'sha-admin-ar4',
     'AR-004', now() - interval '1 day', 50000)
  returning id, sha256
)
select
  set_config('test.ar1', (select id::text from ins where sha256 = 'sha-admin-ar1'), true),
  set_config('test.ar2', (select id::text from ins where sha256 = 'sha-admin-ar2'), true),
  set_config('test.ar3', (select id::text from ins where sha256 = 'sha-admin-ar3'), true),
  set_config('test.ar4', (select id::text from ins where sha256 = 'sha-admin-ar4'), true);

-- Tenant 2's evidence: the cross-tenant probe for four tables at once.
insert into public.fraud_signals (business_id, receipt_id, consumer_id, signal, severity, score, evidence)
values (current_setting('test.abiz2')::uuid, current_setting('test.ar2')::uuid,
        'a6666666-6666-4666-8666-666666666666', 'image_hash_dup', 'block', 1.000,
        jsonb_build_object('hamming_distance', 2, 'cross_consumer', true));

insert into public.ocr_results (receipt_id, attempt, engine_version, raw_text, mean_confidence)
values (current_setting('test.ar2')::uuid, 1, 'test-1.0', 'ADMIN SUITE RIVAL TOTAL 600.00', 0.910);

insert into public.receipt_line_items (business_id, receipt_id, raw_text, line_total_centavos, sort)
values (current_setting('test.abiz2')::uuid, current_setting('test.ar2')::uuid,
        'RIVAL COMBO MEAL', 60000, 0);

insert into public.ai_usage_events (business_id, kind, model, units, cost_micros)
values (current_setting('test.abiz2')::uuid, 'ocr', 'test-vlm', 1, 250);

-- Two audit rows: one platform-level (business_id null - the rows 0022 said no
-- tenant could ever see) and one belonging to tenant 2.
with ins as (
  insert into public.audit_logs
    (actor_id, actor_kind, actor_role, business_id, action, entity_type, entity_id, reason, request_id)
  values
    ('a1111111-1111-4111-8111-111111111111', 'admin', 'admin', null,
     'consumer.suspended', 'profile', 'a6666666-6666-4666-8666-666666666666',
     'cross-business duplicate ring', 'req-admin-platform'),
    ('a1111111-1111-4111-8111-111111111111', 'admin', 'admin',
     current_setting('test.abiz2')::uuid,
     'receipt.review_rejected', 'receipt', current_setting('test.ar2')::uuid,
     'duplicate of a receipt at another business', 'req-admin-tenant2')
  returning id, request_id
)
select
  set_config('test.audit_platform', (select id::text from ins where request_id = 'req-admin-platform'), true),
  set_config('test.audit_tenant2',  (select id::text from ins where request_id = 'req-admin-tenant2'), true);

-- The two earns the clawback tests reverse. Written through the real RPC, not
-- by hand: a clawback whose fixture ledger row was hand-rolled would not prove
-- it can reverse what 0018 actually writes.
select set_config('test.earn1',
  public.award_receipt_points(current_setting('test.ar1')::uuid, 400)::text, true);
select set_config('test.earn4',
  public.award_receipt_points(current_setting('test.ar4')::uuid, 200)::text, true);

-- ============================================================ admin reads
-- The admin session. app_metadata.is_platform_admin is what the token hook
-- stamps and what private.is_admin() reads; nothing else in the claim matters
-- to any policy under test.
select set_config('request.jwt.claims',
  '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated",
    "app_metadata": {"is_platform_admin": true, "admin_role": "admin"}}', true);
set local role authenticated;

select ok(private.is_admin(), 'is_admin() is true for a session carrying the platform-admin claim');

select is(
  (select count(*) from public.fraud_signals where receipt_id = current_setting('test.ar2')::uuid),
  1::bigint,
  'admin reads another tenant''s fraud_signals (doc 24 line 105, doc 37 platform-wide queue)');

select is(
  (select count(*) from public.receipts where id = current_setting('test.ar2')::uuid),
  1::bigint,
  'admin reads another tenant''s receipt');

select is(
  (select count(*) from public.receipts where id = current_setting('test.ar3')::uuid),
  1::bigint,
  'admin reads the UNMATCHED receipt (business_id null) that no tenant can see');

select is(
  (select count(*) from public.receipt_line_items where receipt_id = current_setting('test.ar2')::uuid),
  1::bigint,
  'admin reads another tenant''s receipt_line_items');

select is(
  (select count(*) from public.ocr_results where receipt_id = current_setting('test.ar2')::uuid),
  1::bigint,
  'admin reads another tenant''s ocr_results');

select is(
  (select count(*) from public.ai_usage_events where business_id = current_setting('test.abiz2')::uuid),
  1::bigint,
  'admin reads another tenant''s ai_usage_events (doc 31 section 8 top-spender comparison)');

select is(
  (select count(*) from public.audit_logs where id = current_setting('test.audit_platform')::uuid),
  1::bigint,
  'admin reads the PLATFORM-level audit row (business_id null) 0022 left unreadable');

select is(
  (select count(*) from public.audit_logs where id = current_setting('test.audit_tenant2')::uuid),
  1::bigint,
  'admin reads another tenant''s audit rows');

select is(
  (select count(*) from public.settings where scope = 'platform' and key = 'fraud.review_threshold'),
  1::bigint,
  'admin reads platform settings (doc 25: platform rows admin-only)');

-- The column fence is UNCHANGED by an admin policy: column privileges are
-- role-wide and an admin is `authenticated`. Asserted rather than assumed,
-- because the migration's own header claims it.
select is(
  has_column_privilege('authenticated', 'public.receipts', 'parse_meta', 'select'),
  false,
  'receipts.parse_meta stays outside the authenticated grant even for an admin');
select is(
  has_column_privilege('authenticated', 'public.audit_logs', 'ip', 'select'),
  false,
  'audit_logs.ip stays outside the authenticated grant even for an admin');

reset role;

-- ============================================================ non-admin reads
-- Owner of tenant 1. A REAL membership of a REAL tenant, so every failure below
-- is "this policy did not widen", never "this session had no access to
-- anything". No admin claim is set.
select set_config('request.jwt.claims',
  '{"sub": "a3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

select ok(not private.is_admin(), 'is_admin() is false for a session with no platform-admin claim');

select is(
  (select count(*) from public.fraud_signals where receipt_id = current_setting('test.ar2')::uuid),
  0::bigint,
  'a non-admin owner does NOT read another tenant''s fraud_signals');

select is(
  (select count(*) from public.receipts where id = current_setting('test.ar2')::uuid),
  0::bigint,
  'a non-admin owner does NOT read another tenant''s receipt');

select is(
  (select count(*) from public.receipts where id = current_setting('test.ar3')::uuid),
  0::bigint,
  'a non-admin owner does NOT read the unmatched receipt');

select is(
  (select count(*) from public.receipt_line_items where receipt_id = current_setting('test.ar2')::uuid),
  0::bigint,
  'a non-admin owner does NOT read another tenant''s line items');

select is(
  (select count(*) from public.ocr_results where receipt_id = current_setting('test.ar2')::uuid),
  0::bigint,
  'a non-admin owner does NOT read another tenant''s ocr_results');

select is(
  (select count(*) from public.ai_usage_events where business_id = current_setting('test.abiz2')::uuid),
  0::bigint,
  'a non-admin owner does NOT read another tenant''s ai_usage_events');

select is(
  (select count(*) from public.audit_logs where id = current_setting('test.audit_platform')::uuid),
  0::bigint,
  'a non-admin owner does NOT read platform-level audit rows');

select is(
  (select count(*) from public.audit_logs where id = current_setting('test.audit_tenant2')::uuid),
  0::bigint,
  'a non-admin owner does NOT read another tenant''s audit rows');

select is(
  (select count(*) from public.settings where scope = 'platform'),
  0::bigint,
  'a non-admin owner does NOT read platform settings (the fraud rulebook stays closed)');

-- The tenant-1 owner still reads their OWN tenant, so the assertions above are
-- about scope and not about a session that could read nothing at all.
select is(
  (select count(*) from public.receipts where id = current_setting('test.ar1')::uuid),
  1::bigint,
  'the same non-admin owner still reads their own tenant''s receipt');

reset role;

-- ============================================================ clawback: fences
select is(
  has_function_privilege('authenticated', 'public.clawback_receipt_points(uuid,uuid,text,text)', 'execute'),
  false,
  'clawback_receipt_points is not executable by authenticated');
select is(
  has_function_privilege('anon', 'public.clawback_receipt_points(uuid,uuid,text,text)', 'execute'),
  false,
  'clawback_receipt_points is not executable by anon');
select is(
  has_function_privilege('service_role', 'public.clawback_receipt_points(uuid,uuid,text,text)', 'execute'),
  true,
  'clawback_receipt_points is executable by service_role');

-- ============================================================ clawback: guards
select throws_ok(
  format($$select public.clawback_receipt_points(%L::uuid, %L::uuid, '   ')$$,
         current_setting('test.ar1'), 'a1111111-1111-4111-8111-111111111111'),
  'P0001', 'CLAWBACK_REASON_REQUIRED',
  'a blank reason is refused before anything is read (doc 15 reason-required)');

select throws_ok(
  format($$select public.clawback_receipt_points(%L::uuid, %L::uuid, 'confirmed ring member')$$,
         current_setting('test.ar1'), 'a5555555-5555-4555-8555-555555555555'),
  'P0001', 'CLAWBACK_FORBIDDEN',
  'a non-admin actor is refused by table truth, not by the claim');

select throws_ok(
  format($$select public.clawback_receipt_points(%L::uuid, %L::uuid, 'confirmed ring member')$$,
         current_setting('test.ar1'), 'a2222222-2222-4222-8222-222222222222'),
  'P0001', 'CLAWBACK_FORBIDDEN',
  'the support role is refused (doc 01 matrix: support never mutates)');

select throws_ok(
  format($$select public.clawback_receipt_points(%L::uuid, %L::uuid, 'never awarded')$$,
         current_setting('test.ar3'), 'a1111111-1111-4111-8111-111111111111'),
  'P0001', 'CLAWBACK_INVALID_STATE',
  'a receipt with no earn row is CLAWBACK_INVALID_STATE (doc 37)');

-- ============================================================ clawback: full
-- ar1 earned 400 and the balance is 400, so the whole earn is recoverable.
select set_config('test.claw1',
  (public.clawback_receipt_points(
     current_setting('test.ar1')::uuid,
     'a1111111-1111-4111-8111-111111111111',
     'image matched a receipt at another business',
     'req-claw-1'))::text, true);

select is(
  (current_setting('test.claw1')::jsonb->>'clawed_points')::integer, 400,
  'a fully recoverable clawback claws the whole earn');
select is(
  (current_setting('test.claw1')::jsonb->>'shortfall_points')::integer, 0,
  'a fully recoverable clawback records no shortfall');

select is(
  (select points from public.points_transactions
    where reverses_id = current_setting('test.earn1')::uuid and type = 'clawback'),
  -400,
  'the ledger row is negative and points at the earn it reverses');

select is(
  (select balance_after from public.points_transactions
    where reverses_id = current_setting('test.earn1')::uuid and type = 'clawback'),
  200,
  'balance_after is computed under the pair lock (400 earned + 200 earned - 400 clawed)');

select is(
  (select status || '/' || coalesce(reject_reason, 'none') from public.receipts
    where id = current_setting('test.ar1')::uuid),
  'rejected/fraud_suspected',
  'the receipt lands on rejected/fraud_suspected (doc 37 ladder step 5)');

select is(
  (select reviewed_by from public.receipts where id = current_setting('test.ar1')::uuid),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'reviewed_by names the acting admin');

select is(
  (select reason from public.audit_logs
    where action = 'fraud.clawback_applied' and entity_id = current_setting('test.ar1')::uuid),
  'image matched a receipt at another business',
  'the clawback writes its audit row with the mandatory reason, in the same transaction');

select is(
  (select actor_kind from public.audit_logs
    where action = 'fraud.clawback_applied' and entity_id = current_setting('test.ar1')::uuid),
  'admin',
  'the audit row is actor_kind=admin, which is what makes reason mandatory in the database');

select throws_ok(
  format($$select public.clawback_receipt_points(%L::uuid, %L::uuid, 'second attempt')$$,
         current_setting('test.ar1'), 'a1111111-1111-4111-8111-111111111111'),
  'P0001', 'CLAWBACK_INVALID_STATE',
  'a second clawback of the same earn is refused (doc 35 idempotency)');

-- ============================================================ clawback: clamped
-- The pair balance is now 200 and ar4 earned 200; spend 150 through a redeem so
-- the remaining balance (50) is less than the earn being reversed. doc 35's
-- worked example, at this suite's scale.
insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.abiz1')::uuid, 'a5555555-5555-4555-8555-555555555555',
   'redeem', -150, 50);
update public.business_customers
   set points_balance = 50
 where business_id = current_setting('test.abiz1')::uuid
   and consumer_id = 'a5555555-5555-4555-8555-555555555555';

select set_config('test.claw4',
  (public.clawback_receipt_points(
     current_setting('test.ar4')::uuid,
     'a1111111-1111-4111-8111-111111111111',
     'same ring, second receipt',
     'req-claw-4'))::text, true);

select is(
  (current_setting('test.claw4')::jsonb->>'clawed_points')::integer, 50,
  'the clawback is clamped to the remaining balance');
select is(
  (current_setting('test.claw4')::jsonb->>'shortfall_points')::integer, 150,
  'the unrecoverable residual is reported as a shortfall, never as negative balance');

select is(
  (select points_balance from public.business_customers
    where business_id = current_setting('test.abiz1')::uuid
      and consumer_id = 'a5555555-5555-4555-8555-555555555555'),
  0,
  'the balance floors at zero rather than going negative');

select is(
  (select (after->>'shortfall_points')::integer from public.audit_logs
    where action = 'fraud.clawback_applied' and entity_id = current_setting('test.ar4')::uuid),
  150,
  'the shortfall is recorded in audit_logs.after (doc 35 section 9 residual-debt policy)');

select * from finish();
rollback;
