-- ============================================================================
-- rls_feature_flags_smoke.sql (pgTAP)
-- Smoke tests for 0062 feature_flags: the service-role-only fence (no
-- policies at all, privileges revoked underneath so the denial is loud), the
-- service_role privilege split (select/insert/update stay, delete/truncate
-- do not), the no-truncate statement trigger, the `key` and `description`
-- shape checks, the touch_updated_at trigger, and the three-row seed doc 38
-- section 1 requires.
--
-- Runs entirely inside one transaction and rolls back. Execute as a
-- privileged role (postgres) against a database with migrations 0001-0062
-- applied. pgTAP lives in the extensions schema.
--
-- HARD RULE, carried over from the jobs/audit_logs suites: every fixture row
-- is addressed by ITS OWN key, never by a bare count over the table - this
-- database also holds the seeded rows from 0062 itself plus any live data,
-- and a bare `count(*)` would be meaningless. Every assertion below either
-- names a fixture key directly, never a bare count over the whole table,
-- so nothing here can pass or fail because of a row this test did not create.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(24);

-- ---------------------------------------------------------------- fixture
-- One flag row this suite owns, separate from the 0062 seed so nothing here
-- depends on the seed's own values.
insert into public.feature_flags (key, description, is_enabled, rollout)
values ('test_smoke_flag', 'pgTAP fixture flag, not a real switch.', false, '{}'::jsonb);

-- ---------------------------------------------------------------- the fence
-- 0062's whole argument, same shape as 0029's for `jobs`: a client asking
-- about the kill-switch registry gets an ERROR, not an empty set.

set local role authenticated;

-- 1.
select throws_ok(
  $$select key from public.feature_flags$$,
  '42501',
  null,
  'authenticated cannot select feature_flags at all (table grant revoked)');

-- 2. Flipping a kill switch from the client role would be an unaudited,
--    unattributed toggle of the exact control this table exists to gate.
select throws_ok(
  $$update public.feature_flags set is_enabled = true where key = 'test_smoke_flag'$$,
  '42501',
  null,
  'authenticated cannot update a flag');

-- 3.
select throws_ok(
  $$insert into public.feature_flags (key, description) values ('test_forged', 'x')$$,
  '42501',
  null,
  'authenticated cannot insert a flag');

-- 4.
select throws_ok(
  $$delete from public.feature_flags where key = 'test_smoke_flag'$$,
  '42501',
  null,
  'authenticated cannot delete a flag');

reset role;

set local role anon;

-- 5. doc 12 requires the anon row of the matrix stated explicitly, never
--    inferred from "no policy".
select throws_ok(
  $$select key from public.feature_flags$$,
  '42501',
  null,
  'anon cannot select feature_flags');

-- 6.
select throws_ok(
  $$update public.feature_flags set is_enabled = true where key = 'test_smoke_flag'$$,
  '42501',
  null,
  'anon cannot update a flag');

reset role;

-- ---------------------------------------------------------------- privileges
-- RLS gates row DML only; it never sees TRUNCATE and never applies to
-- service_role, so the privilege layer is the only fence for both.

-- 7.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.feature_flags', p)),
  null::text,
  'anon holds no privilege at all on feature_flags');

-- 8.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.feature_flags', p)),
  null::text,
  'authenticated holds no privilege at all on feature_flags');

-- 9. The service_role split: the gateway read, the admin toggle, and a
--    future registry seed all stay; delete/truncate do not, matching
--    0029's own "never delete, only supersede" posture.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.feature_flags', p)),
  'INSERT,SELECT,UPDATE',
  'service_role keeps select, insert and update on feature_flags but not delete or truncate');

-- 10. RLS is on, so the absence of a policy reads as a decision.
select is(
  (select relrowsecurity from pg_class where oid = 'public.feature_flags'::regclass),
  true,
  'row level security is enabled on feature_flags');

