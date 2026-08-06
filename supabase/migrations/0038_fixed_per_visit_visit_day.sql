-- ============================================================================
-- 0038_fixed_per_visit_visit_day.sql
-- Review fix (task 1.1, C1): the fixed_per_visit dedupe must key on VISIT
-- DAY, not processing time.
--
-- THE DEFECT 0037 LEFT. Its guard compared `manila_day(pt.created_at)`
-- (when the earn ROW was WRITTEN) to `manila_day(now())` (when THIS call
-- runs) - both processing-time instants. Doc 35 defines fixed_per_visit per
-- VISIT DAY and says conditions are evaluated at `receipts.receipt_date`,
-- "never at processing time"; `private.apply_receipt_visit` (0023) already
-- keys visit_count on `manila_day(coalesce(receipt_date, created_at))`. Two
-- concrete failures followed from the processing-time key:
--   (a) OVER-AWARD still live: a human-reviewed receipt approved a day (or
--       more) after the auto-approved receipt of the SAME visit day has a
--       different `manila_day(now())` at award time, so 0037's check never
--       finds the earlier earn and pays the fixed base again.
--   (b) NEW UNDER-AWARD: two backdated receipts (e.g. Monday's and Tuesday's
--       paper receipts) uploaded together on the SAME Wednesday would both
--       get earn rows with `created_at` on Wednesday, so 0037's same-"today"
--       check would find the first and wrongly suppress the second even
--       though they are genuinely different visit days.
--
-- THE FIX. `private.fixed_per_visit_already_paid(business, consumer,
-- visit_day)` answers the real question: does a PAID fixed_per_visit earn
-- already exist for this exact visit day, where visit day is
-- `manila_day(coalesce(receipts.receipt_date, points_transactions.created_at))`
-- for the RECEIPT the earn came from (join on receipt_id, which 0017 made a
-- real foreign key). "Paid" excludes an earn whose own base was itself
-- deduped to 0 (I3): a prior receipt on the SAME visit day that only
-- collected an independent bonus must not suppress this one's base too.
--
-- ONE PREDICATE, TWO CALLERS. This migration adds a thin PUBLIC wrapper,
-- `public.fixed_per_visit_already_paid`, purely so `src/features/receipts/
-- server/award.ts`'s ADVISORY precheck (an ordinary, unlocked read used to
-- price the common non-racing case correctly up front - see I1 below) and
-- `award_receipt_points`'s own AUTHORITATIVE re-check (run under the
-- `business_customers` lock it already holds, when the caller sets
-- `p_verify_no_prior_fixed_visit_earn`) share the EXACT SAME definition
-- rather than two hand-maintained copies that could drift the way 0037's
-- did. `award_receipt_points`'s signature is UNCHANGED from 0037 (still
-- `(uuid, integer, jsonb, uuid, timestamptz, boolean)`), so this is a plain
-- `create or replace`, no drop needed this time.
--
-- I1 (review, Important): this invariant is caller-opt-in
-- (`p_verify_no_prior_fixed_visit_earn`), unlike every other guard in this
-- function, which is unconditional. That is a deliberate, accepted
-- departure from doc 35's usual posture, not an oversight: the RPC has no
-- way to know a receipt's WINNING base rule is `fixed_per_visit` (that
-- resolution - which points_rules row wins, campaign stacking, conditions -
-- lives entirely in the pure TypeScript engine per doc 35 section 11), so it
-- cannot enforce this invariant unconditionally without either duplicating
-- rule resolution in SQL or blocking every other rule_type's award on an
-- irrelevant check. The invariant therefore lives in TypeScript
-- (`priceReceipt`'s precheck decides whether the dedupe applies at all) with
-- this SQL function as the race-safe backstop for the one case TypeScript
-- alone cannot close: a concurrent request committing between the precheck
-- and the lock. It sits OUTSIDE the three-layer fence (privilege revocation
-- + row-level lock + explicit guard) that every OTHER ledger invariant in
-- this schema enjoys unconditionally - see supabase/README.md for the
-- companion note.
--
-- Source docs:
--   * docs/30-modules/35-points-engine.md ("fixed_per_visit" per visit-day,
--     "conditions are evaluated at receipts.receipt_date ... never at
--     processing time", section 11 one implementation of the rule math)
--   * supabase/migrations/0017_receipts.sql (the points_transactions.receipt_id
--     foreign key this join relies on)
--   * supabase/migrations/0023_record_receipt_visit.sql (the doc 40 visit-day
--     definition this predicate reuses verbatim)
--   * supabase/migrations/0037_fixed_per_visit_dedup.sql (the mechanism this
--     migration corrects: same parameter, same error code, different key)
-- ============================================================================

-- ---------------------------------------------------------- the shared predicate
-- Read-only, no lock of its own: correctness under concurrency comes from
-- WHERE this is called from (see the two callers below), not from anything
-- in this function. `stable` because it reads tables (results can change
-- between statements, never within one) - `private.manila_day` itself stays
-- `immutable` (0018), which is unaffected by this function's own volatility.
create or replace function private.fixed_per_visit_already_paid(
  p_business_id uuid,
  p_consumer_id uuid,
  p_visit_day   date
) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.points_transactions pt
      join public.receipts r on r.id = pt.receipt_id
     where pt.business_id = p_business_id
       and pt.consumer_id = p_consumer_id
       and pt.type = 'earn'
       and pt.points > 0
       and private.manila_day(coalesce(r.receipt_date, pt.created_at)) = p_visit_day
       and pt.rule_snapshot -> 'base' ->> 'rule_type' = 'fixed_per_visit'
       and coalesce((pt.rule_snapshot -> 'base' ->> 'fixed_per_visit_deduped')::boolean, false)
             = false
  );
$$;

revoke execute on function private.fixed_per_visit_already_paid(uuid, uuid, date)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------- the TypeScript-facing wrapper
-- `private` is not in PostgREST's exposed schema list (same reason
-- `private.manila_day` needs no wrapper of its own for read paths that ARE
-- exposed - see src/features/analytics/manila-day.ts's header), so
-- `priceReceipt`'s advisory precheck needs a `public` entry point.
--
-- SECURITY DEFINER, not invoker: `private.fixed_per_visit_already_paid`
-- above is revoked from every role including service_role (matching
-- `private.apply_receipt_visit`'s own posture - both are helpers meant to be
-- reached only from inside a definer context, never called directly). A
-- plain invoker wrapper would run as service_role and be refused calling the
-- private helper; running as the owner (postgres) here, exactly like
-- `award_receipt_points` does for its own private helper call, is what makes
-- that inner call succeed without loosening the private function's own
-- grants.
create or replace function public.fixed_per_visit_already_paid(
  p_business_id uuid,
  p_consumer_id uuid,
  p_visit_day   date
) returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.fixed_per_visit_already_paid(p_business_id, p_consumer_id, p_visit_day);
$$;

-- Reveals whether a specific consumer has earned at a specific business,
-- which is ledger-adjacent information: service_role only, matching every
-- other RPC in this family.
revoke execute on function public.fixed_per_visit_already_paid(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.fixed_per_visit_already_paid(uuid, uuid, date)
  to service_role;

-- ---------------------------------------------------------- award_receipt_points
-- Re-created from the live 0037 definition. Signature is IDENTICAL (still
-- six parameters, same types), so this is a plain `create or replace`; no
-- drop is needed this time (contrast 0037, which added a parameter and had
-- to drop the old 5-arg overload first). Two changes from 0037, both
-- confined to step 4b:
--   1. step 2's select now also loads receipt_date, alongside created_at
--      already there via the record - needed to compute the receipt's own
--      visit day the same way `private.apply_receipt_visit` does.
--   2. step 4b calls `private.fixed_per_visit_already_paid` with that visit
--      day instead of comparing manila_day(created_at) to manila_day(now()).
-- Every other guard, the lock order, and the FIXED_PER_VISIT_RACE message
-- itself are unchanged.
create or replace function public.award_receipt_points(
  p_receipt_id    uuid,
  p_points        integer,
  p_rule_snapshot jsonb       default null,
  p_campaign_id   uuid        default null,
  p_expires_at    timestamptz default null,
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
  v_visit_day     date;
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
  -- real guard rather than an advisory one. receipt_date is now selected too
  -- (task 1.1 / C1): step 4b needs this receipt's own visit day, and reading
  -- it under the SAME lock this row is already taken under means it cannot
  -- change out from under the check.
  select r.id, r.business_id, r.user_id, r.status, r.receipt_date, r.created_at
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

  -- Step 4b (task 1.1, C1 fix): the race-safe half of fixed_per_visit
  -- dedupe, now keyed on VISIT DAY rather than processing time. Runs only
  -- when the caller's own precheck believed no PAID fixed_per_visit earn
  -- existed yet for this receipt's visit day (see award.ts). This receipt's
  -- own visit day is doc 40's definition, computed under the SAME lock this
  -- row was already loaded under in step 2, so it cannot be read stale.
  if p_verify_no_prior_fixed_visit_earn then
    v_visit_day := private.manila_day(coalesce(v_receipt.receipt_date, v_receipt.created_at));
    if private.fixed_per_visit_already_paid(v_receipt.business_id, v_receipt.user_id, v_visit_day) then
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

-- System function, service_role ONLY, mirroring 0016/0018/0023/0037. Signature
-- unchanged from 0037, so this re-states the existing grant pair rather than
-- widening or narrowing it.
revoke execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean)
  to service_role;
