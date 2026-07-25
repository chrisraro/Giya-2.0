-- ============================================================================
-- rls_campaigns_smoke.sql (pgTAP)
-- Smoke tests for campaigns-domain RLS and integrity (campaigns, points_rules,
-- points_transactions ledger). Runs entirely inside one transaction and rolls
-- back. Execute as a privileged role (postgres) against a database with
-- migrations 0001-0012 applied. pgTAP lives in the extensions schema.
--
-- Fixture strategy: mirror rls_catalog_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- then create two tenant businesses via the register_business RPC under
-- set-local-role authenticated. Staff policies are table-truth
-- (private.is_active_staff over the business_staff rows register_business
-- creates), so no biz claim is needed in the JWT.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(14);

-- ---------------------------------------------------------------- fixtures
-- Three fixed test users: two business owners and one bare consumer.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('66666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-campaigns-owner1@example.com', '{"full_name": "Campaign Owner One"}'::jsonb),
  ('77777777-7777-4777-8777-777777777777', 'authenticated', 'authenticated',
   'giya-campaigns-owner2@example.com', '{"full_name": "Campaign Owner Two"}'::jsonb),
  ('88888888-8888-4888-8888-888888888888', 'authenticated', 'authenticated',
   'giya-campaigns-consumer@example.com', '{"full_name": "Points Consumer"}'::jsonb);

-- owner1 registers tenant 1
select set_config('request.jwt.claims',
  '{"sub": "66666666-6666-4666-8666-666666666666", "role": "authenticated"}', true);
set local role authenticated;
select public.register_business('Campaign Cafe', 'cafe', 'cebu', '1 Promo Street');
reset role;

-- owner2 registers tenant 2
select set_config('request.jwt.claims',
  '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated"}', true);
set local role authenticated;
select public.register_business('Rival Rewards', 'restaurant', 'manila', '2 Other Ave');
reset role;

-- park tenant ids in transaction-local settings for use under app roles
select set_config('test.biz1',
  (select id::text from public.businesses where name = 'Campaign Cafe'), true);
select set_config('test.biz2',
  (select id::text from public.businesses where name = 'Rival Rewards'), true);

-- ---------------------------------------------------------------- owner writes (P1)
select set_config('request.jwt.claims',
  '{"sub": "66666666-6666-4666-8666-666666666666", "role": "authenticated"}', true);
set local role authenticated;

-- 1. owner inserts an active campaign
select lives_ok(
  $$insert into public.campaigns (business_id, type, status, name)
    values (current_setting('test.biz1')::uuid, 'promotion', 'active', 'Summer Splash')$$,
  'owner inserts an active campaign into own tenant (P1 insert, table-truth staff)');

-- 2. owner inserts a draft campaign
select lives_ok(
  $$insert into public.campaigns (business_id, type, name)
    values (current_setting('test.biz1')::uuid, 'reward', 'Secret Draft')$$,
  'owner inserts a draft campaign into own tenant (P1 insert)');

-- 3. staff select: owner sees both, including the draft
select is(
  (select count(*)::int from public.campaigns
    where business_id = current_setting('test.biz1')::uuid),
  2,
  'owner sees both active and draft campaigns of own tenant (P1 staff select)');

-- 4. one-active-base-rule invariant: first base rule inserts fine
select lives_ok(
  $$insert into public.points_rules (business_id, kind, rule_type, rate_centavos_per_point)
    values (current_setting('test.biz1')::uuid, 'base', 'amount_rate', 100)$$,
  'owner inserts an active base points rule (P1 insert, owner/manager)');

-- 5. a second active base rule for the same business violates points_rules_one_base
select throws_ok(
  $$insert into public.points_rules (business_id, kind, rule_type, rate_centavos_per_point)
    values (current_setting('test.biz1')::uuid, 'base', 'amount_rate', 500)$$,
  '23505',
  null,
  'second active base points rule for same business raises unique_violation (points_rules_one_base)');

reset role;

-- ---------------------------------------------------------------- anon reads
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

-- 6. anon sees the active campaign
select is(
  (select count(*)::int from public.campaigns where name = 'Summer Splash'),
  1,
  'anon sees the active campaign (P1 public select)');

-- 7. anon does not see the draft campaign
select is(
  (select count(*)::int from public.campaigns where name = 'Secret Draft'),
  0,
  'anon does not see the draft campaign (P1 public select is active-only)');

reset role;

-- ---------------------------------------------------------------- cross-tenant deny
select set_config('request.jwt.claims',
  '{"sub": "77777777-7777-4777-8777-777777777777", "role": "authenticated"}', true);
set local role authenticated;

-- 8. tenant-2 owner cannot see tenant-1's draft campaign (the active one is
--    public by design, so the draft is the isolation probe)
select is(
  (select count(*)::int from public.campaigns where name = 'Secret Draft'),
  0,
  'tenant-2 owner cannot see tenant-1 draft campaign (P1 cross-tenant deny)');

-- 9. tenant-2 owner cannot insert a campaign into tenant-1
select throws_ok(
  $$insert into public.campaigns (business_id, type, name)
    values (current_setting('test.biz1')::uuid, 'promotion', 'Hijack Promo')$$,
  '42501',
  null,
  'tenant-2 owner insert into tenant-1 campaigns is blocked (P1 with check)');

reset role;

-- ---------------------------------------------------------------- ledger immutability
-- Seed two ledger rows as the privileged role (stands in for the service-role
-- points service): one for the bare consumer, one for owner2-as-consumer.
-- 10. inserts succeed (append is allowed)
select lives_ok(
  $$insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
    values
      (current_setting('test.biz1')::uuid, '88888888-8888-4888-8888-888888888888', 'earn', 10, 10),
      (current_setting('test.biz1')::uuid, '77777777-7777-4777-8777-777777777777', 'earn', 25, 25)$$,
  'privileged role appends ledger rows (insert is the only allowed write)');

-- 11. UPDATE raises even for the privileged role (trigger, not just grants)
select throws_ok(
  $$update public.points_transactions set points = 999
    where consumer_id = '88888888-8888-4888-8888-888888888888'$$,
  'P0001',
  'points_transactions is append-only',
  'ledger UPDATE raises via append-only trigger');

-- 12. DELETE raises even for the privileged role
select throws_ok(
  $$delete from public.points_transactions
    where consumer_id = '88888888-8888-4888-8888-888888888888'$$,
  'P0001',
  'points_transactions is append-only',
  'ledger DELETE raises via append-only trigger');

-- ---------------------------------------------------------------- consumer ledger reads (P3)
select set_config('request.jwt.claims',
  '{"sub": "88888888-8888-4888-8888-888888888888", "role": "authenticated"}', true);
set local role authenticated;

-- 13. consumer sees only own ledger rows (two rows exist; one is theirs)
select is(
  (select count(*)::int from public.points_transactions),
  1,
  'consumer sees only own points_transactions rows (P3 consumer select)');

-- 14. consumer cannot insert into the ledger (service-role fence: no client
--     insert policy)
select throws_ok(
  $$insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
    values (current_setting('test.biz1')::uuid, '88888888-8888-4888-8888-888888888888', 'earn', 5, 15)$$,
  '42501',
  null,
  'consumer insert into points_transactions is blocked (no client write policy)');

reset role;

select * from finish();

rollback;