-- 11. and there genuinely are none.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'feature_flags'),
  0,
  'feature_flags has no RLS policies at all (service-role zone)');

-- 12. The statement trigger, run as the privileged role on purpose: the
--     revoke above already stops every role that exists today, so this
--     catches the future misgrant.
select throws_ok(
  $$truncate public.feature_flags$$,
  'P0001',
  null,
  'feature_flags cannot be truncated (statement-level trigger)');

-- ---------------------------------------------------------------- service_role live
set local role service_role;

-- 13. the writer can toggle a flag - this IS the admin action's write.
select lives_ok(
  $$update public.feature_flags set is_enabled = true where key = 'test_smoke_flag'$$,
  'service_role toggles a flag (it is the writer)');

-- 14. the touch trigger is attached to fire on every update. NOT tested by
--     comparing updated_at > created_at: this whole script runs inside one
--     transaction, and `now()` (what `private.touch_updated_at()` stamps
--     with) is the TRANSACTION timestamp - constant for the life of this
--     script - so created_at and updated_at would read equal regardless of
--     whether the trigger fired at all. A catalog check is the honest
--     assertion here; a timing comparison would pass for the wrong reason.
select ok(
  (select count(*) from pg_trigger
    where tgrelid = 'public.feature_flags'::regclass
      and tgname = 'touch_feature_flags') = 1,
  'touch_feature_flags is attached to feature_flags');

-- 15. cannot delete
select throws_ok(
  $$delete from public.feature_flags where key = 'test_smoke_flag'$$,
  '42501',
  null,
  'service_role cannot delete a flag (delete revoked)');

-- 16. cannot truncate
select throws_ok(
  $$truncate public.feature_flags$$,
  '42501',
  null,
  'service_role cannot truncate feature_flags (truncate revoked)');

reset role;

-- ---------------------------------------------------------------- constraints

-- 17. `key` is the primary key AND shape-checked: it becomes a code-level
--     identifier (`src/lib/flags.ts` constants), never a display string.
select throws_ok(
  $$insert into public.feature_flags (key, description) values ('Not-Snake-Case', 'x')$$,
  '23514',
  null,
  'an uppercase/hyphenated key is rejected (shape check)');

-- 18. a blank description records nothing an admin screen could show.
select throws_ok(
  $$insert into public.feature_flags (key, description) values ('test_blank_desc', '   ')$$,
  '23514',
  null,
  'a whitespace-only description is rejected');

-- 19. `is_enabled` defaults false for a bare insert (the universal safe
--     default this table's own header argues for new, unreviewed flags).
select lives_ok(
  $$insert into public.feature_flags (key, description) values ('test_default_off', 'defaults check')$$,
  'a flag inserted with no is_enabled value is accepted');

-- 20.
select is(
  (select is_enabled from public.feature_flags where key = 'test_default_off'),
  false,
  'a flag with no is_enabled value defaults to false (fail-closed default)');

-- 21. `rollout` defaults to an empty jsonb object, never null - a null
--     rollout would make every future evaluator branch on an extra case.
select is(
  (select rollout from public.feature_flags where key = 'test_default_off'),
  '{}'::jsonb,
  'rollout defaults to an empty jsonb object');

-- ---------------------------------------------------------------- the seed
-- Doc 38 section 1's three AI kill-switch keys, seeded enabled (see the
-- migration header for why "seeded on" and "fails closed on read failure"
-- are different questions).

-- 22.
select is(
  (select is_enabled from public.feature_flags where key = 'ai_parse_assist'),
  true,
  'ai_parse_assist is seeded enabled');

-- 23.
select is(
  (select is_enabled from public.feature_flags where key = 'ai_assistant'),
  true,
  'ai_assistant is seeded enabled');

-- 24.
select is(
  (select is_enabled from public.feature_flags where key = 'ai_analytics'),
  true,
  'ai_analytics is seeded enabled');

select * from finish();

rollback;
