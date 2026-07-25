-- ============================================================================
-- 0023_record_receipt_visit.sql
-- The CRM half of the award transaction, extracted so a ZERO-POINT approval
-- can perform it too.
--
-- THE DEFECT THIS FIXES. Every business_customers counter (visit_count,
-- lifetime_spend_centavos, first_visit_at, last_visit_at) and the existence of
-- the pair row itself were maintained ONLY inside step 6 of
-- 0018_award_receipt_points.sql. A zero-point approval skips that RPC by
-- design (0018 step 1 refuses p_points <= 0, and a business with no active
-- base rule prices a genuine purchase at nothing), so for such a tenant:
--   * the portal's customer list, lifetime spend and last-visit sort never
--     advance, even though approved receipts keep arriving;
--   * visit_count stays 0, so the pure engine's isFirstVisit is permanently
--     true for that pair. The day the owner configures a first_visit bonus
--     rule, EVERY existing customer collects it on their next receipt. That is
--     real money paid on a false premise, which is why this is a defect fix
--     and not a tidy-up.
--
-- Source docs:
--   * docs/30-modules/35-points-engine.md section 3 step 10 (counter
--     maintenance), section 5 (the pair row lock)
--   * docs/30-modules/36-receipt-ocr-pipeline.md Stage 10 (handoff contract)
--   * docs/30-modules/40-analytics.md "Timezone rule" + "Event taxonomy" (the
--     VISIT definition and the event_ts fallback to created_at)
--
-- WHAT THIS FILE DOES:
--   1. adds receipts.visit_recorded_at, the idempotency marker (see below);
--   2. extracts 0018 step 6 verbatim into private.apply_receipt_visit(uuid),
--      the ONE implementation of visit and spend maintenance;
--   3. re-creates public.award_receipt_points to call it, so the award path
--      and the visit path can never drift;
--   4. adds public.record_receipt_visit(uuid), the ledger-free entry point the
--      zero-point path calls.
--
-- Conventions per 0013/0016/0018: security definer, set search_path = '',
-- every reference schema-qualified, stable message strings raised with
-- errcode = 'P0001', revoke/grant pairing at the bottom, service_role only.
--
-- ERROR TAXONOMY: deliberately NO new message strings. record_receipt_visit
-- raises only RECEIPT_NOT_AWARDABLE, AWARD_RECEIPT_ID_REQUIRED and
-- CUSTOMER_RECORD_MISSING, all of them 0018's, so the service layer keeps one
-- map (src/features/receipts/server/award.ts AWARD_ERROR_HANDLING).
-- ============================================================================

