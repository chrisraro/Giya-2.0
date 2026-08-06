-- ============================================================================
-- 0056_balance_check.sql
-- Task 2.2 - `integrity.balance_check`: the reconciler that proves
-- `business_customers.points_balance` still equals the sum of that pair's
-- `points_transactions` rows. Six SECURITY DEFINER writers now maintain both
-- sides in the same transaction (`award_receipt_points` 0018/0037/0038/0040/
-- 0041, `claim_reward` 0013/0015, `cancel_claim` 0050/0051, `expire_claims`
-- 0016, `expire_points` 0043/0045, `clawback_receipt_points` 0031), and every
-- one of them was reviewed - but nothing has ever CHECKED that the invariant
-- holds against the live database. Doc 35 section 13, doc 39's job registry,
-- and doc 52's alerting matrix all name `integrity.balance_check`; only
-- `0029_jobs.sql`'s header comment mentioned it, in passing, as a future
-- publisher on that table.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW TABLE, NOT `receipt_routing_breakdown`'s SHAPE OR `sweep_job_
-- health`'s SHAPE
-- ---------------------------------------------------------------------------
-- Both of those functions EXPOSE data that already lives somewhere else on
-- disk (0035 aggregates `receipts` rows that already exist; 0028 reads
-- `cron.job_run_details`, which pg_cron itself already writes). Neither
-- PERSISTS anything - that is what makes them pure `stable` reads with no
-- INSERT in either body. A balance check has no such pre-existing record to
-- read: nobody has ever computed "does this pair's cache match its ledger"
-- before, so the first half of this migration's job is to create the place
-- that fact gets written down, and the second half is a scan whose own
-- correctness argument this task exists to prove. Once
-- `balance_check_findings` exists, the READ side of it - "how many pairs are
-- currently flagged", the shape a future admin overview (task 2.3/2.4) would
-- want - is a one-line aggregate over this table, which is exactly
-- `receipt_routing_breakdown`'s own shape (`security definer`, `stable`,
-- `service_role` only, aggregate a table nobody else may read directly); that
-- read function is not built here because nothing in this task's scope calls
-- it yet and doc 39's own `[MVP]` cut for this job is "re-derive, alert" -
-- not an admin screen. `select count(*) from public.balance_check_findings
-- where drifted` is the query task 2.3 will want; the table's own SELECT
-- grant to `service_role` (below) is already sufficient for it.
--
-- ONE ROW PER PAIR, upserted - not an append-only log - by deliberate
-- analogy to `business_customers` itself (the cache this migration audits):
-- the operationally useful fact is "what did the LAST check see for this
-- pair", not a growing history of identical clean results. Nothing in this
-- design "corrects" anything (constraint: this migration never writes
-- `points_transactions` or `business_customers`), so a drifted row is not at
-- risk of being silently overwritten by a rerun that papers over the
-- problem - the same two numbers will keep reappearing, unchanged, on every
-- future check until a HUMAN reconciles the ledger with an audited `adjust`
-- (doc 35 section 13's own runbook), at which point the next check honestly
-- reports clean. The table's own write fence (below) means the ONLY writer
-- of a row, ever, is `public.balance_check` itself - not a class of
-- service-role code that could bypass the scan's own logic.
--
-- ---------------------------------------------------------------------------
-- SELF-CLEARING, THE THIRD TIME THIS REPO HAS HAD TO GET THIS RIGHT
-- ---------------------------------------------------------------------------
-- 0045 (points expiry) and 0054 (campaigns sweep) both shipped a candidate
-- scan that re-selected the same rows forever once a `p_limit` boundary was
-- crossed, silently leaving everything past it unreached - caught in review
-- both times, by the same argument. Both of those sweeps DELETE a candidate
-- from future contention once it is resolved (a drained lot, a transitioned
-- campaign). This job cannot borrow that shape: a business_customers pair
-- that checks out clean TODAY is not "done" - the next award, redemption or
-- expiry sweep for that exact pair could desync it tonight, and the whole
-- point of a recurring integrity check is to look again. So "self-clearing"
-- here does not mean "a resolved pair leaves candidacy forever"; it means "no
-- single pair can occupy every slot forever", i.e. genuine ROTATION over the
-- full set of pairs, clean or not.
--
-- THE MECHANISM: a rotating, oldest-checked-first cursor.
-- `balance_check_findings.checked_at` is the "last looked at" timestamp for
-- a pair; a pair with no row yet (`f.checked_at is null`) sorts as
-- `-infinity` - i.e. absolute priority for a first look. Every run takes the
-- `p_limit` pairs with the OLDEST (or absent) `checked_at`, checks them, and
-- writes a fresh `checked_at`, which pushes them to the BACK of the queue for
-- the next run. A pair cannot be re-selected before every other pair has had
-- at least one turn - the same guarantee 0045/0054 needed for "does the
-- candidate ever change", proved below the same way `rpc_points_expiry_
-- smoke.sql` and `rpc_campaigns_sweep_smoke.sql` prove their own fixes: with
-- a TIGHT `p_limit` (1), not by asserting a full-table run returns zero
-- (which cannot tell "the scan is rotating" from "the scan is stuck").
--
-- IMPLEMENTATION NOTE, LOAD-BEARING: the timestamp written on each check uses
-- `clock_timestamp()`, never `now()` and never `statement_timestamp()`.
-- `now()` is `transaction_timestamp()` - frozen for the entire enclosing
-- transaction (see `rpc_campaigns_sweep_smoke.sql`'s own header for the same
-- fact used the other way), so every call to `public.balance_check` inside
-- one transaction would write the IDENTICAL `checked_at`, collapsing
-- "oldest-checked-first" into an unintended, untestable tie-break on
-- `(business_id, consumer_id)` alone. `statement_timestamp()` is not safe
-- either, and this is easy to get wrong: per Postgres's own multi-statement
-- handling, a batch of semicolon-separated statements delivered in ONE
-- protocol message (exactly what a pooled/scripted caller - including the
-- MCP `execute_sql` tool this suite was verified through - sends) shares a
-- SINGLE `statement_timestamp()` for every statement in that batch, not one
-- per statement; this was caught live, empirically, when four sequential
-- `balance_check(1)` calls in one batch all wrote the exact same
-- `statement_timestamp()`. `clock_timestamp()` is the one Postgres documents
-- as changing "even within a single SQL command" - true wall-clock time,
-- independent of statement or transaction boundaries - which is the only
-- variant that actually gives "last looked at" the granularity it needs
-- regardless of how a caller batches its calls.
--
-- ---------------------------------------------------------------------------
-- ZERO FALSE POSITIVES BY CONSTRUCTION: ONE STATEMENT, ONE SNAPSHOT
-- ---------------------------------------------------------------------------
-- Every one of the six writers above inserts its `points_transactions` row(s)
-- and updates `business_customers.points_balance` in ONE transaction (see,
-- for instance, 0018's Step 6 `update business_customers ... set
-- points_balance = v_prev_balance + p_points` alongside its own earn INSERT
-- a few statements earlier in the same function body, or 0050/0051's
-- `private.reverse_claim_ledger`, which does the same pairing for a
-- reversal). Postgres commits a transaction's writes atomically: under
-- READ COMMITTED (this database's default, and every SECURITY DEFINER
-- function here runs under it), a single SQL STATEMENT takes one snapshot at
-- its own start and holds it for its whole duration, including every CTE
-- inside a `with` query. A concurrent writer's transaction is therefore
-- either entirely invisible to that statement (not yet committed - both the
-- new ledger row AND the new cached balance are absent) or entirely visible
-- (committed - both present). There is no snapshot in which only one side
-- shows up.
--
-- The query below reads `business_customers.points_balance` and
-- `sum(points_transactions.points)` for every candidate pair inside ONE
-- `with` statement (`candidates` -> `computed` -> the upserting `insert ...
-- returning`), so it inherits that guarantee directly. The unsafe
-- alternative - reading the cached balance in one `select ... into`
-- statement and the ledger sum in a LATER, separate one - would open exactly
-- the window doc's own requirement warns about: a writer's transaction
-- committing in between the two reads would show up on only one side,
-- manufacturing drift that was never real. This function never does that;
-- it has exactly one statement that touches either table, and every one of
-- its per-pair reads therefore agrees with itself by the same argument that
-- makes the writers' own two-table updates atomic in the first place. No
-- `for update` lock is taken anywhere - none is needed for a read that
-- cannot be torn, and one would violate this task's other constraint (never
-- write to `points_transactions` or `business_customers`) for no benefit.
--
-- Proven in `rpc_balance_check_smoke.sql` (see that file's own header for
-- why a genuinely concurrent SECOND SESSION is not something this pgTAP
-- suite can spin up, and what is proved as the closest honest substitute).
--
-- ---------------------------------------------------------------------------
-- DETECTION ONLY - THE CONSTRAINT IS NOT INCIDENTAL
-- ---------------------------------------------------------------------------
-- This migration never writes `points_transactions` or `business_customers`.
-- An automatic "fix" that silently rewrote a cached balance to match the
-- ledger would destroy the evidence a human needs to find WHY they diverged;
-- if the ledger itself were the wrong side (a bug that inserted the wrong
-- `points` value), auto-correcting the cache would launder that error into
-- looking like the truth. Doc 35 section 13's own runbook is explicit: a
-- drift finding is an INCIDENT, investigated by a human, resolved by an
-- audited `adjust` ledger entry through the existing money path - never by
-- this job.
--
-- ---------------------------------------------------------------------------
-- SCHEDULE: ONE DAILY JOB, NOT DOC 39's SAMPLE/FULL SPLIT
-- ---------------------------------------------------------------------------
-- Doc 39 registers two cadences - a nightly 1% random sample and a weekly
-- full re-derivation - because ITS design re-samples randomly each run, so
-- "eventually every pair gets checked" is only a probabilistic property that
-- needs the weekly full pass as a backstop. The rotating cursor above does
-- not have that gap: every pair's `checked_at` strictly orders it, so a
-- pair cannot be skipped indefinitely the way a random sample could
-- (vanishingly rarely) miss the same pair forever - a full daily run of
-- `p_limit` pairs on a rotating cursor reaches EVERY pair within
-- `ceil(pair_count / p_limit)` days, deterministically, with no separate
-- "full scan" needed to guarantee coverage. One daily schedule at the
-- doc-registered sample slot (`40 18 * * *`, 02:40 Manila - immediately
-- after the points-expiry pair at 02:10/02:25, well before the exports
-- cleanup at 03:55) therefore already delivers what doc 39 wanted from BOTH
-- cadences. Revisit only if `business_customers` grows past the point where
-- one daily pass of 500 pairs is a meaningfully large fraction of the table.
-- ============================================================================

-- ============================================================================
-- public.balance_check_findings - the persisted record
-- ============================================================================
-- One row per (business_id, consumer_id) pair, upserted by public.balance_
-- check alone. `drifted` is generated so the one comparison that defines
-- "wrong" is written once and can never quietly diverge from the value the
-- function itself used to decide whether to warn.
create table public.balance_check_findings (
  business_id    uuid not null references public.businesses(id) on delete cascade,
  consumer_id    uuid not null references public.consumers(id) on delete cascade,
  cached_balance integer not null,
  ledger_sum     integer not null,
  drifted        boolean not null generated always as (cached_balance <> ledger_sum) stored,
  checked_at     timestamptz not null default clock_timestamp(),
  primary key (business_id, consumer_id)
);
alter table public.balance_check_findings enable row level security;

-- FK index per doc 20 convention. business_id is already the leading column
-- of the primary key above; consumer_id is not independently indexed by it,
-- mirroring business_customers' own bc_consumer_idx alongside its composite
-- unique (business_id, consumer_id).
create index balance_check_findings_consumer_idx
  on public.balance_check_findings (consumer_id);

-- The operator's read: every pair CURRENTLY flagged, newest finding first.
-- Partial and therefore cheap on a healthy platform (doc 52's alert SLO is
-- "zero drift expected"), exactly the reasoning behind jobs_dead_idx (0029)
-- and pt_expiry_idx (0012).
create index balance_check_findings_drifted_idx
  on public.balance_check_findings (checked_at desc)
  where drifted;

-- ---------------------------------------------------------------- policies
-- NONE. This table carries the same sensitivity 0029's own header already
-- flagged for it by name ("doc 39 also has fraud.ring_sweep and integrity.
-- balance_check publishing through this same table [jobs], so a readable
-- jobs would eventually be a readable schedule of when the fraud sweeps
-- run") - a client-readable balance_check_findings would let any signed-in
-- user learn which OTHER (business, consumer) pairs the platform currently
-- believes are money-wrong, which is both a privacy leak (it names real
-- consumers) and a map of exactly where a ledger bug might still be
-- exploitable. RLS is enabled with zero policies so the absence reads as a
-- deliberate deny, matching 0029's own reasoning for `jobs`.

-- ---------------------------------------------------------------- fence 1 of 3
-- Privilege layer, client roles. Same reasoning as every sibling table: a
-- loud 42501 rather than a silent, policy-shaped empty set.
revoke select, insert, update, delete, truncate on public.balance_check_findings
  from anon, authenticated;

-- ---------------------------------------------------------------- fence 2 of 3
-- Privilege layer, service_role. SELECT stays - the future admin/monitoring
-- read (task 2.3/2.4) goes through the service role exactly like every other
-- internal surface in this schema. Every WRITE is revoked, including INSERT
-- and UPDATE: this table has exactly one legitimate writer,
-- `public.balance_check` (SECURITY DEFINER, owned by the table owner, which
-- bypasses this exact revoke the same way `award_receipt_points` bypasses
-- the equivalent revokes on `points_transactions`). Nothing else - not even
-- service-role application code reaching this table directly - may produce a
-- finding row, so a finding can only ever be the output of the scan's own
-- logic, never a shortcut around it.
revoke insert, update, delete, truncate on public.balance_check_findings
  from service_role;

-- ---------------------------------------------------------------- fence 3 of 3
-- Statement trigger. A row-level trigger never fires on TRUNCATE (see 0022's
-- and 0029's identical third fence), so this is the layer that survives a
-- future misgrant to whoever still holds the table-owner privilege. Findings
-- are evidence for exactly the reason audit_logs and jobs both give: the one
-- thing worth erasing is the one recording that something went wrong.
create or replace function private.balance_check_findings_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'balance_check_findings cannot be truncated (integrity evidence)';
end
$$;

create trigger balance_check_findings_no_truncate
  before truncate on public.balance_check_findings
  for each statement execute function private.balance_check_findings_no_truncate();

-- ============================================================================
-- public.balance_check - the reconciler
-- ============================================================================
-- Returns the number of pairs CHECKED this run (matching every sibling
-- sweep's own convention: expire_points returns rows expired, sweep_
-- campaigns returns rows transitioned, sweep_stuck_receipts returns rows
-- moved - each "how many did THIS call act on"). The count of pairs found
-- DRIFTED this run is not the return value: pg_cron discards a scheduled
-- statement's result entirely (only `status`/`return_message` land in
-- `cron.job_run_details`, per 0028's own header), so the number that matters
-- operationally is not what a nightly cron caller can read from a return
-- value regardless of which count is chosen - it is `select count(*) from
-- public.balance_check_findings where drifted`, live, at any time, which
-- this function's own writes keep current. The RAISE WARNING below (readable
-- via cron.job_run_details / get_logs, per 0054's own I3 fix - NOTICE never
-- reaches an operator, WARNING does) is this run's honest, in-the-moment
-- signal that something needs a human.
create or replace function public.balance_check(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_processed integer := 0;
  v_drifted   integer := 0;
begin
  with candidates as (
    -- Rotating cursor: oldest-checked-first, never-checked pairs (f.checked_at
    -- is null, coalesced to -infinity) take absolute priority. Tie-broken
    -- deterministically by (business_id, consumer_id) so two pairs checked
    -- close enough together to land on the same clock_timestamp() still have
    -- a stable relative order on the NEXT run rather than a coin flip.
    select bc.business_id, bc.consumer_id, bc.points_balance
      from public.business_customers bc
      left join public.balance_check_findings f
        on f.business_id = bc.business_id
       and f.consumer_id = bc.consumer_id
     order by coalesce(f.checked_at, '-infinity'::timestamptz), bc.business_id, bc.consumer_id
     limit p_limit
  ),
  -- ONE statement (this whole `with` chain), one MVCC snapshot: see the
  -- migration header's "ZERO FALSE POSITIVES BY CONSTRUCTION" section for why
  -- that is what makes a concurrent writer's commit unable to appear on only
  -- one side of this comparison.
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

  if v_drifted > 0 then
    raise warning
      '[integrity.balance_check] % of % checked pair(s) drifted this run - see public.balance_check_findings',
      v_drifted, v_processed;
  end if;

  return v_processed;
end
$$;

-- service_role only, matching every sibling sweep. No client role - consumer
-- or business staff - may ever call this directly; it is a platform integrity
-- job.
revoke execute on function public.balance_check(integer) from public, anon, authenticated;
grant execute on function public.balance_check(integer) to service_role;

-- ---------------------------------------------------------------- schedule
-- `40 18 * * *` (02:40 Manila) - doc 39's own registered slot for the sample
-- cadence, right after the points-expiry pair (02:10/02:25) and well before
-- exports cleanup (03:55). See the migration header for why one daily
-- schedule on the rotating cursor supersedes doc 39's separate weekly "full"
-- cadence rather than needing a second cron.schedule call. `cron.schedule`
-- upserts on (jobname, username), so replaying this migration updates the
-- existing row rather than duplicating it (0028's own idiom).
select cron.schedule(
  'integrity.balance_check',
  '40 18 * * *',
  $job$select public.balance_check(500);$job$
);
