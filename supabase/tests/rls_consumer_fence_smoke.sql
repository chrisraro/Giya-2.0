-- ============================================================================
-- rls_consumer_fence_smoke.sql (pgTAP)
-- Smoke tests for the 0021 self-update column fence on public.consumers and
-- public.profiles: a consumer may still edit the columns the app actually
-- writes, and may NOT touch the fraud/trust/derived columns. The headline
-- assertion is that a consumer cannot clear their own
-- consumers.scan_blocked_until (doc 37 consequences ladder step 2) or their
-- own profiles.is_suspended (ladder step 4).
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0021 applied. pgTAP
-- lives in the extensions schema.
--
-- Fixture strategy, per the hard rule in rls_receipts_smoke.sql: EVERY fixture
-- id is captured off its own "insert ... returning" clause. Nothing is ever
-- looked up by name or by any other global predicate over a whole table. This
-- database also holds live E2E data, and a live row sharing a fixture's name
-- would silently be picked up instead of the fixture's own row. Every
-- assertion below is scoped by a captured fixture id.
--
-- The two grant-set assertions at the end read information_schema rather than
-- a data table on purpose: they assert the shape of the fence itself, and they
-- aggregate into a sorted string so a failure names the exact column that
-- leaked instead of just reporting false.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(22);

-- ---------------------------------------------------------------- fixtures
-- One consumer. The on_auth_user_created trigger (0003) creates the matching
-- public.profiles and public.consumers rows.
with u as (
  insert into auth.users (id, aud, role, email, raw_user_meta_data)
  values (gen_random_uuid(), 'authenticated', 'authenticated',
          'giya-fence-consumer-' || gen_random_uuid()::text || '@example.com',
          '{"full_name": "Fence Test Consumer"}'::jsonb)
  returning id
)
select set_config('test.consumer', u.id::text, true) from u;

-- A fixture city, so the city_id positive test never has to name a seeded row.
with c as (
  insert into public.ref_cities (name, province, region, slug)
  values ('Fence Test City', 'Fence Province', 'Fence Region',
          'fence-test-city-' || replace(gen_random_uuid()::text, '-', ''))
  returning id
)
select set_config('test.city', c.id::text, true) from c;

-- Put the consumer under an active cooldown and an active suspension, written
-- as the privileged role (which stands in for the service-role fraud pipeline,
-- the only legitimate writer of these columns).
update public.consumers
   set scan_blocked_until = now() + interval '24 hours'
 where id = current_setting('test.consumer')::uuid;

update public.profiles
   set is_suspended = true, suspended_reason = 'fraud ladder step 4'
 where id = current_setting('test.consumer')::uuid;

-- ------------------------------------------------------- act as the consumer
select set_config('request.jwt.claims',
  jsonb_build_object(
    'sub',  current_setting('test.consumer'),
    'role', 'authenticated')::text,
  true);
set local role authenticated;

-- ============================================================ legitimate edits
-- 1. the onboarding write (src/features/identity/actions.ts) still lands
select lives_ok(
  $$update public.consumers
       set city_id = current_setting('test.city')::uuid, push_enabled = false
     where id = current_setting('test.consumer')::uuid$$,
  'consumer can still write consumers.city_id and push_enabled (onboarding)');

-- 2. and it actually took effect
select is(
  (select push_enabled from public.consumers
    where id = current_setting('test.consumer')::uuid),
  false,
  'the consumers onboarding write is visible afterwards');

-- 3. the consent / notification preference toggles
select lives_ok(
  $$update public.consumers
       set marketing_opt_in = true, email_enabled = false, gps_fraud_opt_in = true
     where id = current_setting('test.consumer')::uuid$$,
  'consumer can still write their own consent and notification preferences');

-- 4. the onboarding stamp on profiles
select lives_ok(
  $$update public.profiles
       set onboarded_at = now()
     where id = current_setting('test.consumer')::uuid$$,
  'consumer can still stamp profiles.onboarded_at (onboarding)');

