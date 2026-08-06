-- ============================================================================
-- 0061_job_health_terminal_failures.sql
-- public.sweep_job_terminal_failures: the read task 2.5's flapping detector
-- actually needs, which public.sweep_job_health (0028) cannot honestly give
-- it, and never edits 0028 to try.
--
-- ---------------------------------------------------------------------------
-- THE BUG THIS CLOSES (review finding C2(i), second pass)
-- ---------------------------------------------------------------------------
-- 0028's `sweep_job_health.failures` is, verbatim from its own body:
--
--   count(d.runid) filter (where d.status <> 'succeeded') as failures
--
-- `cron.job_run_details.status` is not binary. Between a job starting and
-- finishing it is 'starting', then 'running', then 'sending', and only THEN
-- 'succeeded' or 'failed' - pg_cron's own source. Every one of those
-- in-flight values satisfies `<> 'succeeded'`, so `failures` counts a run
-- that simply has not finished yet as a failure. That column is exactly
-- right for 0028's own purpose (an operator dashboard showing "how much
-- non-success happened in the window", where an in-flight run is a
-- legitimate thing to show), and exactly wrong for task 2.5's: a job whose
-- ONLY non-succeeded run this check happens to observe is the one currently
-- executing would page "1 of N runs failed" - a false, specific claim an
-- operator will search `cron.job_run_details` for and never find, for a job
-- that is not broken at all. `campaigns.sweep` runs every five minutes, so a
-- check landing mid-run is routine, not rare.
--
-- The first review-fix pass tried to solve this with a TypeScript predicate
-- reading the same `failures` column from a narrower window. That cannot
-- work: `failures` as 0028 defines it has already thrown away the
-- distinction between "in flight" and "genuinely failed" before it ever
-- reaches application code. No predicate downstream of the aggregate can
-- recover information the aggregate discarded. The fix has to be a
-- different aggregate - hence this function, not another `if`.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW FUNCTION, NOT AN EDIT TO 0028
-- ---------------------------------------------------------------------------
-- supabase/README.md's 0011b note and the 0042/0057 incident: an applied
-- migration is never edited in place, because a file that no longer matches
-- what actually ran is a worse defect than the one it was trying to fix.
-- `sweep_job_health` also has a live caller today
-- (src/lib/observability/metrics.ts) that this task does not own and whose
-- contract (0028's own header: "`failures` ... an alert would key on") this
-- migration deliberately does not change - metrics.ts's dashboard use of
-- "how much non-success happened" is correct for a dashboard. The fix is
-- therefore additive: a second, narrower function for the one caller that
-- needs the narrower, terminal-only definition.
--
-- ---------------------------------------------------------------------------
-- REAL-WORLD CONFIRMATION THIS GAP IS NOT HYPOTHETICAL
-- ---------------------------------------------------------------------------
-- Live on this project as of 2026-08-06: `cron.job_run_details` holds two
-- genuine failures nobody has ever seen -
-- `sweep_stuck_receipts` raising `ERROR: LIMIT must not be negative` on
-- 2026-07-25 - and they belong to a jobid `cron.job` no longer has a row
-- for, so they are orphaned run history: proof of the alerting gap task 2.5
-- exists to close, AND a live instance of the I5 "job disappeared" case in
-- one artifact. `sweep_job_terminal_failures` reads `cron.job_run_details`
-- the same way 0028 does (LEFT JOIN from `cron.job`, so an orphaned jobid
-- with no current `cron.job` row is invisible to THIS function too - by
-- design, the same as 0028: a function keyed off `cron.job` can only ever
-- report on jobs `cron.job` currently has a row for). Catching an orphaned
-- run's history specifically is not this function's job; it is
-- EXPECTED_JOBS's (src/lib/alerts/job-health.ts), which compares the live
-- `cron.job` set against what this codebase expects to exist.
--
-- ---------------------------------------------------------------------------
-- SHAPE: DELIBERATELY NARROWER THAN 0028'S, NOT A SUPERSET
-- ---------------------------------------------------------------------------
-- No `schedule`, `active`, `last_status` or `last_finished_at` - task 2.5's
-- checker already has those from its own `sweep_job_health` call (the wide
-- window) and duplicating them here would be two sources of truth for the
-- same facts. This function answers exactly one question: among TERMINAL
-- runs only (status in 'succeeded','failed' - i.e. NOT 'starting', 'running'
-- or 'sending'), how many happened and how many failed, in the window.
-- `terminal_runs` (not `runs`) is deliberately renamed from 0028's `runs` to
-- make the exclusion visible at the call site rather than implied.
create or replace function public.sweep_job_terminal_failures(p_hours integer default 24)
returns table (
  jobname             text,
  terminal_runs       bigint,
  terminal_failures   bigint,
  last_terminal_error text
)
language sql
stable
security definer
set search_path = ''
as $$
  select j.jobname::text,
         count(d.runid) filter (where d.status in ('succeeded', 'failed'))  as terminal_runs,
         count(d.runid) filter (where d.status = 'failed')                  as terminal_failures,
         -- Most recent TERMINAL failure's message, mirroring 0028's own
         -- "most recent FAILING message, not most recent message" choice
         -- (its header: "a failure followed by a successful run must still
         -- be readable"). Here it additionally means an in-flight run can
         -- never mask an earlier real failure's text, which 0028's own
         -- `last_error` is not immune to (its filter is `<> 'succeeded'`,
         -- the same in-flight contamination this whole migration exists to
         -- avoid) - not fixed here, because 0028 is not edited in place.
         (array_agg(d.return_message order by d.start_time desc)
            filter (where d.status = 'failed'))[1]::text                    as last_terminal_error
    from cron.job j
    left join cron.job_run_details d
      on d.jobid = j.jobid
     and d.start_time >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1))
   group by j.jobname
   order by j.jobname;
$$;

-- Same audience as 0028's sweep_job_health: service_role only, for the same
-- reason (0028's header: `cron.job_run_details` carries operational text and
-- a readable schedule is a readable "when do the fraud sweeps run").
revoke execute on function public.sweep_job_terminal_failures(integer) from public, anon, authenticated;
grant execute on function public.sweep_job_terminal_failures(integer) to service_role;
