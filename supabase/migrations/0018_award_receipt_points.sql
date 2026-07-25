-- ============================================================================
-- 0018_award_receipt_points.sql
-- The award transaction: the SECOND and LAST place in the system that writes
-- the points_transactions ledger (0013 claim_reward / 0016 expire_claims are
-- the other write paths, both on the redeem side). Called by the receipt
-- processing pipeline once a receipt reaches status='approved'.
-- Source docs:
--   * docs/30-modules/35-points-engine.md section 3 (award pipeline steps
--     8-10: row lock, earn insert, business_customers counter maintenance),
--     section 5 (the row lock IS the correctness guarantee for balance_after),
--     section 1 principle 3 (one earn per receipt, pt_receipt_earn_once),
--     section 11 (rule math is the shared pure TS function, never SQL)
--   * docs/30-modules/36-receipt-ocr-pipeline.md Stage 10 (handoff contract:
--     earn row with receipt_id provenance + rule_snapshot, business_customers
--     update, receipts.processed_at, all in one transaction)
--   * docs/30-modules/40-analytics.md "Timezone rule" + "Event taxonomy":
--     the VISIT definition this function's visit_count logic implements
--   * docs/20-data/23-schema-campaigns.md (points_transactions shape,
--     pt_receipt_earn_once, business_customers counters)
-- Conventions per 0013/0016: security definer, set search_path = '', every
-- reference schema-qualified, stable message strings raised with
-- errcode = 'P0001' that the service layer maps to consumer-safe copy
-- (src/features/rewards/server/service.ts is the existing example of that
-- mapping), revoke/grant pairing at the bottom.
--
-- What this function deliberately does NOT do:
--   * no rule math. Doc 35 section 11 requires ONE implementation of the
--     base/multiplier/bonus/rounding computation, and it is the pure TS
--     computePoints() that also powers the consumer's optimistic preview.
--     p_points arrives already computed and is written verbatim.
--   * no loyalty_cards advancement (doc 35 section 3 step 11). No card rows
--     exist until the loyalty slice; adding it later is additive.
--   * no notification enqueue. That is the caller's job, after commit.
-- ============================================================================

