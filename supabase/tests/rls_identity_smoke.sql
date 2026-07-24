-- ============================================================================
-- rls_identity_smoke.sql (pgTAP)
-- Smoke tests for identity-domain RLS, the signup trigger, and the
-- register_business RPC. Runs entirely inside one transaction and rolls back.
-- Execute as a privileged role (postgres) against a database with migrations
-- 0001-0003 applied. pgTAP lives in the extensions schema.
--
-- Fixture strategy: we insert directly into auth.users (id, email only, plus
-- metadata). This is the robust path here because public.profiles has a hard
-- FK to auth.users(id), so seeding public tables alone cannot satisfy the
-- schema; the insert also exercises the on_auth_user_created trigger for real.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(12);

-- ---------------------------------------------------------------- fixtures
-- Two fixed test users. The after-insert trigger creates profiles + consumers.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-test-user1@example.com', '{"full_name": "Test User One"}'::jsonb),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-test-user2@example.com', '{"full_name": "Test User Two"}'::jsonb);

-- 1. signup trigger created the profile
select is(
  (select count(*)::int from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'
      and display_name = 'Test User One'),
  1,
  'handle_new_user creates a profiles row from raw_user_meta_data full_name');

-- 2. signup trigger created the consumer with a valid referral code
select matches(
  (select referral_code from public.consumers
    where id = '11111111-1111-4111-8111-111111111111'),
  '^[A-Z2-7]{8}$',
  'handle_new_user creates a consumers row with an 8-char base32 referral code');

-- ---------------------------------------------------------------- register_business
-- 3. user1 registers a business through the public RPC wrapper
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$select public.register_business('Test Cafe', 'cafe', 'cebu', '123 Test Street')$$,
  'register_business succeeds for an authenticated user');

reset role;

-- 4. user2 registers a second business (cross-tenant fixture)
select set_config('request.jwt.claims',
  '{"sub": "22222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$select public.register_business('Other Bar', 'restaurant', 'manila', '456 Other Ave')$$,
  'register_business succeeds for a second user');

reset role;

-- 5. RPC created the businesses row (checked as privileged role, RLS bypassed)
select is(
  (select count(*)::int from public.businesses
    where name = 'Test Cafe' and status = 'draft'),
  1,
  'register_business creates a draft businesses row');

-- 6. RPC created the active owner business_staff row
select is(
  (select count(*)::int from public.business_staff bs
    join public.businesses b on b.id = bs.business_id
   where b.name = 'Test Cafe'
     and bs.user_id = '11111111-1111-4111-8111-111111111111'
     and bs.role = 'owner' and bs.status = 'active'),
  1,
  'register_business creates the active owner business_staff row');

-- ---------------------------------------------------------------- P2: profiles
select set_config('request.jwt.claims',
  '{"sub": "11111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 7. consumer sees own profile
select is(
  (select count(*)::int from public.profiles
    where id = '11111111-1111-4111-8111-111111111111'),
  1,
  'consumer sees own profile (P2)');

-- 8. consumer cannot see another user''s profile
select is(
  (select count(*)::int from public.profiles
    where id = '22222222-2222-4222-8222-222222222222'),
  0,
  'consumer cannot see another profile (P2)');

reset role;

-- ---------------------------------------------------------------- anon: businesses
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

-- 9. anon sees zero businesses (both fixtures are draft, not active)
select is(
  (select count(*)::int from public.businesses),
  0,
  'anon sees zero draft businesses (public read is active-only)');

reset role;

-- ---------------------------------------------------------------- staff claims
-- user1 with a biz claim for Test Cafe sees their own (draft) business row.
select set_config('request.jwt.claims',
  jsonb_build_object(
    'sub',  '11111111-1111-4111-8111-111111111111',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'biz', jsonb_build_object(
        (select id::text from public.businesses where name = 'Test Cafe'), 'owner')))::text,
  true);
set local role authenticated;

-- 10. staff-claimed user sees own business row even while draft
select is(
  (select count(*)::int from public.businesses where name = 'Test Cafe'),
  1,
  'staff-claimed user sees own draft business (P1 staff select)');

reset role;

-- user2 with a biz claim only for Other Bar reads Test Cafe tenant data: zero.
select set_config('request.jwt.claims',
  jsonb_build_object(
    'sub',  '22222222-2222-4222-8222-222222222222',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object(
      'biz', jsonb_build_object(
        (select id::text from public.businesses where name = 'Other Bar'), 'owner')))::text,
  true);
set local role authenticated;

-- 11. cross-tenant staff read returns zero rows
select is(
  (select count(*)::int from public.business_staff bs
    where bs.business_id = (select b.id from public.businesses b where b.name = 'Test Cafe')),
  0,
  'cross-tenant staff read of business_staff returns zero (P1 isolation)');

reset role;

-- ---------------------------------------------------------------- one-owner invariant
-- 12. the partial unique index rejects a second active owner
select throws_ok(
  $$insert into public.business_staff (business_id, user_id, role, status)
    select b.id, '22222222-2222-4222-8222-222222222222', 'owner', 'active'
      from public.businesses b where b.name = 'Test Cafe'$$,
  '23505',
  null,
  'business_staff_one_owner rejects a second active owner');

select * from finish();

rollback;
