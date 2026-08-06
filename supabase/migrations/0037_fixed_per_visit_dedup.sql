-- ============================================================================
-- 0037_fixed_per_visit_dedup.sql
-- `fixed_per_visit` pays once per Manila day, not once per receipt (task 1.1).
--
-- THE DEFECT. Doc 35 (docs/30-modules/35-points-engine.md) defines the
-- `fixed_per_visit` rule kind as awarding its `fixed_points` once per
-- visit-day: a visit is one consumer at one business per Asia/Manila calendar
-- day, the same day rule `record_receipt_visit` (0023) already implements for
-- `visit_count`. The engine paid it on every approved receipt instead:
-- `computeBasePoints` returned `fixed_points` unconditionally and nothing in
-- the award path gated on a same-day prior earn. Two receipts scanned the
-- same day at the same shop both paid the fixed amount - a silent
-- over-award.
--
-- THE FIX HAS TWO HALVES, and only one of them lives here.
--   1. The ARITHMETIC (which base rule types the flag affects, what a zeroed
--      base does to stacked multiplier extras, how the decision is recorded
--      on rule_snapshot) is entirely in TypeScript:
--      `computePoints`'s new `dedupeFixedPerVisit` input
--      (src/features/points/compute.ts) and the advisory precheck that sets
--      it (`hasSameDayEarn` in src/features/receipts/server/award.ts). Doc 35
--      section 11 requires exactly one implementation of the rule math, and
--      it is not SQL's.
--   2. RACE SAFETY is this migration's whole job. `priceReceipt`'s precheck
--      is an ordinary, unlocked read: two concurrent receipts for the same
--      (business, consumer) pair could both read "no prior earn today" before
--      either commits, and both would then price the full fixed amount.
--      `award_receipt_points` already takes `business_customers` `for
--      update` (0018 step 4) to serialize concurrent awards for one pair, so
--      that lock is where the authoritative re-check belongs. This migration
--      adds exactly one new parameter, `p_verify_no_prior_fixed_visit_earn`
--      (default false, so every existing caller is unaffected), and one new
--      guard that runs only when the caller sets it: under the lock already
--      held, does a positive earn transaction for this pair already exist
--      with `private.manila_day(created_at) = private.manila_day(now())`? If
--      so, this call raises `FIXED_PER_VISIT_RACE` rather than mint a second
--      full award - the caller's own precheck priced this receipt on a stale
--      belief. `award.ts` only ever sets the flag `true` when its precheck
--      believed NO prior earn existed (the dangerous direction); when the
--      precheck already found one and priced accordingly (0, or an
--      independent bonus alone), the flag stays false, because re-verifying
--      would find that SAME prior earn and wrongly refuse a legitimate,
--      already-deduped award.
--
-- WHY REFUSE RATHER THAN SELF-CORRECT. Recomputing the correct deduped total
-- here would mean a second implementation of the base/multiplier/bonus
-- arithmetic in SQL, which is precisely what doc 35 section 11 forbids and
-- what keeps the consumer's optimistic preview and this award from ever
-- disagreeing. A refusal costs one receipt an operator has to revisit
-- (status stays 'approved', processed_at stays null - the same shape every
-- other award refusal already leaves); over-awarding costs a real, silent,
-- unrecoverable balance drift on a ledger. This trade is the same one 0018's
-- own header already accepts ("over-award is the expensive direction to be
-- wrong in").
--
-- WHAT DOES NOT CHANGE. Every existing guard (one-earn-per-receipt,
-- balance_after >= 0 by construction under the lock, the blacklist check, the
-- strictly-later visit day rule) and the lock order are unchanged: this is
-- the same function, re-created from the live 0023 definition with exactly
-- one new parameter and one new check inserted after the blacklist guard and
-- before the earn insert. `record_receipt_visit` is untouched - the dedupe is
-- only ever about whether a fixed_per_visit base contributes to a REAL award;
-- a receipt that already prices at 0 never reaches award_receipt_points at
-- all (see award.ts's existing zero-points branch).
--
-- Source docs:
--   * docs/30-modules/35-points-engine.md ("fixed_per_visit" definition,
--     section 3 award pipeline, section 5 the row lock IS the correctness
--     guarantee, section 11 one implementation of the rule math)
--   * supabase/migrations/0018_award_receipt_points.sql,
--     0023_record_receipt_visit.sql (the function this re-creates, and the
--     doc 40 Asia/Manila visit-day rule / `private.manila_day` it reuses
--     verbatim)
-- ============================================================================

-- Postgres identifies a function by its parameter TYPE list, not by name or
-- defaults; adding a 6th parameter would otherwise leave the old 5-arg
-- overload behind rather than replacing it in place (unlike 0023, which kept
-- 0018's exact signature and could use `create or replace`). Dropped first so
-- there is exactly one `award_receipt_points` afterwards, matching the
-- revoke/grant pair at the bottom.
drop function if exists public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz);

create or replace function public.award_receipt_points(
  p_receipt_id    uuid,
  p_points        integer,
  p_rule_snapshot jsonb       default null,
  p_campaign_id   uuid        default null,
  p_expires_at    timestamptz default null,
  -- task 1.1: ask this call to re-verify, under the business_customers lock
  -- it already takes, that no positive earn exists for this pair earlier the
  -- same Manila day before writing p_points. Default false keeps every
  -- caller pricing a non-fixed_per_visit base (or a fixed_per_visit base
  -- whose own precheck already deduped it) byte-identical to 0023.
  p_verify_no_prior_fixed_visit_earn boolean default false
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt       record;
  v_prev_balance  integer;
  v_segment       text;
  v_txn_id        uuid;
begin
  -- Step 1: defensive input validation. p_points is computed upstream by the
  -- pure engine, so anything <= 0 here is a bug in the caller, not a business
  -- outcome: 0 would violate the points <> 0 check anyway, and a NEGATIVE
  -- value would be a silent clawback entering through the earn door - it
  -- would decrease points_balance while writing type='earn' and inflating
  -- lifetime_points. Refused loudly instead. A receipt that legitimately
  -- prices at zero calls public.record_receipt_visit instead of this function.
  if p_receipt_id is null then
    raise exception using errcode = 'P0001', message = 'AWARD_RECEIPT_ID_REQUIRED';
  end if;
  if p_points is null or p_points <= 0 then
    raise exception using errcode = 'P0001', message = 'AWARD_POINTS_INVALID';
  end if;

  -- Step 2: load and lock the receipt. "for update" serializes two concurrent
  -- awards of the same receipt here, so the duplicate check in step 3 is a
  -- real guard rather than an advisory one.
  select r.id, r.business_id, r.user_id, r.status
    into v_receipt
    from public.receipts r
   where r.id = p_receipt_id
     for update;
  -- One message for "no such receipt" and for every not-awardable state: the
  -- caller is trusted server code, and a single code keeps the pipeline's
  -- error handling honest (it must re-read the receipt to learn more).
  if not found
     or v_receipt.status <> 'approved'
     or v_receipt.business_id is null
     or v_receipt.user_id is null then
    raise exception using errcode = 'P0001', message = 'RECEIPT_NOT_AWARDABLE';
  end if;

  -- Step 3: one earn per receipt (doc 35 section 1 principle 3). The partial
  -- unique index pt_receipt_earn_once (unique (receipt_id) where type='earn')
  -- is the real backstop; this explicit check exists so a replayed job gets a
  -- clean, mappable RECEIPT_ALREADY_AWARDED instead of a raw 23505.
  perform 1
     from public.points_transactions pt
    where pt.receipt_id = p_receipt_id
      and pt.type = 'earn';
  if found then
    raise exception using errcode = 'P0001', message = 'RECEIPT_ALREADY_AWARDED';
  end if;

  -- Step 4: ensure the pair row exists, then lock it (doc 35 section 5). This
  -- is the same upsert-then-lock shape as claim_reward, and the same lock
  -- position relative to business_customers, so the two can interleave on one
  -- pair without deadlocking. balance_after below is computed under this lock,
  -- which is what keeps ledger order per pair strictly serialized. It is also
  -- the lock the step 4b dedupe re-check below relies on for race safety.
  -- auth.uid() is null under service_role, so created_by/updated_by stay null,
  -- which 0012 documents as "system" (identical to expire_claims).
  insert into public.business_customers (business_id, consumer_id)
  values (v_receipt.business_id, v_receipt.user_id)
  on conflict (business_id, consumer_id) do nothing;

  select bc.points_balance, bc.segment
    into v_prev_balance, v_segment
    from public.business_customers bc
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id
     for update;
  -- Defence in depth, mirroring 0013/0016: the insert above guarantees the
  -- row, and a null balance must never reach the balance_after arithmetic.
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

  -- amendment: doc 35 section 3 step 2 lists "consumer not blacklisted" among
  -- the award guards and section 12 registers CUSTOMER_BLACKLISTED as the code
  -- that "blocks earn/claim/redeem". Implemented here because this is the last
  -- gate before points are minted and the check is free under a lock we
  -- already hold. Read under the pair lock, exactly as claim_reward reads it.
  -- The sibling guard "business active" is deliberately NOT implemented:
  -- businesses start at status='draft' (0003 register_business) and no error
  -- code is registered for it on the earn path, so enforcing it here would
  -- strand approved receipts of every unverified tenant.
  if v_segment = 'blacklisted' then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_BLACKLISTED';
  end if;

  -- Step 4b (task 1.1, NEW): the race-safe half of fixed_per_visit dedupe.
  -- Runs only when the caller's own precheck believed this receipt was the
  -- first same-day earn for this pair (see award.ts). Under the SAME
  -- business_customers lock taken above, re-check the fact the precheck read
  -- unlocked: does a positive earn already exist for this pair with the SAME
  -- Manila day as now()? "now", not the receipt's own event day - this
  -- guards processing-time concurrency, not backdating, and mirrors the
  -- brief's own wording exactly ("private.manila_day(created_at) of any
  -- prior earn == manila_day of now"). If one is found, the caller's p_points
  -- was priced on a stale belief (a concurrent receipt for this pair
  -- committed its own earn between the precheck and this lock): refused
  -- rather than minted, so the ledger never has to unwind a second
  -- fixed_per_visit base for the same Manila day.
  if p_verify_no_prior_fixed_visit_earn then
    perform 1
       from public.points_transactions pt
      where pt.business_id = v_receipt.business_id
        and pt.consumer_id = v_receipt.user_id
        and pt.type = 'earn'
        and pt.points > 0
        and private.manila_day(pt.created_at) = private.manila_day(now())
      limit 1;
    if found then
      raise exception using errcode = 'P0001', message = 'FIXED_PER_VISIT_RACE';
    end if;
  end if;

  -- Step 5: the earn row. points and balance_after are integers by column
  -- type; balance_after is computed from the balance read under the lock
  -- above, so concurrent awards for the same pair produce a strictly
  -- increasing, gap-free chain. rule_snapshot is frozen documentation of how
  -- p_points was computed (doc 35 section 3 "frozen shape") and is never
  -- re-executed. expires_at comes from the base rule's expiry policy; null
  -- means never expires.
  insert into public.points_transactions
    (business_id, consumer_id, type, points, balance_after,
     receipt_id, campaign_id, rule_snapshot, expires_at)
  values
    (v_receipt.business_id, v_receipt.user_id, 'earn', p_points,
     v_prev_balance + p_points,
     p_receipt_id, p_campaign_id, p_rule_snapshot, p_expires_at)
  returning id into v_txn_id;

  -- Step 6a: the balance cache, under the lock taken in step 4.
  update public.business_customers bc
     set points_balance  = v_prev_balance + p_points,
         lifetime_points = bc.lifetime_points + p_points
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id;

  -- Step 6b: the CRM counters, same transaction (doc 35 section 3 step 10,
  -- doc 40 "Points engine -> CRM counter maintenance ... same-transaction"),
  -- the shared helper so this path and record_receipt_visit cannot drift.
  -- The false branch means this receipt's visit was already recorded by an
  -- earlier zero-point approval; the points above still stand, and the spend
  -- is deliberately not added twice.
  perform private.apply_receipt_visit(p_receipt_id);

  -- Step 7: mark the receipt processed (doc 36 Stage 10). Status stays
  -- 'approved'; processed_at is what distinguishes "approved and paid" from
  -- "approved, award pending" for the pipeline and for support.
  update public.receipts
     set processed_at = now()
   where id = p_receipt_id;

  -- Step 8
  return v_txn_id;
end
$$;

-- System function, service_role ONLY, mirroring 0016/0018/0023. It writes CRM
-- and ledger columns that the 0013 balance-cache fence keeps out of client
-- hands, so no consumer and no staff member may call it; the only callers are
-- the receipt pipeline and the human review service, both under the service
-- key.
revoke execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean)
  to service_role;
