-- ============================================================================
-- 0043_points_expiry_engine.sql
-- Task 1.3, step 2: the FIFO remainder engine (doc 35 section 7) and the
-- sweep that writes `expire` ledger rows from it, scheduled by pg_cron in the
-- style of 0028 (expire_claims/sweep_stuck_receipts).
--
-- ONE FORMULA, THREE READERS. Doc 35 section 7 defines a single arithmetic
-- fact per (business, consumer) pair: given every positive lot's `expires_at`
-- and every debit ever posted against the pair, how much of each lot remains
-- unconsumed right now (FIFO, oldest lot drained first - correct because
-- `expires_at` is monotone in `created_at`: every positive row in a pair
-- shares one flat 12-month policy applied at write time, per 0042). This
-- migration writes that arithmetic exactly ONCE, as `private.
-- points_lot_remainders`, and everything else - the sweep below, the warn job
-- (0044), and the wallet's "next expiry" read (0044's public wrapper) -
-- derives from it. This is the seam the task brief asks for explicitly: "the
-- number the user sees is the number the sweep will expire."
--
-- WHY PER-LOT, NOT JUST THE AGGREGATE. Doc 35 section 7 only ever states the
-- AGGREGATE remainder (`max(0, X(t) - D(t))`, enough to write one sweep row),
-- but the wallet needs "which lot expires next and for how much" - a
-- per-lot breakdown the aggregate formula alone cannot answer. The identity
-- that makes ONE implementation serve both:
--
--   for lots L1..Ln ordered by created_at (= expires_at order), let
--   cumulative_i = sum(points) of L1..Li, and D = total debits ever (doc 35's
--   D(t) does not actually depend on t - only the LOT FILTER does):
--
--     remaining_i = min(p_i, max(0, cumulative_i - D))
--
--   Summing remaining_i over the prefix of lots with expires_at <= t telescopes
--   to exactly max(0, cumulative_k - D) = max(0, X(t) - D(t)) for k = the last
--   lot with expires_at <= t (proof: lots fully behind D contribute 0, the one
--   straddling D contributes cumulative - D, every lot after it contributes its
--   own p_i in full, and the partial sums cancel to cumulative_k - D). So the
--   per-lot table below and doc 35's own aggregate formula are PROVABLY the
--   same fact at two granularities, not two competing implementations.
--
-- WHY THIS IS "PRIVATE" AND HOW IT IS STILL REACHABLE. Doc 20's "private is
-- schema-hidden from PostgREST" applies regardless of security definer/invoker
-- (0038's own note): so both readers that need it from outside a definer
-- context (the sweep below, and 0044's warn job / wallet wrapper) can only
-- reach it through a `public.` entry point. Unlike `fixed_per_visit_
-- already_paid` or `campaign_points_awarded` - which MUST run as the
-- definer's owner because they aggregate across every consumer/campaign, data
-- an ordinary RLS-scoped read could never assemble - this formula's inputs
-- (one pair's own ledger rows) are already exactly what `pt_consumer_select`
-- lets that consumer read directly. The wrapper this migration and 0044 add is
-- still service_role only, matching this repo's established posture for every
-- `public.` wrapper around a `private.` helper (see the I-A grant block in
-- rpc_award_smoke.sql): the wallet's OWN read goes through a service-role
-- server module (src/features/points/server/expiry.ts), the same trust
-- boundary `award.ts` already uses for `campaign_points_awarded` et al., not a
-- widened grant to `authenticated`.
--
-- THE SWEEP'S CANDIDATE SCAN. Doc 35 section 7: "select distinct pairs having
-- earn rows with expires_at <= now() not yet fully drained (cheap pre-filter:
-- pair appears in pt_expiry_idx and points_balance > 0)". `pt_expiry_idx`
-- (0012: `(business_id, expires_at) where type='earn' and expires_at is not
-- null`) makes the EXISTS probe below an index lookup; `points_balance > 0`
-- narrows to pairs that could possibly still owe an expiry. This is a
-- pre-filter, not an exact filter (a pair can pass it and still have remainder
-- 0, e.g. every past-due lot already fully spent) - doc 35 calls this out as
-- "cheap", not "exact", and 0041's own N2 note sets the precedent that
-- correctness, not this scan's tightness, is this task's binding constraint.
--
-- LOCKING AND IDEMPOTENCY, mirroring 0016/0018 exactly: `for update of bc skip
-- locked` takes the SAME lock `award_receipt_points` and `expire_claims` take
-- on `business_customers`, so a sweep run can never race an award or a
-- concurrent sweep for the same pair, and an overlapping run partitions the
-- backlog rather than blocking on it. Idempotency is structural, not a flag:
-- a second run recomputes the SAME remainder formula, which is already zero
-- for anything the first run drained (the `expire` row it wrote is itself a
-- negative row inside D, exactly as doc 35 section 7's own closing line says:
-- "prior expire rows are inside D(t) ... the formula is stable under repeated
-- runs and needs no state beyond the ledger itself").
--
-- NEVER DRIVES NEGATIVE: `least(v_remainder, v_balance)` is defense in depth
-- (the formula's own clamp to points_balance already argues remainder should
-- never exceed it - doc 35 section 7's own clamp note - but the sweep does not
-- trust that invariant blindly any more than `award_receipt_points` trusts
-- `p_points` blindly).
--
-- NO NOTIFICATION HERE, deliberately, mirroring `expire_claims`'s own
-- precedent (0016): doc 35 names `notify kind='points_expired'` but that is
-- this task's WARN job's job description, not the sweep's - the task brief's
-- own "Required behavior" list (item 2) never mentions raising a notification
-- from the sweep, only from the separate warn job (item 3, 0044). Following
-- `expire_claims`'s exact precedent (which also never raised `reward_claim_
-- expired`, a doc-named [V1] gap this codebase already accepted) rather than
-- inventing a new posture here.
--
-- Source docs: docs/30-modules/35-points-engine.md section 7 (formula,
-- candidate scan, chunk size); docs/30-modules/39-background-jobs.md
-- (`points.expiry_sweep`, daily, `10 18 * * *` UTC = 02:10 Manila);
-- supabase/migrations/0012_campaigns.sql (pt_expiry_idx, points_transactions
-- check constraints - 'expire' already an admitted type, see below);
-- supabase/migrations/0016_claim_expiry_sweep.sql,
-- 0028_scheduled_sweeps.sql (the sweep + pg_cron shape this mirrors);
-- 0038_fixed_per_visit_visit_day.sql, 0041_campaign_budget_attribution.sql
-- (the private-helper + public-definer-wrapper pattern).
--
-- LEDGER TYPE CHECK (brief item 5): 0012's points_transactions.type check
-- already admits 'expire' (`check (type in ('earn','redeem','adjust','expire',
-- 'clawback','reversal','referral_bonus'))`) - confirmed by direct read, no
-- migration needed for it. `TRANSACTION_ICON.expire` on the wallet (src/app/
-- (consumer)/wallet/page.tsx) has therefore been ahead of the writer since it
-- was added.
-- ============================================================================

-- ---------------------------------------------------------------- the shared predicate
-- Per-lot FIFO remainder for one (business, consumer) pair, as of NOW (D is
-- "every debit ever", not asof-filtered - see the header's identity). `stable`
-- rather than `immutable`: it reads points_transactions, whose rows can only
-- grow, never change (append-only, 0012), but the RESULT depends on when it
-- is called relative to concurrent writes, which is exactly what `stable`
-- (not `immutable`) declares.
create or replace function private.points_lot_remainders(
  p_business_id uuid,
  p_consumer_id uuid
) returns table (
  txn_id     uuid,
  created_at timestamptz,
  expires_at timestamptz,
  points     integer,
  remaining  integer
)
language sql
stable
set search_path = ''
as $$
  with lots as (
    select pt.id, pt.created_at, pt.expires_at, pt.points,
           sum(pt.points) over (
             order by pt.created_at, pt.id
             rows between unbounded preceding and current row
           ) as cumulative
      from public.points_transactions pt
     where pt.business_id = p_business_id
       and pt.consumer_id = p_consumer_id
       and pt.points > 0
       -- positive rows doc 35 section 7's X(t) counts: earn, referral_bonus
       -- (not written by any path yet, but the doc's own definition includes
       -- it and this formula must not need editing the day it is), and a
       -- POSITIVE adjust (doc 35 section 8: "positive adjustments get
       -- expires_at per the business expiry policy"). `reversal` rows are
       -- explicitly excluded (doc 35 section 7: "reversal rows are positive
       -- and never counted here") - a reversal restores a balance a REDEMPTION
       -- already drained, it does not mint a new expiring lot.
       and pt.type in ('earn', 'referral_bonus', 'adjust')
  ),
  debits as (
    -- D: every debit ever, doc 35 section 7's D(t) - NOT time-filtered,
    -- because a debit cannot predate the lot(s) it drains and "everything
    -- ever drained" is exactly what FIFO consumption removes from the front
    -- of the queue regardless of when the sweep asks the question.
    select coalesce(sum(-pt.points), 0)::integer as total_debit
      from public.points_transactions pt
     where pt.business_id = p_business_id
       and pt.consumer_id = p_consumer_id
       and pt.points < 0
       and pt.type in ('redeem', 'adjust', 'expire', 'clawback')
  )
  select l.id, l.created_at, l.expires_at, l.points,
         least(l.points, greatest(0, (l.cumulative - d.total_debit)))::integer as remaining
    from lots l
    cross join debits d
   order by l.created_at, l.id;
$$;

-- Not directly reachable, matching every other private helper this schema's
-- sweeps rely on (private.fixed_per_visit_already_paid, private.campaign_
-- points_awarded): callable only from inside a SECURITY DEFINER context that
-- has already been granted execute (this migration's own functions below, and
-- 0044's).
revoke execute on function private.points_lot_remainders(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- the aggregate (doc 35's own formula)
-- max(0, X(asof) - D): the sum of every lot's remainder whose expires_at falls
-- at or before `p_asof`. Used with p_asof = now() by the sweep below, and with
-- p_asof = now() + 30d / now() + 7d by 0044's warn job - ONE function, two
-- horizons, never two formulas.
create or replace function private.points_expirable_remainder(
  p_business_id uuid,
  p_consumer_id uuid,
  p_asof        timestamptz
) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(r.remaining), 0)::integer
    from private.points_lot_remainders(p_business_id, p_consumer_id) r
   where r.expires_at is not null
     and r.expires_at <= p_asof;
$$;

revoke execute on function private.points_expirable_remainder(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- public wrappers
-- SECURITY DEFINER purely to reach the revoked-from-service_role private
-- helper above (see the header on why service_role itself still cannot call
-- it directly - the same posture 0038/0041 established). service_role only:
-- this is the number the sweep is about to spend, not a client-facing read.
create or replace function public.points_expirable_remainder(
  p_business_id uuid,
  p_consumer_id uuid,
  p_asof        timestamptz default now()
) returns integer
language sql
security definer
stable
set search_path = ''
as $$
  select private.points_expirable_remainder(p_business_id, p_consumer_id, p_asof);
$$;

revoke execute on function public.points_expirable_remainder(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.points_expirable_remainder(uuid, uuid, timestamptz)
  to service_role;

-- The wallet's "what expires when" read (task brief item 4): the single
-- soonest-expiring lot with a positive remainder, if any. Zero or one row,
-- never a list - the wallet shows "the next thing that expires", not a
-- statement.
--
-- `r.expires_at > now()`: a lot already past its cutoff is the SWEEP's
-- business (`public.expire_points`), not the wallet's - between a lot
-- crossing its expiry instant and the next daily sweep run, this predicate
-- keeps the wallet from ever rendering an already-past date ("500 pts expire
-- Mar 3, 2025") for points that are, practically, already gone. The warn
-- job's own soonest-lot lookup (0044) filters identically for the same
-- reason.
create or replace function public.points_next_expiry(
  p_business_id uuid,
  p_consumer_id uuid
) returns table (
  points     integer,
  expires_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select r.remaining, r.expires_at
    from private.points_lot_remainders(p_business_id, p_consumer_id) r
   where r.remaining > 0
     and r.expires_at is not null
     and r.expires_at > now()
   order by r.expires_at asc, r.txn_id asc
   limit 1;
$$;

revoke execute on function public.points_next_expiry(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.points_next_expiry(uuid, uuid)
  to service_role;

-- ---------------------------------------------------------------- expire_points
-- Doc 35 section 7's sweep. Chunked (`p_limit`, default 200 pairs per doc 35's
-- "Chunked 200 pairs/job"), SECURITY DEFINER, service_role only, invoked by
-- pg_cron below exactly as 0016/0028's two sweeps are.
--
-- Returns how many pairs it actually wrote an `expire` row for (not how many
-- candidates it scanned - a candidate whose remainder is already 0 is a
-- correct no-op, not a "processed" pair, mirroring `expire_claims`'s own
-- return-value contract).
create or replace function public.expire_points(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pair      record;
  v_remainder integer;
  v_balance   integer;
  v_expired   integer := 0;
begin
  -- Candidate scan (doc 35 section 7's own pre-filter): a pair with a positive
  -- cached balance that has at least one earn row already past its expiry
  -- cutoff. `for update of bc skip locked` takes the lock on the SAME
  -- business_customers row award_receipt_points/expire_claims take, in the
  -- same position (before any ledger read for the pair), so this sweep can
  -- never deadlock against either and an overlapping sweep run partitions the
  -- backlog instead of blocking on it.
  for v_pair in
    select bc.business_id, bc.consumer_id
      from public.business_customers bc
     where bc.points_balance > 0
       and exists (
         select 1
           from public.points_transactions pt
          where pt.business_id = bc.business_id
            and pt.consumer_id = bc.consumer_id
            and pt.type = 'earn'
            and pt.expires_at is not null
            and pt.expires_at <= now()
       )
     order by bc.business_id, bc.consumer_id
     limit p_limit
       for update of bc skip locked
  loop
    -- The shared formula, asof now(): doc 35 section 7's X(t) - D(t), floored
    -- at 0, computed under the row lock just taken above so nothing else can
    -- move this pair's balance between this read and the write below.
    v_remainder := private.points_expirable_remainder(v_pair.business_id, v_pair.consumer_id, now());
    if v_remainder > 0 then
      select bc.points_balance
        into v_balance
        from public.business_customers bc
       where bc.business_id = v_pair.business_id
         and bc.consumer_id = v_pair.consumer_id;

      -- Defense in depth (doc 35 section 7's own clamp restated, never
      -- trusted blindly - see the header): the ledger must never be driven
      -- negative, exactly the invariant `award_receipt_points`'s clawback
      -- sibling (0031) enforces with the identical `least(...)` shape.
      v_remainder := least(v_remainder, v_balance);

      if v_remainder > 0 then
        insert into public.points_transactions
          (business_id, consumer_id, type, points, balance_after, rule_snapshot)
        values
          (v_pair.business_id, v_pair.consumer_id, 'expire', -v_remainder,
           v_balance - v_remainder,
           jsonb_build_object(
             'engine', 'points/v1',
             'remainder', v_remainder,
             'cutoff', now()
           ));

        update public.business_customers
           set points_balance = v_balance - v_remainder
         where business_id = v_pair.business_id
           and consumer_id = v_pair.consumer_id;

        v_expired := v_expired + 1;
      end if;
    end if;
  end loop;

  return v_expired;
end
$$;

-- System sweep, service_role ONLY, mirroring expire_claims (0016) exactly: no
-- consumer or staff member may ever drain the expiry queue, only the
-- scheduler below (which runs as `postgres`, retaining EXECUTE independently
-- of this revoke - see 0028's own note on cron job ownership).
revoke execute on function public.expire_points(integer) from public, anon, authenticated;
grant execute on function public.expire_points(integer) to service_role;

-- ---------------------------------------------------------------- schedule
-- Doc 39's registered slot: `10 18 * * *` UTC = 02:10 Manila, immediately
-- after the daily rollup (01:40) and before the balance-check sample (02:40) -
-- the same offset-staggering discipline 0028 documents for its own two jobs.
-- `cron.schedule` upserts on (jobname, username), so replaying this migration
-- updates the existing job rather than duplicating it (0028's own note).
select cron.schedule(
  'points.expiry_sweep',
  '10 18 * * *',
  $job$select public.expire_points(200);$job$
);
