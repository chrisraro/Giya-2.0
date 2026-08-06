-- ============================================================================
-- 0059_balance_check_trigger_privilege_fix.sql
-- Task 2.2, third review-fix pass. Never edit 0058 in place.
--
-- ---------------------------------------------------------------------------
-- C2 (Critical) - the I7 fix traded a rare lock for an unconditional error
-- on the money path
-- ---------------------------------------------------------------------------
-- 0058's `private.balance_check_findings_pair_cleanup()` was plain plpgsql
-- (no `security definer`), so its `delete from public.balance_check_
-- findings` ran with the INVOKER's privileges - and 0056 revokes DELETE on
-- that table from `service_role`, the role every internal application code
-- path actually runs as. Reproduced live, in a rolled-back transaction:
--
--   set local role service_role;
--   delete from public.business_customers where ...;
--   -> ERROR: permission denied for table balance_check_findings
--      CONTEXT: PL/pgSQL function private.balance_check_findings_pair_
--      cleanup() line 3 at SQL statement
--
-- The privilege check is against the RELATION, not per matching row, so it
-- fired unconditionally - `service_role` could not delete ANY `business_
-- customers` row after 0058, including a pair that had never been checked
-- and had no finding at all. This is WORSE than the lock I7 removed: a rare
-- wait became an unconditional error, on the money-path table, for the role
-- that runs every writer this whole task exists to police. The FK version
-- 0058 replaced did not have this problem, because Postgres runs referential
-- actions in the CONSTRAINED table's owner context, not the invoker's.
--
-- Three things made this worse than the bug itself, all fixed here too:
--   1. `rpc_balance_check_smoke.sql` runs entirely as `postgres` (no `set
--      local role service_role` anywhere in the file), so the M2/I7 cascade
--      assertion exercised the one role the trigger actually worked for and
--      could not have caught this. A new assertion below runs the identical
--      delete under `set local role service_role` specifically.
--   2. 0058's own header (M10) described the ACCEPTED-RISK version of this
--      behaviour ("service-role code CAN erase a finding by deleting the
--      pair row") as if it were live, when the actual live behaviour was
--      that the delete errored out entirely - the header documented the
--      opposite of what the database was doing. Restored below to describe
--      what is actually true now that the fix lands: the erasure path
--      reopens, which remains the accepted position (nothing in this
--      codebase deletes a business_customers row today).
--   3. This repo already has a `security definer` trigger function for
--      exactly this reason - `private.handle_new_user()` (0003), which
--      writes RLS-protected tables from a trigger fired as `supabase_auth_
--      admin`. The same shape applies here and was simply missed.
--
-- FIX: add `security definer` to `private.balance_check_findings_pair_
-- cleanup()`, so its internal DELETE runs as the function's owner (the
-- migration-applying role, which holds full privileges on every table it
-- owns) regardless of which role's DELETE on `business_customers` fired the
-- trigger. Verified red-first: a rolled-back pgTAP run against the
-- ORIGINAL (non-`security definer`) trigger reproduced the exact error
-- above under `set local role service_role`, before the fix landed and the
-- same assertion turned green.
--
-- ---------------------------------------------------------------------------
-- I9 - the "defense" added in 0058 only catches the ONE incident that
-- already happened
-- ---------------------------------------------------------------------------
-- Checking the live body for the word "tier" and for calls to `coverage_
-- days`/`priority_count` by name catches a regression to an EARLIER body and
-- catches comment-stripping specifically - the two things that actually
-- happened. It does not catch anything else: any FUTURE body that happens to
-- be a superset of those three markers passes, so an unrelated deployment
-- gap on a task 2.3/2.4 migration that touches this function goes
-- undetected the same way 0057's did. Two incidents into this task, a
-- defense that only covers the one that already happened is not enough.
--
-- FIX: a monotonic marker the next migration touching this function is
-- FORCED to bump - `-- balance_check body revision: 0059` inside the body
-- itself, with an assertion in the suite pinning that EXACT number. Whoever
-- next recreates `public.balance_check` must either bump this comment (and
-- the test's expected value with it) or the suite fails on a body that is
-- otherwise indistinguishable from "correct" by content alone - the same
-- forcing-function shape a version number gives a public API, applied to a
-- function whose deployed bytes have now twice failed to match its file.
--
-- ---------------------------------------------------------------------------
-- I10 - "never a second implementation" was false as written
-- ---------------------------------------------------------------------------
-- 0058's header claimed the tier-0 predicate has one implementation because
-- `coverage_days`/`priority_count` are "the same primitive `balance_check`
-- calls" - true for coverage_days, false for the tier-0 CHECK itself:
-- `public.balance_check`'s own candidate ORDER BY carried its own inline
-- `case when exists (...)` (five conditions: business_id, consumer_id, type,
-- 24h window, not-yet-re-verified), and `private.balance_check_priority_
-- count` reimplemented the identical five conditions independently. They
-- agreed today and the difference in surrounding context (ORDER BY key vs.
-- EXISTS filter) was immaterial - but they were two copies, so a future
-- change to one and not the other would make the tier-0 WARNING report a
-- number the sort no longer actually uses, which is precisely the class of
-- divergence this whole task exists to make structurally impossible, not
-- merely coincidentally absent today.
--
-- FIX: `private.balance_check_is_priority(p_business_id, p_consumer_id,
-- p_checked_at)`, the ONE implementation of the five-condition predicate.
-- Both `public.balance_check`'s ORDER BY and `private.balance_check_
-- priority_count`'s scoring CTE now call it; neither restates the
-- conditions. Denied to every role including `service_role`, matching its
-- sibling private helpers.
--
-- ---------------------------------------------------------------------------
-- MINORS
-- ---------------------------------------------------------------------------
-- M15 - 0058's header claimed "no writer ever takes FOR UPDATE on
-- businesses" as the reason restoring the two single-column FKs was safe.
-- False as stated: `submit_business_for_review`, `activate_business` and
-- `reject_business_verification` (0033) all take a plain `for update` on
-- `businesses`. The CONCLUSION still holds - restoring those FKs is still
-- safe - but for a different, more precise reason: those three RPCs are
-- rare, once-per-business-lifecycle administrative transitions, not
-- continuous per-transaction money-path activity. `business_customers`, by
-- contrast, is locked `FOR UPDATE` by every single award/redeem/expire/
-- clawback - the kind of frequency that guarantees eventual overlap with a
-- rotating cursor that eventually visits every pair. A first-sighting
-- `FOR KEY SHARE` on `businesses(id)` can in principle collide with one of
-- 0033's three RPCs, but the collision window is one brief administrative
-- action against a whole business lifecycle, not a hot path - which is
-- exactly the distinction I7 was supposed to have gotten right the first
-- time. Corrected in the README (this migration does not touch those FKs
-- again; 0058's restoration of them was already correct, only its stated
-- reason was wrong).
--
-- M16 - `private.balance_check_coverage_days`'s scalar subquery against
-- `cron.job` had no `limit 1`. `cron.schedule` upserts on `(jobname,
-- username)`, so a genuine duplicate should not occur in normal operation -
-- but a scalar subquery that returns more than one row raises, and this
-- function is called from inside `public.balance_check`'s own run, so any
-- future manual intervention or bug that left two `points.expiry_sweep`
-- rows would take the ENTIRE nightly integrity check down with it, not just
-- degrade the tripwire's accuracy. `limit 1` added: the accounting degrades
-- to "pick one" in that scenario, which is honest given `cron.job` itself
-- has no ordering guarantee to prefer, rather than crashing the job whose
-- entire purpose is to keep running every night regardless of what else on
-- the platform is unhealthy.
--
-- M17 - `private.balance_check_findings_pair_cleanup` was left ungranted
-- (neither revoked nor granted) while its sibling private helpers in the
-- same file were explicitly revoked from every role including
-- `service_role`. A table trigger's invocation is never gated by `EXECUTE`
-- privilege on the trigger function for any role - Postgres calls it
-- directly as part of the table's own DML, the same way `private.handle_
-- new_user` (0003) or `private.audit_logs_append_only` (0022) need no
-- EXECUTE grant to fire - so revoking it costs nothing and matches every
-- other private helper's posture in this file.
-- ============================================================================

-- ---------------------------------------------------------------- C2: the trigger function, fixed
create or replace function private.balance_check_findings_pair_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.balance_check_findings
   where business_id = old.business_id
     and consumer_id = old.consumer_id;
  return old;
end
$$;

-- M17: matches its sibling private helpers below. Costs nothing - trigger
-- firing is never gated by EXECUTE on the trigger function for any role.
revoke execute on function private.balance_check_findings_pair_cleanup()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- I10: the one implementation
create function private.balance_check_is_priority(
  p_business_id uuid,
  p_consumer_id uuid,
  p_checked_at  timestamptz
) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.points_transactions pt
     where pt.business_id = p_business_id
       and pt.consumer_id = p_consumer_id
       and pt.type in ('clawback', 'expire')
       and pt.created_at >= now() - interval '24 hours'
       and pt.created_at > coalesce(p_checked_at, '-infinity'::timestamptz)
  );
$$;

revoke execute on function private.balance_check_is_priority(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- private.balance_check_priority_count (re-created, calls the shared primitive)
create or replace function private.balance_check_priority_count(p_limit integer)
returns integer
language sql
stable
set search_path = ''
as $$
  with scored as (
    select bc.business_id, bc.consumer_id, f.checked_at,
           private.balance_check_is_priority(bc.business_id, bc.consumer_id, f.checked_at) as is_priority
      from public.business_customers bc
      left join public.balance_check_findings f
        on f.business_id = bc.business_id
       and f.consumer_id = bc.consumer_id
  )
  select count(*)::integer
    from (
      select is_priority
        from scored
       order by (case when is_priority then 0 else 1 end),
                coalesce(checked_at, '-infinity'::timestamptz)
       limit greatest(coalesce(p_limit, 500), 0)
    ) top
   where is_priority;
$$;

revoke execute on function private.balance_check_priority_count(integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- M16: private.balance_check_coverage_days (limit 1 added)
create or replace function private.balance_check_coverage_days(p_limit integer)
returns integer
language sql
stable
set search_path = ''
as $$
  select ceil(
    (select count(*) from public.business_customers)::numeric
    / greatest(
        greatest(coalesce(p_limit, 500), 1)
        - coalesce((
            select (regexp_match(j.command, 'expire_points\((\d+)\)'))[1]::integer
              from cron.job j
             where j.jobname = 'points.expiry_sweep'
             limit 1
          ), 200),
        1)
  )::integer;
$$;

revoke execute on function private.balance_check_coverage_days(integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- public.balance_check (re-created: I10 shared primitive, I9 revision marker)
create or replace function public.balance_check(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- balance_check body revision: 0059
  v_limit         integer;
  v_processed     integer := 0;
  v_drifted       integer := 0;
  v_priority      integer;
  v_coverage_days integer;
begin
  -- M5: LIMIT NULL is unbounded in Postgres. Clamp once, here, so every
  -- `limit` below is safe by construction regardless of what the caller
  -- passes.
  v_limit := greatest(coalesce(p_limit, 500), 0);

  -- I6: the tier-0 occupancy metric, read BEFORE the candidate scan below
  -- runs - once that scan's upsert stamps checked_at for the pairs it
  -- selects, they immediately stop looking like tier-0 candidates to this
  -- same query, so reading it after would report the WRONG run's number. A
  -- small race window between this read and the statement below is
  -- accepted: this is a diagnostic signal, not the drift comparison, which
  -- is the one thing this function guarantees a single snapshot for.
  v_priority := private.balance_check_priority_count(v_limit);

  with candidates as (
    select bc.business_id, bc.consumer_id, bc.points_balance
      from public.business_customers bc
      left join public.balance_check_findings f
        on f.business_id = bc.business_id
       and f.consumer_id = bc.consumer_id
     order by
       -- Priority tier (I3b): doc 39's "every pair touched by clawback/
       -- expire in the last 24h" guarantee. Tier 0 (sorts before every other
       -- pair, including never-checked ones): private.balance_check_is_
       -- priority (I10 - the ONE implementation of this predicate, also
       -- used by private.balance_check_priority_count, never restated
       -- here). Self-clearing: once checked, checked_at moves past the
       -- triggering row's created_at and the pair falls back to tier 1 on
       -- the next run.
       (case when private.balance_check_is_priority(bc.business_id, bc.consumer_id, f.checked_at)
             then 0 else 1 end),
       -- Tier 1 (and the tie-break within tier 0): the original rotating
       -- cursor.
       coalesce(f.checked_at, '-infinity'::timestamptz),
       bc.business_id, bc.consumer_id
     limit v_limit
  ),
  -- ONE statement (this whole `with` chain, with no statement boundary
  -- anywhere inside it), one MVCC snapshot: see the 0056 migration header's
  -- "ZERO FALSE POSITIVES BY CONSTRUCTION" section for why that is what
  -- makes a concurrent writer's commit unable to appear on only one side of
  -- this comparison.
  computed as (
    select c.business_id, c.consumer_id, c.points_balance as cached_balance,
           coalesce((
             select sum(pt.points)
               from public.points_transactions pt
              where pt.business_id = c.business_id
                and pt.consumer_id = c.consumer_id
           ), 0)::integer as ledger_sum
      from candidates c
  ),
  upserted as (
    insert into public.balance_check_findings
      (business_id, consumer_id, cached_balance, ledger_sum, checked_at)
    select business_id, consumer_id, cached_balance, ledger_sum, clock_timestamp()
      from computed
    on conflict (business_id, consumer_id) do update
      set cached_balance = excluded.cached_balance,
          ledger_sum     = excluded.ledger_sum,
          checked_at     = excluded.checked_at
    returning drifted
  )
  select count(*), count(*) filter (where drifted)
    into v_processed, v_drifted
    from upserted;

  -- M1: readable via the Postgres server log (get_logs / the dashboard) -
  -- NOT via cron.job_run_details, which only ever records a run's
  -- completion status and, on FAILURE, its error string. A WARNING does not
  -- fail the statement, so a run that finds drift still reports SUCCESS to
  -- cron.job_run_details with no trace of this message there.
  if v_drifted > 0 then
    raise warning
      '[integrity.balance_check] % of % checked pair(s) drifted this run - see public.balance_check_findings',
      v_drifted, v_processed;
  end if;

  -- I6: report tier-0 occupancy when it consumes at least half the budget -
  -- the honest, observable signal that a clawback/expire flood is squeezing
  -- rotation throughput, which the static coverage-days formula below
  -- cannot see on its own (it reacts to pair COUNT, not to what is actually
  -- competing for slots tonight).
  if v_limit > 0 and v_priority * 2 >= v_limit then
    raise warning
      '[integrity.balance_check] % of % candidate slot(s) this run went to priority (clawback/expire, last 24h) pairs - rotation throughput is reduced; consider raising p_limit if this persists',
      v_priority, v_limit;
  end if;

  -- I3a/I5: the rotating cursor's coverage bound only matches doc 39's
  -- removed weekly full pass while the EFFECTIVE rotation budget (p_limit
  -- minus what the priority tier and points.expiry_sweep together reserve)
  -- keeps pace with pair_count - see private.balance_check_coverage_days for
  -- the accounting.
  v_coverage_days := private.balance_check_coverage_days(v_limit);
  if v_coverage_days > 7 then
    raise warning
      '[integrity.balance_check] full rotation now takes % day(s) at p_limit=% - business_customers has grown past the 7-day bound doc 39''s weekly full pass used to guarantee; raise p_limit or the cron frequency',
      v_coverage_days, v_limit;
  end if;

  return v_processed;
end
$$;

revoke execute on function public.balance_check(integer) from public, anon, authenticated;
grant execute on function public.balance_check(integer) to service_role;