-- 5. the profile edit surface
select lives_ok(
  $$update public.profiles
       set display_name = 'Renamed Consumer', avatar_url = 'https://example.test/a.png',
           phone = '+639171234567', locale = 'fil-PH'
     where id = current_setting('test.consumer')::uuid$$,
  'consumer can still edit display_name, avatar_url, phone and locale');

-- 6. and that took effect too
select is(
  (select display_name from public.profiles
    where id = current_setting('test.consumer')::uuid),
  'Renamed Consumer',
  'the profile edit is visible afterwards');

-- ======================================================= consumers: fenced off
-- 7. THE DEFECT: clearing your own fraud cooldown is now a privilege error
select throws_ok(
  $$update public.consumers
       set scan_blocked_until = null
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT clear their own consumers.scan_blocked_until (doc 37 step 2)');

-- 8. and cannot forge the velocity history the same ladder reads
select throws_ok(
  $$update public.consumers
       set last_scan_at = now() - interval '30 days'
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT write consumers.last_scan_at');

-- 9. the derived points total stays derived
select throws_ok(
  $$update public.consumers
       set lifetime_points_earned = 999999
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT write consumers.lifetime_points_earned');

-- 10. the referral identity token is not self-issued
select throws_ok(
  $$update public.consumers
       set referral_code = 'AAAAAAAA'
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT write consumers.referral_code');

-- 11. nor is referral attribution
select throws_ok(
  $$update public.consumers
       set referred_by = current_setting('test.consumer')::uuid
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT write consumers.referred_by');

-- 12. the cooldown survived every attempt above
select ok(
  (select scan_blocked_until > now() from public.consumers
    where id = current_setting('test.consumer')::uuid),
  'the fraud cooldown is still in the future after the attempts to clear it');

-- ======================================================== profiles: fenced off
-- 13. doc 37 ladder step 4: self-unsuspension is a privilege error
select throws_ok(
  $$update public.profiles
       set is_suspended = false
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT clear their own profiles.is_suspended (doc 37 step 4)');

-- 14. nor rewrite the reason attached to it
select throws_ok(
  $$update public.profiles
       set suspended_reason = null
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT write profiles.suspended_reason');

-- 15/16. A21.1's birthday pair is fenced together: the value and the column
-- that enforces once-per-rolling-year editing.
select throws_ok(
  $$update public.profiles
       set birth_date = date '1990-01-01'
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT write profiles.birth_date (A21.1 pair)');

select throws_ok(
  $$update public.profiles
       set birth_date_updated_at = null
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT reset profiles.birth_date_updated_at (A21.1 pair)');

-- 17. soft delete is not a PATCH
select throws_ok(
  $$update public.profiles
       set deleted_at = now()
     where id = current_setting('test.consumer')::uuid$$,
  '42501',
  null,
  'consumer CANNOT write profiles.deleted_at');

-- 18. the suspension survived every attempt above
select is(
  (select is_suspended from public.profiles
    where id = current_setting('test.consumer')::uuid),
  true,
  'the suspension is still set after the attempts to clear it');

reset role;

-- ==================================================== the fence shape itself
-- 19. consumers: authenticated holds UPDATE on exactly the allowlist
select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'consumers'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'),
  'city_id,email_enabled,gps_fraud_opt_in,marketing_opt_in,push_enabled,updated_by',
  'authenticated holds UPDATE on exactly the 0021 consumers allowlist');

-- 20. profiles: same
select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'profiles'
      and grantee = 'authenticated' and privilege_type = 'UPDATE'),
  'avatar_url,display_name,locale,onboarded_at,phone,updated_by',
  'authenticated holds UPDATE on exactly the 0021 profiles allowlist');

-- 21/22. anon was never supposed to write either table and now cannot at all
select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'consumers'
      and grantee = 'anon' and privilege_type = 'UPDATE'),
  null,
  'anon holds no UPDATE privilege on any consumers column');

select is(
  (select string_agg(column_name, ',' order by column_name)
     from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'profiles'
      and grantee = 'anon' and privilege_type = 'UPDATE'),
  null,
  'anon holds no UPDATE privilege on any profiles column');

select * from finish();

rollback;
