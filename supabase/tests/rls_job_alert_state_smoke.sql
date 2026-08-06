-- ============================================================================
-- rls_job_alert_state_smoke.sql (pgTAP)
-- Smoke tests for 0058 job_alert_state: the service-role-only fence (no
-- policies at all, privileges revoked underneath), the service_role privilege
-- split (DELETE stays, TRUNCATE does not - the opposite split from `jobs`,
-- because this checker's own recovery path IS a per-row delete), the
-- no-truncate statement trigger, and the one shape check on `jobname`.
--
-- Runs entirely inside one transaction and rolls back. Execute as a
-- privileged role (postgres) against a database with migrations 0001-0058
-- applied. pgTAP lives in the extensions schema.
--
-- No auth.users, no profiles, no tenant fixtures needed: `job_alert_state`
-- has no foreign keys at all (jobname is cron's own job name, not an FK), same
-- as `jobs` (0029).
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(13);

-- ---------------------------------------------------------------- fixture
insert into public.job_alert_state (jobname, since, last_alerted_at, last_detail)
values ('test.smoke_job', now() - interval '2 hours', now() - interval '2 hours',
        'ERROR: something broke');

-- ---------------------------------------------------------------- the fence

set local role authenticated;

-- 1.
select throws_ok(
  $$select jobname from public.job_alert_state$$,
  '42501',
  null,
  'authenticated cannot select job_alert_state at all (table grant revoked)');

-- 2.
select throws_ok(
  $$insert into public.job_alert_state (jobname, since, last_alerted_at)
    values ('test.forged', now(), now())$$,
  '42501',
  null,
  'authenticated cannot insert a job_alert_state row');

-- 3.
select throws_ok(
  $$update public.job_alert_state set last_detail = 'tampered'
     where jobname = 'test.smoke_job'$$,
  '42501',
  null,
  'authenticated cannot update a job_alert_state row');

-- 4.
select throws_ok(
  $$delete from public.job_alert_state where jobname = 'test.smoke_job'$$,
  '42501',
  null,
  'authenticated cannot delete a job_alert_state row');

reset role;

set local role anon;

-- 5.
select throws_ok(
  $$select jobname from public.job_alert_state$$,
  '42501',
  null,
  'anon cannot select job_alert_state');

-- 6.
select throws_ok(
  $$insert into public.job_alert_state (jobname, since, last_alerted_at)
    values ('test.forged', now(), now())$$,
  '42501',
  null,
  'anon cannot insert a job_alert_state row');

reset role;

-- ---------------------------------------------------------------- privileges

-- 7.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.job_alert_state', p)),
  null::text,
  'anon holds no privilege at all on job_alert_state');

-- 8.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.job_alert_state', p)),
  null::text,
  'authenticated holds no privilege at all on job_alert_state');

-- 9. The service_role split: the whole checker lifecycle stays (read current
--    state, open an incident, refresh a reminder, delete on recovery).
--    TRUNCATE does not - no legitimate operation empties this table in one
--    statement, and recovery is always a per-row delete.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.job_alert_state', p)),
  'DELETE,INSERT,SELECT,UPDATE',
  'service_role keeps select, insert, update and delete on job_alert_state but not truncate');

-- 10. RLS is on. With zero policies that is a deny-all, and it is enabled so
--     the absence of a policy reads as a decision rather than an oversight.
select is(
  (select relrowsecurity from pg_class
    where oid = 'public.job_alert_state'::regclass),
  true,
  'row level security is enabled on job_alert_state');

-- 11. and there genuinely are none.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'job_alert_state'),
  0,
  'job_alert_state has no RLS policies at all (service-role zone)');

-- 12. The statement trigger, which is the layer that survives the revoke
--     being undone.
select throws_ok(
  $$truncate public.job_alert_state$$,
  'P0001',
  null,
  'job_alert_state cannot be truncated (statement-level trigger)');

-- 13. The one shape check: a blank jobname is refused.
select throws_ok(
  $$insert into public.job_alert_state (jobname, since, last_alerted_at)
    values ('   ', now(), now())$$,
  '23514',
  null,
  'a blank jobname is rejected');

select * from finish();

rollback;