-- ---------------------------------------------------------------- manila_day
-- Doc 40 "Timezone rule (canon)": the day of any event is
-- (event_ts at time zone 'Asia/Manila')::date, "wrapped as
-- private.manila_day(timestamptz) (immutable SQL function) so live queries and
-- rollups can never disagree". The analytics slice has not landed yet, so the
-- helper is created here rather than duplicating the expression: the visit
-- rule below and the future rollup MUST use one definition, or visit_count and
-- analytics_daily_business.visits will drift apart silently.
--
-- Immutable is correct: Asia/Manila is UTC+8 with no DST, and the two-argument
-- timezone() this expands to is itself immutable. Null in, null out (called
-- below on a nullable last_visit_at).
create or replace function private.manila_day(p_ts timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$
  select (p_ts at time zone 'Asia/Manila')::date;
$$;

-- Read-only date helper with no table access: safe to expose to the app roles
-- that will group by it (doc 40 "Business analytics - exact formulas"), same
-- posture as private.immutable_unaccent in 0001.
grant execute on function private.manila_day(timestamptz) to authenticated, anon, service_role;

-- ---------------------------------------------------------------- award_receipt_points
-- Doc 36 Stage 10 handoff, doc 35 section 3 steps 8-10, one transaction.
--
-- LOCK ORDER (deadlock analysis against the other two ledger writers):
--   claim_reward   (0013): business_customers -> campaigns (only when a cap is
--                          configured) -> rewards
--   expire_claims  (0016): reward_claims -> business_customers -> rewards
--   this function:         receipts -> business_customers
-- business_customers is the only object this function shares with either of
-- them, and it is never held while waiting for anything else those functions
-- also take, so no lock cycle exists. receipts is taken first for the same
-- reason expire_claims takes reward_claims first: it is the driving row, it is
-- touched by neither of the other RPCs, and locking it before the pair row
-- makes a concurrent second award of the SAME receipt block at step 2 rather
-- than racing to the pt_receipt_earn_once unique index.
--
-- BALANCE-CACHE FENCE (0013 bottom): table-level UPDATE on
-- business_customers is revoked from anon/authenticated and only
-- (segment, notes, updated_by) is granted back, so no client can mint a
-- points_balance without a ledger row behind it. This function writes
-- points_balance, lifetime_points, lifetime_spend_centavos, visit_count and
-- the visit timestamps, which is exactly why it is SECURITY DEFINER: it runs
-- as the table owner (postgres), for whom that fence does not apply, and the
-- fence keeps everyone else out. Same reasoning for the ledger itself: 0012
-- revoked update/delete/truncate and 0013 revoked insert from the client
-- roles, so the only INSERT path into points_transactions is a definer
-- function like this one.
create or replace function public.award_receipt_points(
  p_receipt_id    uuid,
  p_points        integer,
  p_rule_snapshot jsonb       default null,
  p_campaign_id   uuid        default null,
  p_expires_at    timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt       record;
  v_prev_balance  integer;
  v_segment       text;
  v_last_visit_at timestamptz;
  v_event_ts      timestamptz;  -- doc 40 event_ts for this receipt
  v_event_day     date;         -- its Asia/Manila calendar day
  v_last_day      date;         -- Manila day of the pair's last_visit_at
  v_visit_delta   integer;      -- 0 or 1, per the doc 40 VISIT definition
  v_txn_id        uuid;
begin
  -- Step 1: defensive input validation. p_points is computed upstream by the
  -- pure engine, so anything <= 0 here is a bug in the caller, not a business
  -- outcome: 0 would violate the points <> 0 check anyway, and a NEGATIVE
  -- value would be a silent clawback entering through the earn door - it
  -- would decrease points_balance while writing type='earn' and inflating
  -- lifetime_points. Refused loudly instead.
  if p_receipt_id is null then
    raise exception using errcode = 'P0001', message = 'AWARD_RECEIPT_ID_REQUIRED';
  end if;
  if p_points is null or p_points <= 0 then
    raise exception using errcode = 'P0001', message = 'AWARD_POINTS_INVALID';
  end if;

  -- Step 2: load and lock the receipt. "for update" serializes two concurrent
  -- awards of the same receipt here, so the duplicate check in step 3 is a
  -- real guard rather than an advisory one.
  select r.id, r.business_id, r.user_id, r.status, r.receipt_date,
         r.created_at, r.total_centavos
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
  -- unique index pt_receipt_earn_once (unique (receipt_id) where type='earn',
  -- verified live) is the real backstop; this explicit check exists so a
  -- replayed job gets a clean, mappable RECEIPT_ALREADY_AWARDED instead of a
  -- raw 23505 unique_violation the service layer would have to string-match.
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
  -- which is what keeps ledger order per pair strictly serialized.
  -- auth.uid() is null under service_role, so created_by/updated_by stay null,
  -- which 0012 documents as "system" (identical to expire_claims).
  insert into public.business_customers (business_id, consumer_id)
  values (v_receipt.business_id, v_receipt.user_id)
  on conflict (business_id, consumer_id) do nothing;

  select bc.points_balance, bc.segment, bc.last_visit_at
    into v_prev_balance, v_segment, v_last_visit_at
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
  -- that "blocks earn/claim/redeem"; the design spec's abbreviated step list
  -- (2026-07-25-receipts-award-design.md section 3.2) omits it. Implemented
  -- here because this is the last gate before points are minted and the check
  -- is free under a lock we already hold. Read under the pair lock, exactly as
  -- claim_reward reads it. The sibling guard "business active" is deliberately
  -- NOT implemented: businesses start at status='draft' (0003
  -- register_business) and no error code is registered for it on the earn
  -- path, so enforcing it here would strand approved receipts of every
  -- unverified tenant.
  if v_segment = 'blacklisted' then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_BLACKLISTED';
  end if;

  -- ---- visit-day resolution (doc 40 canon), used by steps 5 and 6 ----
  -- Doc 40 "Timezone rule": for receipts, event_ts = receipt_date when parsed,
  -- else created_at (submission time).
  --
  -- receipt_date CAN be null: doc 36 Stage 8 accepts a receipt carrying a
  -- total plus EITHER a date OR a receipt number, so a dateless-but-valid
  -- receipt reaches this function. Falling back to created_at is doc 40's own
  -- rule, not an invention here, and it is the only choice that keeps
  -- visit_count consistent with the analytics rollup, which computes
  -- count(distinct manila_day(coalesce(receipt_date, created_at))) from the
  -- receipts table. Leaving the visit timestamps null instead would make a
  -- dateless approved receipt invisible to retention and new-vs-returning
  -- reporting.
  v_event_ts  := coalesce(v_receipt.receipt_date, v_receipt.created_at);
  v_event_day := private.manila_day(v_event_ts);
  v_last_day  := private.manila_day(v_last_visit_at);  -- null when never visited

  -- Doc 40 VISIT definition: "A distinct (user_id, business_id, manila_day)
  -- with >= 1 approved receipt. Multiple same-day approved receipts at the
  -- same business = 1 visit ... splitting one purchase into three receipts
  -- buys points, never extra visits."
  --
  -- The comparison MUST happen in Asia/Manila, not UTC: Manila is UTC+8, so a
  -- receipt at 2026-07-25T17:00Z is 2026-07-26 01:00 Manila and is a DIFFERENT
  -- visit day from one at 2026-07-25T10:00Z, while a naive
  -- date_trunc('day', ...) in UTC would call them the same day and lose the
  -- visit. Manila has no DST, so a fixed-offset comparison is exact.
  --
  -- amendment (backdated receipts): the increment fires only when the event
  -- day is STRICTLY LATER than the Manila day of last_visit_at, not merely
  -- "different". Doc 35 section 3 step 10 says only "visit-day logic". A
  -- <>-based test would let an out-of-order receipt (max_age_days allows up to
  -- 3 days of backdating) inflate the counter without limit: award a receipt
  -- dated today, then submit three receipts all dated yesterday and each one
  -- differs from last_visit_at's day and each one adds a visit - the exact
  -- receipt-splitting attack the doc 40 rule exists to stop. Strictly-later is
  -- monotone, cannot be gamed, and can only ever UNDERcount (a genuine
  -- earlier day submitted out of order). That trade is right because
  -- business_customers.visit_count is a cache: doc 40 makes the receipts table
  -- the reporting truth and recomputes visits as a count(distinct manila_day),
  -- so the dashboard number self-heals; a minted extra visit would not.
  v_visit_delta := case
                     when v_last_day is null then 1
                     when v_event_day > v_last_day then 1
                     else 0
                   end;

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

  -- Step 6: the CRM counters, same transaction (doc 35 section 3 step 10,
  -- doc 40 "Points engine -> CRM counter maintenance ... same-transaction").
  --
  -- lifetime_spend_centavos: coalesce because total_centavos is nullable on
  -- receipts. A receipt with no total should not have been approved (doc 36
  -- Stage 8 requires it), so 0 records "no spend evidence" rather than
  -- aborting an award whose points are already computed.
  --
  -- first_visit_at: set once, never rewritten (doc 40 "New customer" cohorts
  -- are keyed off it; rewriting it would move a consumer between cohorts
  -- retroactively).
  --
  -- amendment (last_visit_at): doc 35 section 3 step 10 says
  -- "last_visit_at = receipt_date" flatly. Written as greatest() instead so a
  -- backdated receipt cannot drag the column backwards - it names the most
  -- recent visit, is the sort key of bc_business_lastvisit_idx (the portal's
  -- "recent customers" list), and is the anchor of the visit-day comparison
  -- above; moving it back would re-open a Manila day that was already counted
  -- and let the next same-day receipt add a second visit. greatest() ignores
  -- nulls in Postgres, so the first-ever award still lands on v_event_ts.
  update public.business_customers bc
     set points_balance          = v_prev_balance + p_points,
         lifetime_points         = bc.lifetime_points + p_points,
         lifetime_spend_centavos = bc.lifetime_spend_centavos
                                     + coalesce(v_receipt.total_centavos, 0),
         first_visit_at          = coalesce(bc.first_visit_at, v_event_ts),
         last_visit_at           = greatest(bc.last_visit_at, v_event_ts),
         visit_count             = bc.visit_count + v_visit_delta
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id;

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

-- System function, service_role ONLY, mirroring 0016_claim_expiry_sweep.
-- Deliberately narrower than claim_reward / validate_redemption (granted to
-- authenticated in 0013): this function mints points, so no consumer and no
-- staff member may ever call it. The only caller is the receipt processing
-- pipeline running under the service key, after the fraud stage has completed
-- (doc 36: "Fraud always completes before award; there is no award-then-check
-- path").
revoke execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz)
  to service_role;
