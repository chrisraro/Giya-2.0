-- ============================================================================
-- rpc_find_auth_user_by_email_smoke.sql (pgTAP)
-- Smoke tests for 0063 public.find_auth_user_by_email: exact match, case-
-- insensitive match on both sides, trimmed input, no-match returns nothing,
-- the narrow (id, email)-only return shape, and the full grant matrix
-- (anon/authenticated denied, service_role allowed).
--
-- Runs entirely inside one transaction and rolls back, including its
-- `auth.users` fixture rows - same fixture technique as
-- rpc_award_smoke.sql's own note ("Insert directly into auth.users - the
-- on_auth_user_created trigger creates profiles + consumers"). Fixture
-- emails are `test.find-auth-user.*@example.com` and never looked up by
-- anything besides their own literal in this file, per this project's
-- standing rule against colliding with a real row on this shared, live
-- project.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(11);

-- ---------------------------------------------------------------- fixtures
-- Stored lowercase (`smoke.lower@...`, matching GoTrue's own normalization
-- for new signups) and stored MIXED CASE (`Smoke.Mixed@...`, standing in for
-- a historical row predating that normalization, or written by a path that
-- never normalized) - so the case-insensitive comparison is proven from
-- BOTH directions, not just "input happens to already match storage".
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('a1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'smoke.lower@example.com', '{"full_name": "Lowercase Fixture"}'::jsonb),
  ('a2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'Smoke.Mixed@Example.com', '{"full_name": "Mixed Case Fixture"}'::jsonb);

-- ---------------------------------------------------------------- correctness

-- 1. Exact match.
select is(
  (select id from public.find_auth_user_by_email('smoke.lower@example.com')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'resolves the fixture by its exact stored email');

-- 2. Case-insensitive on the INPUT side: uppercase input still finds the
--    lowercase-stored row.
select is(
  (select id from public.find_auth_user_by_email('SMOKE.LOWER@EXAMPLE.COM')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'an uppercase INPUT still resolves a lowercase-stored row');

-- 3. Case-insensitive on the STORED side: a lowercase, normally-formed
--    input still finds a mixed-case-stored row. Worth pinning explicitly
--    because a naive `lower(p_email) = u.email` (normalizing only the
--    input) would pass test 2 above but fail this one - the migration's own
--    `where lower(u.email) = lower(btrim(p_email))` normalizes both sides.
select is(
  (select id from public.find_auth_user_by_email('smoke.mixed@example.com')),
  'a2222222-2222-4222-8222-222222222222'::uuid,
  'a lowercase input still resolves a MIXED-CASE-stored row');

-- 4. Untrimmed input (leading/trailing whitespace) still resolves.
select is(
  (select id from public.find_auth_user_by_email('  smoke.lower@example.com  ')),
  'a1111111-1111-4111-8111-111111111111'::uuid,
  'leading/trailing whitespace in the input does not prevent a match');

-- 5. No match: genuinely empty, not an error and not some other row.
select is(
  (select count(*) from public.find_auth_user_by_email('nobody-has-this-address@example.com')),
  0::bigint,
  'an email with no auth.users row returns zero rows, not an error');

-- 6. The narrow return shape (review R4): exactly `id` and `email`, nothing
--    else off `auth.users` - proven structurally off the actual returned
--    row's own columns, not merely asserted in a comment.
select results_eq(
  $$select jsonb_object_keys(to_jsonb(t))::text
      from public.find_auth_user_by_email('smoke.lower@example.com') t
     order by 1$$,
  $$values ('email'), ('id')$$,
  'the returned row has exactly the columns id and email, nothing else off auth.users');

-- ---------------------------------------------------------------- grants

set local role authenticated;

-- 7.
select throws_ok(
  $$select * from public.find_auth_user_by_email('smoke.lower@example.com')$$,
  '42501',
  null,
  'authenticated cannot call find_auth_user_by_email');

reset role;

set local role anon;

-- 8.
select throws_ok(
  $$select * from public.find_auth_user_by_email('smoke.lower@example.com')$$,
  '42501',
  null,
  'anon cannot call find_auth_user_by_email');

reset role;

-- 9-11. The I-A grant matrix, literal per-role (this project's
--       check-grants.sh gate requires each role pinned by its own literal
--       has_function_privilege call - see rpc_award_smoke.sql's identical
--       shape).
select ok(
  not has_function_privilege('anon',
    'public.find_auth_user_by_email(text)', 'EXECUTE'),
  'anon cannot execute find_auth_user_by_email');

select ok(
  not has_function_privilege('authenticated',
    'public.find_auth_user_by_email(text)', 'EXECUTE'),
  'authenticated cannot execute find_auth_user_by_email');

select ok(
  has_function_privilege('service_role',
    'public.find_auth_user_by_email(text)', 'EXECUTE'),
  'service_role can execute find_auth_user_by_email');

select * from finish();

rollback;