-- ------------------------------------------------------------ idempotency marker
-- amendment: the obvious idempotency signal is receipts.processed_at ("is this
-- receipt already finished?"), and it does not work. processed_at is written
-- on EVERY terminal pipeline outcome, including 'review' (doc 52 defines scan
-- e2e latency as processed_at - created_at "for receipts reaching
-- approved/review/rejected"), so a receipt routed to a human already carries
-- one before the reviewer ever approves it. Guarding on processed_at would
-- make record_receipt_visit a silent no-op for exactly the receipts the human
-- review queue approves, which is the defect above wearing a different hat.
--
-- visit_recorded_at states the fact that actually matters: this receipt's
-- spend and visit have already been folded into its pair row. It is written by
-- private.apply_receipt_visit and by nothing else, so both RPCs are idempotent
-- against each other as well as against themselves:
--   * a replayed record_receipt_visit adds no second visit and no second
--     spend, and does not re-stamp processed_at either;
--   * an award that follows an earlier zero-point visit record still mints
--     points (the ledger's own one-earn-per-receipt guard is what governs
--     that) but does not add the same receipt's spend twice.
-- No client role can read it: 0017 replaced the table-level select grant on
-- receipts with an explicit column list, so a column added here is invisible
-- to anon and authenticated until someone deliberately grants it.
alter table public.receipts
  add column if not exists visit_recorded_at timestamptz;

comment on column public.receipts.visit_recorded_at is
  'When this receipt was folded into business_customers (spend, visit_count, visit timestamps). Written only by private.apply_receipt_visit; the idempotency marker shared by award_receipt_points and record_receipt_visit.';

-- Backfill: every receipt that already carries an earn row went through 0018
-- step 6, so its visit IS recorded. Without this, a record_receipt_visit call
-- against such a receipt would add its spend a second time. processed_at is
-- the timestamp 0018 stamped in that same transaction; now() only covers a row
-- whose processed_at was somehow lost.
update public.receipts r
   set visit_recorded_at = coalesce(r.processed_at, now())
 where r.visit_recorded_at is null
   and exists (
     select 1 from public.points_transactions pt
      where pt.receipt_id = r.id
        and pt.type = 'earn'
   );

-- ---------------------------------------------------------- apply_receipt_visit
-- 0018 step 6, extracted unchanged. THE one implementation of the doc 40 visit
-- rule and of spend accumulation; award_receipt_points and record_receipt_visit
-- both call it and neither one restates it.
--
-- PRECONDITIONS the caller must satisfy, in this order (both callers do):
--   1. public.receipts row for p_receipt_id loaded "for update";
--   2. the public.business_customers pair row ensured (insert ... on conflict
--      do nothing) and locked "for update".
-- The function therefore re-reads both rows without a lock clause: they are
-- already locked by this transaction, and re-reading is what keeps the field
-- derivation (event_ts fallback, spend coalesce) identical for both callers
-- rather than passed in twice and drifting.
--
-- Returns true when it applied the maintenance, false when this receipt was
-- already recorded. Security invoker on purpose: it is only ever called from
-- inside a security-definer function, so it runs with that function's owner
-- rights, and it is not reachable from PostgREST (the private schema is not
-- exposed) nor executable by any app role (revoked at the bottom).
create or replace function private.apply_receipt_visit(p_receipt_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_receipt       record;
  v_last_visit_at timestamptz;
  v_event_ts      timestamptz;  -- doc 40 event_ts for this receipt
  v_event_day     date;         -- its Asia/Manila calendar day
  v_last_day      date;         -- Manila day of the pair's last_visit_at
  v_visit_delta   integer;      -- 0 or 1, per the doc 40 VISIT definition
begin
  select r.business_id, r.user_id, r.receipt_date, r.created_at,
         r.total_centavos, r.visit_recorded_at
    into v_receipt
    from public.receipts r
   where r.id = p_receipt_id;

  -- Already folded in. Harmless second call: no counter moves, no timestamp is
  -- rewritten, and the caller decides what to do with the false.
  if not found or v_receipt.visit_recorded_at is not null then
    return false;
  end if;

  select bc.last_visit_at
    into v_last_visit_at
    from public.business_customers bc
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id;
  -- Defence in depth, mirroring 0013/0016/0018: the caller's upsert guarantees
  -- the row, and a missing one must never be silently skipped.
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

  -- ---- visit-day resolution (doc 40 canon) ----
  -- Doc 40 "Timezone rule": for receipts, event_ts = receipt_date when parsed,
  -- else created_at (submission time).
  --
  -- receipt_date CAN be null: doc 36 Stage 8 accepts a receipt carrying a
  -- total plus EITHER a date OR a receipt number, so a dateless-but-valid
  -- receipt reaches this function. Falling back to created_at is doc 40's own
  -- rule, and it is the only choice that keeps visit_count consistent with the
  -- analytics rollup, which computes
  -- count(distinct manila_day(coalesce(receipt_date, created_at))).
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
  -- amendment (backdated receipts), carried over from 0018: the increment
  -- fires only when the event day is STRICTLY LATER than the Manila day of
  -- last_visit_at, not merely "different". A <>-based test would let
  -- out-of-order receipts (max_age_days allows backdating) inflate the counter
  -- without limit, which is the receipt-splitting attack the doc 40 rule
  -- exists to stop. Strictly-later is monotone and can only ever UNDERcount,
  -- and doc 40 makes the receipts table the reporting truth, so the dashboard
  -- number self-heals while a minted extra visit would not.
  v_visit_delta := case
                     when v_last_day is null then 1
                     when v_event_day > v_last_day then 1
                     else 0
                   end;

  -- lifetime_spend_centavos: coalesce because total_centavos is nullable on
  -- receipts. A receipt with no total should not have been approved (doc 36
  -- Stage 8 requires it), so 0 records "no spend evidence" rather than
  -- aborting.
  --
  -- first_visit_at: set once, never rewritten (doc 40 "New customer" cohorts
  -- are keyed off it).
  --
  -- amendment (last_visit_at), carried over from 0018: doc 35 section 3 step
  -- 10 says "last_visit_at = receipt_date" flatly. Written as greatest() so a
  -- backdated receipt cannot drag the column backwards; it is the sort key of
  -- bc_business_lastvisit_idx and the anchor of the visit-day comparison
  -- above, and moving it back would re-open a Manila day that was already
  -- counted. greatest() ignores nulls in Postgres, so the first-ever call
  -- still lands on v_event_ts.
  --
  -- points_balance and lifetime_points are deliberately NOT touched here: they
  -- belong to the ledger, and the whole point of this extraction is that a
  -- visit can be recorded when no points moved.
  update public.business_customers bc
     set lifetime_spend_centavos = bc.lifetime_spend_centavos
                                     + coalesce(v_receipt.total_centavos, 0),
         first_visit_at          = coalesce(bc.first_visit_at, v_event_ts),
         last_visit_at           = greatest(bc.last_visit_at, v_event_ts),
         visit_count             = bc.visit_count + v_visit_delta
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id;

  update public.receipts
     set visit_recorded_at = now()
   where id = p_receipt_id;

  return true;
end
$$;

revoke execute on function private.apply_receipt_visit(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------- award_receipt_points
-- Re-created from the live definition (pg_get_functiondef) with exactly one
-- change: step 6's visit and spend maintenance is now the shared helper above,
-- and the balance write is the only thing left in this function's own UPDATE.
-- Every guard, every lock, and the lock ORDER are unchanged.
--
-- LOCK ORDER (deadlock analysis against the other ledger writers):
--   claim_reward   (0013): business_customers -> campaigns (only when a cap is
--                          configured) -> rewards
--   expire_claims  (0016): reward_claims -> business_customers -> rewards
--   this function:         receipts -> business_customers
--   record_receipt_visit:  receipts -> business_customers (identical)
-- business_customers is the only object shared with either of them, and it is
-- never held while waiting for anything else those functions also take, so no
-- lock cycle exists. receipts is taken first because it is the driving row and
-- locking it before the pair row makes a concurrent second award of the SAME
-- receipt block at step 2 rather than racing the pt_receipt_earn_once index.
--
-- BALANCE-CACHE FENCE (0013 bottom): table-level UPDATE on business_customers
-- is revoked from anon/authenticated and only (segment, notes, updated_by) is
-- granted back, so no client can mint a points_balance without a ledger row
-- behind it. This function writes points_balance and lifetime_points and its
-- helper writes the CRM counters, which is exactly why it is SECURITY DEFINER:
-- it runs as the table owner (postgres), for whom that fence does not apply.
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
  -- which is what keeps ledger order per pair strictly serialized.
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
  -- now the shared helper so this path and record_receipt_visit cannot drift.
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

-- ---------------------------------------------------------- record_receipt_visit
-- The zero-point counterpart of award_receipt_points: the same guards, the
-- same lock order, the same helper, and NO ledger write at all.
--
-- Called by src/features/receipts/server/award.ts on the path where a genuine,
-- approved purchase prices at zero points (no active base rule, an earning
-- floor the receipt does not clear, a tier table that stops below this amount).
-- The receipt is a real purchase and the pair row must reflect it.
--
-- amendment (no blacklist check, unlike award_receipt_points): doc 35 section
-- 12 scopes CUSTOMER_BLACKLISTED to "blocks earn/claim/redeem" and nothing
-- moves here. Refusing would leave a blacklisted consumer's pair row stale
-- forever, including visit_count = 0, which is precisely the first_visit
-- mispayment this migration exists to prevent. No points can reach them
-- regardless: award_receipt_points still refuses them at the same gate.
create or replace function public.record_receipt_visit(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt record;
  v_locked  integer;
begin
  if p_receipt_id is null then
    raise exception using errcode = 'P0001', message = 'AWARD_RECEIPT_ID_REQUIRED';
  end if;

  -- Step 1: load and lock the receipt, identical to 0018 step 2 including the
  -- single RECEIPT_NOT_AWARDABLE message, so callers handle one taxonomy.
  select r.id, r.business_id, r.user_id, r.status
    into v_receipt
    from public.receipts r
   where r.id = p_receipt_id
     for update;
  if not found
     or v_receipt.status <> 'approved'
     or v_receipt.business_id is null
     or v_receipt.user_id is null then
    raise exception using errcode = 'P0001', message = 'RECEIPT_NOT_AWARDABLE';
  end if;

  -- Step 2: ensure and lock the pair row, in the SAME order and with the same
  -- upsert-then-lock shape as 0018 step 4. This is the statement that makes an
  -- unconfigured tenant's customer appear in the portal at all.
  insert into public.business_customers (business_id, consumer_id)
  values (v_receipt.business_id, v_receipt.user_id)
  on conflict (business_id, consumer_id) do nothing;

  select 1
    into v_locked
    from public.business_customers bc
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

  -- Step 3: the shared maintenance, and processed_at only when it actually
  -- ran. A replay finds visit_recorded_at already set, changes nothing, and
  -- leaves the original processed_at in place rather than moving a monitoring
  -- timestamp forward for work that did not happen (doc 52 measures scan e2e
  -- latency from it).
  if private.apply_receipt_visit(p_receipt_id) then
    update public.receipts
       set processed_at = now()
     where id = p_receipt_id;
  end if;
end
$$;

-- System function, service_role ONLY, mirroring 0016 and 0018. It writes CRM
-- counters that the 0013 balance-cache fence keeps out of client hands, so no
-- consumer and no staff member may call it; the only callers are the receipt
-- pipeline and the human review service, both under the service key.
revoke execute on function public.record_receipt_visit(uuid) from public, anon, authenticated;
grant execute on function public.record_receipt_visit(uuid) to service_role;
