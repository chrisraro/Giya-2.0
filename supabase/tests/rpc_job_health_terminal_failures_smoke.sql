-- ============================================================================
-- rpc_job_health_terminal_failures_smoke.sql (pgTAP)
-- Smoke tests for 0061 public.sweep_job_terminal_failures: the regression
-- test for the exact bug the migration closes (an in-flight pg_cron run
-- must never be counted as a failure, unlike 0028's own `sweep_job_health.
-- failures`, whose `<> 'succeeded'` filter counts it), the correctness of
-- the terminal-only aggregate, and the full grant matrix.
--
-- Runs entirely inside one transaction and rolls back, INCLUDING its
-- `cron.job` / `cron.job_run_details` fixture rows - real pg_cron schedules
-- live outside any transaction (see rpc_sweeps_smoke.sql's own note), but
-- nothing here needs a real schedule: this function only ever READS those
-- two tables, so creating a synthetic job and its run history inside the
-- transaction and rolling back is sufficient and leaves no trace on the
-- live scheduler.
--
-- `cron.job` itself is owned by `supabase_admin` and even `postgres` has no
-- direct INSERT on it (verified live), so the fixture goes through
-- `cron.schedule()` - the same API 0028's own sweeps use - rather than a raw
-- INSERT. `cron.job_run_details` IS directly insertable by `postgres`, but
-- its `runid` sequence is not (`cron.runid_seq` grants nothing to
-- `postgres`), so fixture rows supply an explicit, clearly-out-of-range
-- negative `runid` rather than relying on the column default.
--
-- Fixture jobnames are `test.*` and never looked up by anything else in
-- this file besides their own captured jobid, per this project's standing
-- rule: a bare jobname match would risk colliding with a real scheduled
-- job's row on this shared, live project.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(12);

-- ---------------------------------------------------------------- fixtures
-- Fixture 1: a job whose ONLY run in the window is a currently-executing
-- one. This is the exact shape the review's probe found paging under the
-- first cut: no genuine failure exists, but a naive `status <> 'succeeded'`
-- read (0028's own `failures`) would still count it as one.
--
-- Fixture 2: a job with one succeeded run, two genuinely failed runs (30
-- minutes apart, so a narrow window can distinguish them - test 7 below),
-- and one in-flight run mixed in. Proves both halves of the fix at once:
-- the in-flight row is excluded from every count, and of the two real
-- failures the MOST RECENT one's message wins (mirroring 0028's own "most
-- recent FAILING message" choice for `last_error`).
do $$
declare
  v_inflight_jobid bigint;
  v_mixed_jobid    bigint;
begin
  v_inflight_jobid := cron.schedule('test.smoke_inflight_only', '*/5 * * * *', 'select 1;');
  insert into cron.job_run_details (runid, jobid, status, start_time)
  values (-900000001, v_inflight_jobid, 'running', now());

  v_mixed_jobid := cron.schedule('test.smoke_mixed_terminal', '7 * * * *', 'select 1;');
  insert into cron.job_run_details (runid, jobid, status, start_time, return_message)
  values
    (-900000002, v_mixed_jobid, 'succeeded', now() - interval '3 hours',    'ok'),
    (-900000003, v_mixed_jobid, 'failed',    now() - interval '2 hours',    'ERROR: first failure'),
    (-900000004, v_mixed_jobid, 'failed',    now() - interval '30 minutes', 'ERROR: second failure (most recent)'),
    (-900000005, v_mixed_jobid, 'starting',  now(),                        null);
end
$$;

-- ---------------------------------------------------------------- correctness

-- 1. THE REGRESSION TEST. An in-flight-only job reports zero terminal
--    failures, not one - the bug this migration exists to fix.
select is(
  (select terminal_failures from public.sweep_job_terminal_failures(24)
    where jobname = 'test.smoke_inflight_only'),
  0::bigint,
  'a job whose only run is in-flight (running) reports zero terminal failures');

-- 2. And zero terminal RUNS too - the run has not reached a terminal state
--    at all, so it must not be counted as one that "happened".
select is(
  (select terminal_runs from public.sweep_job_terminal_failures(24)
    where jobname = 'test.smoke_inflight_only'),
  0::bigint,
  'a job whose only run is in-flight reports zero terminal runs');

-- 3. No terminal error to report either.
select is(
  (select last_terminal_error from public.sweep_job_terminal_failures(24)
    where jobname = 'test.smoke_inflight_only'),
  null::text,
  'a job whose only run is in-flight has no terminal error');

-- 4. The mixed job: 3 terminal runs (succeeded + 2 failed), NOT 4 - the
--    'starting' row is excluded.
select is(
  (select terminal_runs from public.sweep_job_terminal_failures(24)
    where jobname = 'test.smoke_mixed_terminal'),
  3::bigint,
  'terminal_runs counts only succeeded+failed, excluding the in-flight row');

-- 5. Exactly 2 genuine failures.
select is(
  (select terminal_failures from public.sweep_job_terminal_failures(24)
    where jobname = 'test.smoke_mixed_terminal'),
  2::bigint,
  'terminal_failures counts only status=failed');

-- 6. The MOST RECENT failure's message wins, not the first.
select is(
  (select last_terminal_error from public.sweep_job_terminal_failures(24)
    where jobname = 'test.smoke_mixed_terminal'),
  'ERROR: second failure (most recent)',
  'last_terminal_error is the most recent FAILED run''s message, not the oldest');

-- 7. THE WINDOW GENUINELY FILTERS. A 1-hour window sees only the failure 30
--    minutes ago, not the ones 2h and 3h back - proving p_hours actually
--    bounds the read rather than the function silently reading everything.
select is(
  (select terminal_runs from public.sweep_job_terminal_failures(1)
    where jobname = 'test.smoke_mixed_terminal'),
  1::bigint,
  'a 1-hour window sees only the 30-minutes-ago failed row, not the ones 2h/3h back');

-- ---------------------------------------------------------------- grants

set local role authenticated;

-- 8.
select throws_ok(
  $$select * from public.sweep_job_terminal_failures(24)$$,
  '42501',
  null,
  'authenticated cannot call sweep_job_terminal_failures');

reset role;

set local role anon;

-- 9.
select throws_ok(
  $$select * from public.sweep_job_terminal_failures(24)$$,
  '42501',
  null,
  'anon cannot call sweep_job_terminal_failures');

reset role;

-- 10-12. The I-A grant matrix, literal per-role (this project's
--        check-grants.sh gate requires each role pinned by its own literal
--        has_function_privilege call, not an aggregate - see
--        supabase/tests/rpc_award_smoke.sql's identical shape).
select ok(
  not has_function_privilege('anon',
    'public.sweep_job_terminal_failures(integer)', 'EXECUTE'),
  'anon cannot execute sweep_job_terminal_failures');

select ok(
  not has_function_privilege('authenticated',
    'public.sweep_job_terminal_failures(integer)', 'EXECUTE'),
  'authenticated cannot execute sweep_job_terminal_failures');

select ok(
  has_function_privilege('service_role',
    'public.sweep_job_terminal_failures(integer)', 'EXECUTE'),
  'service_role can execute sweep_job_terminal_failures');

select * from finish();

rollback;
