-- ============================================================================
-- 0058_balance_check_deployment_correction.sql
-- Task 2.2, second review-fix pass. Never edit 0057 in place - this
-- migration exists BECAUSE that rule matters, not despite it.
--
-- ---------------------------------------------------------------------------
-- WHAT HAPPENED: 0057's ledger row does not mean what it appears to mean
-- ---------------------------------------------------------------------------
-- The reviewer queried pg_proc directly against the live database and found
-- that `public.balance_check`'s deployed body did not match the committed
-- 0057 file: the live `prosrc` was 2544 characters with zero occurrences of
-- the word "tier" and (per their read) no reference to `coverage_days`,
-- while the committed file's body is ~4539 characters with five occurrences
-- of "tier" and calls `private.balance_check_coverage_days` explicitly.
-- Every OTHER object 0057 creates - `private.balance_check_coverage_days`,
-- `public.balance_check_summary`, the composite FK, the new index - WAS
-- live, correctly, and the `supabase_migrations` ledger carried a row for
-- 0057. So the migration was recorded as fully applied while the one
-- statement that changes this job's actual behaviour silently was not.
--
-- Re-establishing ground truth directly against pg_proc/pg_constraint/
-- pg_indexes (this migration's own diagnostic pass, kept honest by not
-- trusting any earlier "success" response) found a THIRD state, not either
-- of the two compared above: the live `balance_check` body DID contain the
-- priority-tier CASE WHEN block and DID call
-- `private.balance_check_coverage_days` - so I3a's tripwire and I3b's
-- priority tier were both functionally present by the time this migration
-- was written - but the deployed body carried NONE of 0057's comments.
-- 2544 characters is the exact length of the STRIPPED-COMMENT SQL text this
-- task actually submitted to `apply_migration` / `execute_sql` during the
-- review-fix TDD loop (the tool calls used a condensed body without the
-- file's explanatory comments, for call-payload brevity while iterating
-- quickly), not 0056's original body (2406 characters) and not 0057's
-- committed file body (~4539 characters) either. A later step in that same
-- session - restoring the function after the I2 red/green mutant
-- verification - happened to redeploy that same stripped-comment-but-
-- functionally-current body, which is why behaviour matches intent as of
-- now even though the bytes on disk never did.
--
-- THE ACTUAL DEFECT, independent of which specific behaviour ended up live:
-- an `apply_migration` (or `execute_sql`) call returning success was treated
-- as proof that the exact committed SQL is what is now live. It is not proof
-- of that. The only thing that proves a deployed function's behaviour is a
-- post-hoc read-back - `pg_get_functiondef` / `pg_proc.prosrc` - compared
-- against the file, which is precisely what this migration's own process
-- did differently: every `create or replace function` below is followed, IN
-- THIS SAME REVIEW SESSION, by a direct `pg_proc` query confirming the
-- deployed body before moving on, and the test suite now asserts the same
-- thing permanently (see the "defense" section of `rpc_balance_check_
-- smoke.sql`: the live body must contain the word "tier" and a call to
-- `coverage_days`, a pin that fails the moment file and database drift apart
-- again). This is the same class of incident doc 39/this repo's own 0042
-- history names, and worse in one respect noted by the review: 0042's
-- divergence was in the ledger's recorded HISTORY (the live body matched the
-- file; only the migration's narrative about its own past was wrong), while
-- this one was in BEHAVIOUR - the file described an integrity job policing
-- the money path and the database was, for a time, recorded as running one
-- while a materially different (if ultimately equivalent-by-luck) body was
-- actually live.
--
-- `0057`'s ledger row is left exactly as it is (never edited in place, per
-- this repo's absolute rule) - it is real history of what NAME was recorded
-- applied, and this migration's own header is the correction of record for
-- what that name did NOT guarantee about its content.
--
-- ---------------------------------------------------------------------------
-- ALSO FIXED (from the same review pass)
-- ---------------------------------------------------------------------------
-- C1 - the structural "one statement" assertion (0057 review fix I1) checked
-- for a literal `;` in the function's source span without stripping `--`
-- comments first, so a comment merely DESCRIBING the guarantee ("unbroken by
-- any `;`" - 0057's own prose) would have tripped the assertion the moment
-- the fully-commented body it now insists on ever reached the database. The
-- test now strips line comments (`regexp_replace(span, '--[^\n]*', '', 'g')`)
-- before checking, and every comment in the function bodies below is worded
-- to avoid the character regardless ("no statement boundary" rather than
-- "unbroken by any `;`").
--
-- I5 - the coverage-days tripwire treated the ENTIRE `p_limit` as rotation
-- budget, but the I3b priority tier and `points.expiry_sweep` compete for
-- the same slots: that sweep runs at `10 18 * * *`, thirty minutes before
-- `balance_check`'s own `40 18 * * *` slot, with its own `p_limit` of 200
-- (`select public.expire_points(200);`, read live from `cron.job` below,
-- not hand-copied), and every pair it touches writes an `expire` row - which
-- is EXACTLY this job's own tier-0 trigger. On a mature platform up to 200
-- of this run's slots can go to tier 0 before rotation gets any at all, so
-- treating the whole `p_limit` as rotation-only silently understated true
-- coverage latency. `private.balance_check_coverage_days` now subtracts that
-- reservation from the denominator, reading it out of `points.expiry_sweep`'s
-- own live cron command (a regex extraction of the number inside
-- `expire_points(...)`, falling back to 200 if the schedule is ever
-- unparseable) rather than a second hand-maintained constant that could
-- silently drift from 0028's actual schedule.
--
-- I6 - the header offered `coverage_days` as the detector for tier-0
-- starvation, but it is a pure function of pair count and `p_limit`; a
-- clawback flood changes neither, so it could never observe the risk it was
-- offered as a mitigation for. The honest metric - how many of THIS run's
-- candidate slots are tier 0 - is now computed
-- (`private.balance_check_priority_count`, the same 0045/0055-shaped
-- testable primitive pattern as `coverage_days` itself) and reported via
-- `raise warning` whenever it consumes at least half the budget, instead of
-- being silently discarded after deciding sort order.
--
-- I7 - the composite FK 0057 added (`balance_check_findings (business_id,
-- consumer_id) references business_customers (business_id, consumer_id)`)
-- looked like the right fix for M2 (a stale finding surviving a pair-level
-- delete forever) but introduced a real cost on the money path: Postgres
-- enforces a foreign key by taking `FOR KEY SHARE` on the REFERENCED parent
-- row for every INSERT that references it for the first time, and `FOR KEY
-- SHARE` conflicts with the `FOR UPDATE` every money-path writer
-- (`award_receipt_points` and the rest) takes on that exact `business_
-- customers` row. Bounded - only first sightings of a pair take the lock,
-- since `ON CONFLICT DO UPDATE` skips the RI recheck when the FK columns
-- (the primary key here) are unchanged - but real, and it directly
-- contradicts both this job's binding constraint ("read-only against the
-- money path") and 0056's own header, which claims "no `for update` lock is
-- taken anywhere" without qualification. Fixed by removing the foreign key
-- entirely and replacing it with an `after delete` trigger on `business_
-- customers` that deletes the matching finding directly: same cleanup
-- outcome M2 wanted, zero locks on the money path, because a trigger is not
-- a constraint and takes no referential-integrity lock at all. The original
-- two single-column FKs to `businesses(id)` / `consumers(id)` (0056) are
-- restored alongside it - those reference tables no writer ever takes `FOR
-- UPDATE` on, so their own first-sighting locks were never the problem M2 or
-- I7 were ever about.
--
-- M10 (noted, not further mitigated) - the trigger above still means a
-- `drifted=true` finding can be erased by deleting the `business_customers`
-- row it describes, which service-role code CAN do (this table's own DELETE
-- stays revoked from every role, including service_role, but that revoke
-- only protects `balance_check_findings` itself - deleting the PARENT row
-- was never something this table's own fence could prevent). Accepted as
-- drawn: nothing in this codebase currently deletes a `business_customers`
-- row at all (0012 creates it "on first interaction" and nothing removes
-- it), so this is a defence against a hypothetical future path, not an
-- active one, and a business_customers deletion is already a much larger,
-- much more auditable event than the finding it happens to take with it -
-- the finding surviving "no matter what" was never M2's actual guarantee,
-- only "survives as long as the pair it describes still exists," which is
-- the scope this migration keeps.
--
-- M11 - `pt_clawback_expire_recent_idx` (0057), a global index on `points_
-- transactions (created_at) where type in (...)`, does not serve the I3b
-- EXISTS check it was built for: that check is CORRELATED per candidate row
-- on `(business_id, consumer_id, ...)`, and the pre-existing `pt_consumer_
-- biz_idx (consumer_id, business_id, created_at desc)` (0012) already
-- matches that correlation exactly - the planner has no reason to prefer a
-- global, uncorrelated index for a per-row correlated lookup, and 0057's
-- rationale claiming otherwise was wrong. Dropped: it was dead weight, one
-- more index for every `points_transactions` insert to maintain for no
-- query it actually served.
-- ============================================================================

-- ---------------------------------------------------------------- I7: replace the FK with a trigger
alter table public.balance_check_findings
  drop constraint balance_check_findings_pair_fkey,
  add constraint balance_check_findings_business_id_fkey
    foreign key (business_id) references public.businesses(id) on delete cascade,
  add constraint balance_check_findings_consumer_id_fkey
    foreign key (consumer_id) references public.consumers(id) on delete cascade;

-- M2's actual mechanism now: a trigger, not a constraint, so it takes no
-- referential-integrity lock on business_customers at all. Fires once per
-- deleted pair row; a no-op (0 rows deleted) if that pair was never checked.
create or replace function private.balance_check_findings_pair_cleanup()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.balance_check_findings
   where business_id = old.business_id
     and consumer_id = old.consumer_id;
  return old;
end
$$;

create trigger business_customers_cleanup_balance_check_findings
  after delete on public.business_customers
  for each row execute function private.balance_check_findings_pair_cleanup();

-- ---------------------------------------------------------------- M11: drop the index that never earned its keep
drop index if exists public.pt_clawback_expire_recent_idx;

-- ---------------------------------------------------------------- I6: the tier-0 occupancy primitive
-- Same shape as private.balance_check_coverage_days: a small, stable,
-- independently-testable primitive, denied to every role including
-- service_role, called by public.balance_check below so the number a test
-- asserts is the number the warning is built from - never a second,
-- divergent implementation of "is this pair tier 0 right now".
create function private.balance_check_priority_count(p_limit integer)
returns integer
language sql
stable
set search_path = ''
as $$
  with scored as (
    select bc.business_id, bc.consumer_id, f.checked_at,
           exists (
             select 1 from public.points_transactions pt
              where pt.business_id = bc.business_id
                and pt.consumer_id = bc.consumer_id
                and pt.type in ('clawback', 'expire')
                and pt.created_at >= now() - interval '24 hours'
                and pt.created_at > coalesce(f.checked_at, '-infinity'::timestamptz)
           ) as is_priority
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

-- ---------------------------------------------------------------- I5: the coverage-days primitive, budget-corrected
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
        -- Read points.expiry_sweep's OWN p_limit live out of its cron
        -- command rather than hand-copying the number: this stays correct
        -- if 0028's schedule ever changes without anyone remembering to
        -- update a second constant here. Falls back to 200 (today's actual
        -- value) only if the schedule row is missing or its command text
        -- ever stops matching the expected `expire_points(<n>)` shape.
        - coalesce((
            select (regexp_match(j.command, 'expire_points\((\d+)\)'))[1]::integer
              from cron.job j
             where j.jobname = 'points.expiry_sweep'
          ), 200),
        1)
  )::integer;
$$;

revoke execute on function private.balance_check_coverage_days(integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- public.balance_check (re-created, exact deployed body)
create or replace function public.balance_check(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
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
       -- pair, including never-checked ones): a clawback/expire ledger row
       -- in the last 24h this pair has not yet been re-verified against.
       -- Self-clearing: once checked, checked_at moves past that row's
       -- created_at and the pair falls back to tier 1 on the next run.
       (case when exists (
               select 1 from public.points_transactions pt
                where pt.business_id = bc.business_id
                  and pt.consumer_id = bc.consumer_id
                  and pt.type in ('clawback', 'expire')
                  and pt.created_at >= now() - interval '24 hours'
                  and pt.created_at > coalesce(f.checked_at, '-infinity'::timestamptz)
              ) then 0 else 1 end),
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
