-- ============================================================================
-- 0057_balance_check_review_fixes.sql
-- Review fixes (task 2.2) to 0056's public.balance_check. Never edit 0056 in
-- place - it is already applied (supabase/README.md's 0011b/0047/0053-M2
-- precedent) - so this is a companion migration, re-creating the same
-- function signature and adding what the reviewer found missing.
--
-- The review's headline finding first, stated so it is not buried: the core
-- reconciler was NOT broken. The single-snapshot argument was traced by hand
-- across all six writers (including clawback's doc-35 clamp, which clamps
-- both sides together) and confirmed real; the rotating cursor's tight-
-- p_limit proof was confirmed to be the first in this repo that actually
-- discriminates "rotating" from "stuck"; and a genuine drift with the
-- inverted-comparison mutant killed was confirmed detected. All of that is
-- unchanged below. What follows are four gaps and five minors the review
-- found on top of it.
--
-- ---------------------------------------------------------------------------
-- I2 - the ledger sum was joined on consumer_id alone in every test fixture,
-- so a mutant deleting `and pt.business_id = c.business_id` from the sum's
-- WHERE clause passed the whole suite
-- ---------------------------------------------------------------------------
-- Every fixture consumer in rpc_balance_check_smoke.sql had transactions at
-- exactly one business, so `sum(points_transactions.points) where
-- consumer_id = X` and `sum(...) where consumer_id = X and business_id = Y`
-- were numerically identical for every row the suite ever checked - the
-- business_id predicate was exercised by zero assertions. A consumer active
-- at two or more businesses (the normal case on a multi-tenant loyalty
-- platform: a customer with a Giya wallet at both a cafe and a diner) would
-- have every OTHER business's ledger activity folded into each business's
-- own sum under that mutant, manufacturing drift for every such pair
-- simultaneously - a false-positive storm on exactly the alert doc 52 calls
-- page-worthy at any hour.
--
-- NO SQL CHANGE HERE: `public.balance_check`'s actual query already filters
-- `pt.business_id = c.business_id and pt.consumer_id = c.consumer_id` (0056,
-- unchanged below). This was a test-coverage gap, not a code defect - closed
-- in rpc_balance_check_smoke.sql with a consumer holding real
-- business_customers rows AND ledger rows at two businesses, asserted clean
-- at both. Verified red-first: the fixture was run live against a
-- deliberately reintroduced mutant (the same query with `and pt.business_id
-- = c.business_id` removed from the sum) and failed exactly as predicted
-- before being run against the real function and passing.
--
-- ---------------------------------------------------------------------------
-- I1 - pair F ("rich ledger") was mislabeled a concurrency proxy
-- ---------------------------------------------------------------------------
-- 0056's suite called pair F (five rows across earn/redeem/adjust/expire/
-- clawback) "the concurrent-write safety proxy". It is not one: it would
-- pass identically if `public.balance_check` read the cached balance in one
-- `select ... into` and the ledger sum in a second, later one - the exact
-- unsafe shape 0056's own header warns against - because nothing about
-- summing five rows correctly exercises WHEN they are read relative to the
-- cached balance, only THAT they sum correctly. It tests summation breadth
-- over a heterogeneous ledger, a real and worth-keeping property, just not
-- the one it was named for. 0056's header pointed to the suite as the proof
-- of its own single-snapshot claim (see its "Proven in rpc_balance_check_
-- smoke.sql" line); that pointer is corrected here to point at what
-- actually proves it.
--
-- THE FIX, the structural option the review offered as sufficient on its
-- own ("do one, or stop calling it what it isn't"): rpc_balance_check_
-- smoke.sql now pins, via `pg_get_functiondef`, that there is no statement
-- boundary (no `;`) between the candidate scan's read of `business_customers`
-- and the `returning` clause of the upsert into `balance_check_findings` -
-- i.e. that the read of both money tables and the write of the finding are
-- STRUCTURALLY one statement, not merely correct today. A future refactor
-- that split the read into two statements - reintroducing the exact race
-- 0056's header describes - would break that assertion rather than ship
-- silently. Pair F is relabeled to what it actually tests everywhere the
-- claim appeared: the suite (its own header and inline comments) here; this
-- migration's header is the correction of record for 0056's.
--
-- A true second-SESSION proxy (a temporary `before insert` trigger on
-- `balance_check_findings` mutating `business_customers.points_balance`
-- mid-statement) was considered and set aside: Postgres's own self-
-- visibility rules for a trigger firing on a table the SAME query is also
-- reading make its outcome depend on execution-plan details (whether the
-- planner inlines the non-recursive CTEs, whether the source rows for the
-- INSERT are materialized before the first trigger fires) that are not part
-- of this function's documented contract - a test built on that behavior
-- would be pinning an implementation accident, not the property, and could
-- flip from "proves the guarantee" to "proves nothing" on an unrelated
-- Postgres version bump. The structural assertion above pins the actual
-- CONTRACT (one statement) rather than one incidental way Postgres happens
-- to execute it.
--
-- ---------------------------------------------------------------------------
-- I3 - the weekly-full-pass equivalence has a ceiling, and doc 39's
-- clawback/expire priority was dropped entirely
-- ---------------------------------------------------------------------------
-- 0056's header argued the rotating cursor supersedes BOTH of doc 39's
-- registered cadences (nightly 1% sample, weekly full pass) because it
-- reaches every pair deterministically within `ceil(pair_count / p_limit)`
-- days. True, but only while `pair_count <= 7 * p_limit`: past that, a full
-- rotation takes MORE than 7 days - strictly worse than the weekly
-- guarantee this design removed - and 0056 shipped with no code that
-- measures pair count at all. "Revisit when it grows past..." was a
-- comment, not a tripwire; the backstop the removed weekly job would have
-- provided was gone with nothing standing in for it.
--
-- THE FIX: `private.balance_check_coverage_days(p_limit)`, a small, directly
-- testable `stable` primitive (0045's own precedent for this shape -
-- `private.points_lot_remainders` - and 0055's for "pgTAP cannot capture a
-- RAISE statement's text, so test the number it is built from" -
-- `private.campaigns_sweep_ineligible_count`), computing
-- `ceil(count(business_customers) / p_limit)`. `public.balance_check` calls
-- it once per run and `raise warning`s when it exceeds 7 - a real,
-- observable, live signal (via `get_logs` / the dashboard, per 0054's own
-- I3 fix and the corrected M1 note below) that the equivalence this design
-- rests on has broken, not merely a comment asking a future reader to
-- notice.
--
-- SEPARATELY, unmentioned in 0056 at all: doc 39's sample mode is "1%
-- random plus EVERY pair touched by clawback/expire in the last 24h" - the
-- clawback/expire half is not a suggestion, it is doc 39's own guarantee
-- that the highest-risk writes (reversals, the two writer paths most likely
-- to leave a pair wrong, per doc 35's own clamping/formula complexity) get
-- checked THAT NIGHT. A pure oldest-checked-first cursor gives a freshly
-- claw-backed pair no priority over anything else - it could wait as long as
-- any other pair in a large backlog.
--
-- THE FIX: the candidate scan's ORDER BY gets a leading priority tier -
-- `case when exists(a clawback/expire ledger row in the last 24h this pair
-- has not yet been re-verified against) then 0 else 1 end` - sorting such a
-- pair ahead of EVERY other candidate, including never-checked ones. It is
-- self-clearing by the same argument as the main cursor: once the pair is
-- checked, `checked_at` moves past that row's `created_at` and it falls back
-- to tier 1 - a fresh clawback cannot pin a pair at the front forever, only
-- until it is actually re-verified. Chose to share `p_limit` with the
-- rotation tier (a priority pair takes a slot from the SAME bounded budget,
-- rather than a second, unconditional, unbounded UNION) deliberately: doc
-- 39's original design could afford "every pair, unconditionally" because
-- it ran as an independent queue job; a bounded `LIMIT` is this design's
-- entire safety property, and an UNCONDITIONAL second set defeats it the
-- moment a fraud ring produces more clawbacks in 24h than `p_limit` -
-- exactly the scenario in which an unbounded query is least welcome. At
-- Giya's realistic clawback volume this is not a live tradeoff (p_limit
-- defaults to 500/day), and if it ever became one the coverage-days tripwire
-- above would flag it as the same symptom.
--
-- A new partial index, `pt_clawback_expire_recent_idx` (created_at) where
-- type in ('clawback','expire'), keeps the per-row EXISTS check that this
-- ORDER BY requires cheap: an index range scan over a small recent slice,
-- not a sequential scan of the whole ledger, evaluated once per business_
-- customers row the sort has to rank - a real, named per-row cost (0045's
-- own "computes the aggregate twice... a named, accepted cost" precedent),
-- bounded by how rare clawback/expire rows are relative to the whole table.
--
-- ---------------------------------------------------------------------------
-- I4 - the read side was in scope and was not built
-- ---------------------------------------------------------------------------
-- 0056's own header specified the read function's shape ("select count(*)
-- from public.balance_check_findings where drifted") and then declined to
-- write it, reasoning that doc 39's `[MVP]` cut for this job is "re-derive,
-- alert", not an admin screen. The plan document task 2.2 itself names it
-- ("persist drift report rows; surface count in admin overview"), so that
-- reasoning was asserted rather than sourced. `public.balance_check_summary()`
-- below closes it: `receipt_routing_breakdown`'s own shape (`security
-- definer`, `stable`, `service_role` only, an aggregate over a table nobody
-- else may read directly), sized to what this table actually has to say -
-- named columns rather than receipt_routing_breakdown's generic
-- `(kind, key, tally)`, because there is no natural breakdown dimension here
-- the way receipts has status/reason; a single summary row is the honest
-- shape. Until now the only in-band signal for a drift finding was a
-- `raise warning` in the Postgres log.
--
-- ---------------------------------------------------------------------------
-- MINORS
-- ---------------------------------------------------------------------------
-- M1 - 0056's header claimed the drift RAISE WARNING is "readable via
-- cron.job_run_details / get_logs". Half true, and the half that matters for
-- an operator glancing at the run history is the wrong half: 0054's own I3
-- section is explicit that `cron.job_run_details` "records the command's
-- completion status and (on failure) its error string - never a NOTICE
-- raised by a successful run", and a WARNING does not fail the statement, so
-- a run that finds drift still reports SUCCESS to `cron.job_run_details`
-- with no trace of the warning there. The WARNING text itself goes to the
-- Postgres server log - readable via `get_logs` / the dashboard, exactly as
-- 0054 states - never to `cron.job_run_details`. Corrected here, in the
-- companion, per the M2 process note on 0053/0054 (857ab86): even a header-
-- comment correction to an applied migration goes in a companion file, not
-- an in-place edit - 0056 is left exactly as it shipped, wrong claim and
-- all, which is real history the same way 0053's own header is.
--
-- M2 - `balance_check_findings` referenced `businesses(id)` and
-- `consumers(id)` directly rather than the pair itself, so a
-- `business_customers` row deleted without its parent business or consumer
-- being deleted (a "reset this relationship" admin action, a future GDPR-
-- shaped per-tenant purge) left its finding row behind forever - DELETE is
-- revoked from every role including `service_role` (0056's own fence 2, kept
-- below), so nothing short of a superuser session could ever clear a stale
-- `drifted=true` row for a pair that no longer exists. Fixed by re-pointing
-- both single-column FKs at ONE composite FK against `business_customers
-- (business_id, consumer_id)` - a legal reference to that table's own
-- `unique (business_id, consumer_id)` constraint (0002) - which cascades
-- correctly on BOTH the case this migration fixes (the pair row itself
-- deleted) and the case 0056 already handled (the business or consumer
-- purged, which cascades into `business_customers` first per its own FKs and
-- now transitively into this table).
--
-- M3 - no fixture ever carried a `reversal` row, the type `cancel_claim` and
-- `expire_claims` write - two of the six writers this job polices. Pair F's
-- ledger gains one (a partial claim-cancel reversal), widening its type
-- coverage to six of the seven values `points_transactions.type` permits
-- (`referral_bonus` is the one still unexercised, and is not one of the six
-- money-path writers named in this task's brief).
--
-- M5 - `balance_check(null)` passed `null` straight to `limit`, and `LIMIT
-- NULL` means NO LIMIT in Postgres - a caller error silently upgrading the
-- bounded design into an unbounded full-table pass, the opposite of what
-- `p_limit` exists to guarantee. Clamped once, at the top of the function
-- body, via `greatest(coalesce(p_limit, 500), 0)`, so `null` degrades to the
-- documented default rather than to unbounded.
-- ============================================================================

-- ---------------------------------------------------------------- M2: pair-level cascade
-- Drop-then-add, not alter: Postgres has no ALTER ... ALTER CONSTRAINT for
-- changing what a foreign key references.
alter table public.balance_check_findings
  drop constraint balance_check_findings_business_id_fkey,
  drop constraint balance_check_findings_consumer_id_fkey,
  add constraint balance_check_findings_pair_fkey
    foreign key (business_id, consumer_id)
    references public.business_customers (business_id, consumer_id)
    on delete cascade;

-- ---------------------------------------------------------------- I3b: priority index
-- Partial and narrow, mirroring pt_expiry_idx (0012) and jobs_dead_idx
-- (0029): the set of clawback/expire rows in any 24h window is small on a
-- healthy platform, so this index stays a handful of pages regardless of how
-- large points_transactions grows overall.
create index pt_clawback_expire_recent_idx
  on public.points_transactions (created_at)
  where type in ('clawback', 'expire');

-- ---------------------------------------------------------------- I3a: coverage primitive
-- Stable, SQL, no side effects - `public.balance_check` calls this exact
-- function to decide whether to warn, so the number a test asserts is the
-- number the warning is built from, never a second implementation of it.
create function private.balance_check_coverage_days(p_limit integer)
returns integer
language sql
stable
set search_path = ''
as $$
  select ceil(
    (select count(*) from public.business_customers)::numeric
    / greatest(coalesce(p_limit, 500), 1)
  )::integer;
$$;

-- Private helper, denied to every role including service_role - 0045's own
-- precedent (private.points_lot_remainders): only a SECURITY DEFINER
-- function already running as the owner (public.balance_check itself, or a
-- privileged test session) may ever call it.
revoke execute on function private.balance_check_coverage_days(integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- public.balance_check (re-created)
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
  v_coverage_days integer;
begin
  -- M5: LIMIT NULL is unbounded in Postgres. Clamp once, here, so every
  -- `limit` below is safe by construction regardless of what the caller
  -- passes.
  v_limit := greatest(coalesce(p_limit, 500), 0);

  with candidates as (
    select bc.business_id, bc.consumer_id, bc.points_balance
      from public.business_customers bc
      left join public.balance_check_findings f
        on f.business_id = bc.business_id
       and f.consumer_id = bc.consumer_id
     order by
       -- I3b: doc 39's "every pair touched by clawback/expire in the last
       -- 24h" guarantee. Tier 0 (sorts before every other pair, including
       -- never-checked ones): a clawback/expire ledger row in the last 24h
       -- this pair has not yet been re-verified against. Self-clearing:
       -- once checked, checked_at moves past that row's created_at and the
       -- pair falls back to tier 1 on the next run.
       (case when exists (
               select 1 from public.points_transactions pt
                where pt.business_id = bc.business_id
                  and pt.consumer_id = bc.consumer_id
                  and pt.type in ('clawback', 'expire')
                  and pt.created_at >= now() - interval '24 hours'
                  and pt.created_at > coalesce(f.checked_at, '-infinity'::timestamptz)
              ) then 0 else 1 end),
       -- Tier 1 (and the tie-break within tier 0): the original rotating
       -- cursor, unchanged from 0056.
       coalesce(f.checked_at, '-infinity'::timestamptz),
       bc.business_id, bc.consumer_id
     limit v_limit
  ),
  -- ONE statement (this whole `with` chain, unbroken by any `;`), one MVCC
  -- snapshot: see 0056's header "ZERO FALSE POSITIVES BY CONSTRUCTION"
  -- section, and rpc_balance_check_smoke.sql's structural assertion (I1
  -- review fix) which now pins this fact directly rather than relying on
  -- pair F's summation breadth to stand in for it.
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

  -- M1 (corrected): readable via the Postgres server log (get_logs / the
  -- dashboard) exactly as 0054's own I3 fix made true for its own WARNING -
  -- NOT via cron.job_run_details, which only ever records a run's
  -- completion status and, on FAILURE, its error string. A WARNING does not
  -- fail the statement, so a run that finds drift still reports SUCCESS to
  -- cron.job_run_details with no trace of this message there.
  if v_drifted > 0 then
    raise warning
      '[integrity.balance_check] % of % checked pair(s) drifted this run - see public.balance_check_findings',
      v_drifted, v_processed;
  end if;

  -- I3a: the rotating cursor's coverage bound (ceil(pair_count / p_limit)
  -- days) is only as tight as doc 39's removed weekly-full-pass guarantee
  -- (7 days) while pair_count <= 7 * p_limit. Past that this job is
  -- silently slower than the mechanism it replaced. A live tripwire, not
  -- just a comment: the same primitive a test asserts against.
  v_coverage_days := private.balance_check_coverage_days(v_limit);
  if v_coverage_days > 7 then
    raise warning
      '[integrity.balance_check] full rotation now takes % day(s) at p_limit=% - business_customers has grown past the 7-day bound doc 39''s weekly full pass used to guarantee; raise p_limit or the cron frequency',
      v_coverage_days, v_limit;
  end if;

  return v_processed;
end
$$;

-- Grants unaffected by create-or-replace on the same signature (0054's own
-- precedent), restated anyway per this repo's habit of never assuming it.
revoke execute on function public.balance_check(integer) from public, anon, authenticated;
grant execute on function public.balance_check(integer) to service_role;

-- ---------------------------------------------------------------- I4: the read side
-- receipt_routing_breakdown's own shape (security definer, stable,
-- service_role only, aggregating a table nobody else may read directly),
-- sized to what balance_check_findings actually has to say. oldest_checked_
-- at doubles as a second, human-visible symptom of the same I3a coverage
-- risk: a growing gap between it and now() means the rotation is falling
-- behind even before the tripwire's day-count crosses 7.
create or replace function public.balance_check_summary()
returns table (
  checked_count     bigint,
  drifted_count     bigint,
  oldest_checked_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::bigint,
         count(*) filter (where drifted)::bigint,
         min(checked_at)
    from public.balance_check_findings;
$$;

revoke execute on function public.balance_check_summary() from public, anon, authenticated;
grant execute on function public.balance_check_summary() to service_role;
