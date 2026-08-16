-- ============================================================================
-- 0078_loyalty_card_progression.sql
-- Task T4.5: doc 35 section 3 step 11 ("Loyalty card update") and doc 35
-- section 9's clawback clause, both of which have been unimplemented since
-- 0012 created the tables they write to.
--
-- THE DEFECT. `public.loyalty_cards` has existed since 0012_campaigns.sql and
-- NOTHING HAS EVER WRITTEN TO IT. The award path carries the acknowledgement
-- twice in its own history - 0018_award_receipt_points.sql:31 ("no
-- loyalty_cards advancement (doc 35 section 3 step 11)") and
-- 0031_admin_access.sql:205 ("no loyalty-card unwind ... There is no
-- loyalty_cards table yet"). Consumers can open /cards and /cards/[cardId]
-- today and see stamp cards that can never fill: the read side shipped, the
-- write side was never built.
--
-- ---------------------------------------------------------------------------
-- PART 1 OF THIS FILE EXISTS BECAUSE THE TABLE CARRIED TWO SCHEMAS
-- ---------------------------------------------------------------------------
-- 0066_loyalty_cards.sql (a later, unrelated track) opens with
-- `create table if not exists public.loyalty_cards (...)`. The table already
-- existed, so that create was a NO-OP - and the `alter table ... add column
-- if not exists` lines that follow it bolted a SECOND, PARALLEL schema onto
-- the same rows:
--
--   |            | doc 35 / 0012                              | 0066                        |
--   |------------|--------------------------------------------|-----------------------------|
--   | identity   | consumer_id (not null)                     | user_id (nullable)          |
--   | program    | program_id (not null) -> loyalty_programs  | -- none --                  |
--   | progress   | progress, completed_count, last_stamp_at   | stamps_count, is_completed, |
--   |            |                                            | completed_at                |
--   | target     | loyalty_programs.target_value              | stamps_target (default 10)  |
--   | prize      | loyalty_programs.reward_id                 | prize_reward_name (free text)|
--
-- The shipped UI read the 0066 columns; doc 35's step 11 writes the 0012
-- ones. Implementing the spec literally on top of that would have produced
-- correct code that changes nothing a consumer can see.
--
-- The 0066 half cannot express this task at all: no program link, no reward
-- link, no reset policy, no per-day cap, and therefore no way to auto-claim
-- the completion prize (which needs `loyalty_programs.reward_id`). doc 35 is
-- authoritative, and BOTH tables were empty (0 rows, verified live
-- 2026-08-16), so the consolidation costs nothing: this migration drops
-- `user_id`, `stamps_count`, `stamps_target`, `prize_reward_name`,
-- `is_completed` and `completed_at` outright. Two identity columns on a
-- money-path table is how the next person writes to the wrong one.
-- `src/features/loyalty/server/repo.ts` and the two card screens are
-- repointed in the same change.
--
-- ---------------------------------------------------------------------------
-- WHY A STAMP LEDGER (`public.loyalty_stamps`) AND NOT JUST COUNTERS
-- ---------------------------------------------------------------------------
-- Two of the required behaviours are not expressible against 0012's columns:
--
--   1. "stamps already today < max_stamps_per_day, where today is
--      Asia/Manila by last_stamp_at". `last_stamp_at` is ONE timestamp. It
--      can answer "was the last stamp today?" and nothing more, so a program
--      with `max_stamps_per_day = 2` (the column's own default is 1, but it
--      is a configurable integer) cannot be metered by it at all.
--
--   2. doc 35 section 9's "unwinds loyalty progress ATTRIBUTABLE TO THE
--      RECEIPT (floor at 0)". The amount a single receipt contributed is
--      program-type-dependent - +1 for a visit, the whole receipt's points
--      for a points_target program, floor(total_centavos/100) for a spend
--      program - and once it is folded into `progress` it is unrecoverable.
--      A clawback with nothing to read cannot unwind the right number, and
--      guessing is how a clawed-back fraudulent receipt keeps its stamp -
--      and the stamp is what buys the prize.
--
-- So each qualifying award writes one `loyalty_stamps` row: which card, which
-- receipt, how much progress it contributed, and the MANILA-DAY KEY it counts
-- against (`event_ts`, the receipt's own event time per doc 40, never
-- processing time). `last_stamp_at` is kept and maintained as doc 35 names it
-- - the most recent stamp's event time - but the metering reads the ledger,
-- of which `last_stamp_at` is simply the maximum. Reversal is `reversed_at`,
-- never a negative row: the same posture 0012 fixes for points_transactions
-- and 0039 fixes for the fixed_per_visit predicate, i.e. a reversed stamp
-- never actually stamped, so it also stops occupying its day's slot.
--
-- ---------------------------------------------------------------------------
-- DECISIONS THIS FILE MAKES THAT DOC 35 DOES NOT SPELL OUT
-- ---------------------------------------------------------------------------
-- (a) `program_type = 'custom'` (allowed by 0012's check constraint) has NO
--     ratified increment in doc 35's table. It stamps nothing rather than
--     defaulting to +1, because a silently-invented increment on a money path
--     is worse than a program that visibly does nothing until its rule is
--     ratified.
-- (b) ONE completion per qualifying receipt, even when the carryover would
--     immediately re-complete the card (target 100, a 350-point receipt).
--     doc 35 states a single conditional, not a loop, and issuing three free
--     prizes off one receipt is not a reading that should be arrived at
--     accidentally.
-- (c) A card whose program does NOT reset and which has reached its target is
--     FINISHED and takes no further stamps. doc 35 says progress "freezes at
--     target" - and a frozen card is, by construction, permanently at
--     `progress >= target_value`, so without this stop EVERY subsequent
--     receipt would re-fire completion and mint another free prize forever.
--     This is the one guard in this file whose absence is unbounded, and
--     `rpc_loyalty_progression_smoke.sql` assertion 31 pins it against a
--     receipt the daily cap demonstrably was NOT refusing.
-- (d) The completion claim does NOT decrement `rewards.remaining` and does
--     NOT enforce `per_customer_limit`. Both of those are guards that RAISE
--     in `claim_reward`, and a raise here would roll back the ledger write
--     the consumer legitimately earned. doc 35 step 11 names neither.
-- (e) The clawback unwinds PROGRESS only. `completed_count` stands and the
--     completion claim is not cancelled: doc 35 section 9 names progress, and
--     the prize may already be in the consumer's hands or redeemed at a
--     counter. Cancelling a redeemed claim is a different decision than this
--     task owns.
--
-- LOCKING. Nothing here takes a new lock. `award_receipt_points` already
-- holds `receipts` and the `business_customers` pair row FOR UPDATE before
-- it reaches step 11, and `clawback_receipt_points` holds the same two; every
-- card and stamp touched below belongs to that one (business, consumer) pair,
-- and those two functions are the only writers. Adding a redundant row lock
-- would be a guard whose removal changes nothing.
--
-- PURGE. `loyalty_stamps` is reachable from `businesses`, `loyalty_cards`,
-- `loyalty_programs` and `receipts` by ON DELETE CASCADE, so
-- `force_delete_business` (0077) and the purge RPCs' explicit delete lists
-- clear it without naming it. No change to those files.
--
-- Source docs: docs/30-modules/35-points-engine.md section 3 step 11 and
-- section 9; docs/30-modules/34-campaign-engine.md section 2 (liveness);
-- docs/20-data/23-schema-campaigns.md; supabase/migrations/0012_campaigns.sql
-- (the authoritative tables), 0015 (claim_reward, whose ledger path this
-- reuses), 0018 (manila_day, award_receipt_points), 0031
-- (clawback_receipt_points), 0039 (the "a reversed event never happened"
-- posture), 0041 (the private-helper-called-from-a-definer shape),
-- 0042 (the award_receipt_points body this re-creates), 0052 (definer
-- service_role hygiene), 0066 (the parallel schema this consolidates away).
-- ============================================================================

-- ============================================================ part 1: schema
-- 0066 dropped 0012's consumer policy and recreated it against `user_id`.
-- That policy has to go before the column can.
drop policy if exists loyalty_cards_consumer_select on public.loyalty_cards;

alter table public.loyalty_cards
  drop column if exists user_id,
  drop column if exists stamps_count,
  drop column if exists stamps_target,
  drop column if exists prize_reward_name,
  drop column if exists is_completed,
  drop column if exists completed_at;

-- 0012's policy, restored verbatim: P3, the consumer reads their own cards.
create policy loyalty_cards_consumer_select on public.loyalty_cards
  for select to authenticated
  using (consumer_id = (select auth.uid()));

-- composite target so loyalty_stamps can pin same-tenant parentage (the 0008
-- pattern every other child in 0012 already uses; loyalty_cards was the one
-- table with no child and so never needed one)
alter table public.loyalty_cards
  add constraint loyalty_cards_id_business_uniq unique (id, business_id);

-- ------------------------------------------------------------ loyalty_stamps
-- One row per (card, receipt) qualifying event. Append-only in spirit: the
-- only column that ever changes after insert is `reversed_at`.
create table public.loyalty_stamps (
  id           uuid primary key default private.uuid_generate_v7(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  card_id      uuid not null,
  program_id   uuid not null,
  consumer_id  uuid not null references public.consumers(id) on delete cascade,
  receipt_id   uuid not null references public.receipts(id) on delete cascade,
  -- progress this ONE event contributed, in the program's own unit (stamps,
  -- points or pesos). >= 0 rather than > 0: a spend_amount program with no
  -- min_amount floor can legitimately be handed a receipt under one peso,
  -- which qualifies as a stamp (it consumes a daily slot) and contributes
  -- nothing. A reversal sets reversed_at; it never writes a negative row.
  delta        integer not null check (delta >= 0),
  -- the receipt's OWN event time (doc 40: coalesce(receipt_date, created_at)),
  -- never processing time - so a receipt uploaded late is metered against the
  -- Manila day it was actually spent on, exactly like 0038's visit day.
  event_ts     timestamptz not null,
  reversed_at  timestamptz,
  created_at   timestamptz not null default now(),
  -- idempotency: one receipt can stamp one card at most once. Belt and
  -- braces alongside pt_receipt_earn_once, which already makes a second award
  -- of the same receipt impossible.
  unique (card_id, receipt_id),
  constraint loyalty_stamps_card_business_fkey
    foreign key (card_id, business_id)
    references public.loyalty_cards (id, business_id) on delete cascade,
  constraint loyalty_stamps_program_business_fkey
    foreign key (program_id, business_id)
    references public.loyalty_programs (id, business_id) on delete cascade
);
alter table public.loyalty_stamps enable row level security;

-- the daily-cap read: (card_id, event_ts) with the reversed rows excluded
create index loyalty_stamps_card_day_idx on public.loyalty_stamps (card_id, event_ts)
  where reversed_at is null;
-- the clawback read
create index loyalty_stamps_receipt_idx  on public.loyalty_stamps (receipt_id);
-- FK indexes per doc 20 convention
create index loyalty_stamps_business_idx on public.loyalty_stamps (business_id);
create index loyalty_stamps_consumer_idx on public.loyalty_stamps (consumer_id);
create index loyalty_stamps_program_idx  on public.loyalty_stamps (program_id);

-- Three-layer fence. service_role is revoked too: the only writers are the
-- SECURITY DEFINER functions below, which run as the table owner. Supabase
-- grants service_role table privileges through project default privileges at
-- CREATE time, so this revoke is doing real work rather than restating a
-- default.
revoke all on public.loyalty_stamps from public, anon, authenticated, service_role;
grant select on public.loyalty_stamps to authenticated;

-- P3: consumer reads their own stamp history (the card detail screen's
-- "collected on" surface, and the honest answer to "why is my card at 3?").
create policy loyalty_stamps_consumer_select on public.loyalty_stamps
  for select to authenticated
  using (consumer_id = (select auth.uid()));
-- P3: tenant staff read their own tenant's stamps, same roles as loyalty_cards.
create policy loyalty_stamps_staff_select on public.loyalty_stamps
  for select to authenticated
  using (private.is_active_staff(business_id, array['owner','manager','marketing']));
-- No insert/update/delete policies for either audience: stamping and reversal
-- go through the definer functions so the anti-gaming rules cannot be bypassed.

-- ------------------------------------------------- cardholder visibility
-- A card is worthless if the consumer cannot read the program's
-- `target_value` and the prize's `name`. `loyalty_programs_public_select`
-- (0012) requires the parent campaign to be `active` and
-- `rewards_public_select` requires `is_active` - both perfectly reasonable
-- for a catalogue, both false the moment a merchant pauses the campaign or
-- retires the prize, at which point every consumer holding a card would see
-- it break. Holding a card is its own, narrower grounds for reading exactly
-- those two rows.
--
-- SECURITY DEFINER for the same reason `private.is_active_staff` (0010) is:
-- the predicate has to see loyalty_cards rows without recursing back through
-- loyalty_cards' own policy. It filters on auth.uid() itself, so it can only
-- ever answer for the calling consumer.
create or replace function private.holds_loyalty_card_for_program(p_program_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.loyalty_cards lc
     where lc.program_id  = p_program_id
       and lc.consumer_id = (select auth.uid())
  );
$$;

revoke execute on function private.holds_loyalty_card_for_program(uuid)
  from public, anon, service_role;
grant execute on function private.holds_loyalty_card_for_program(uuid)
  to authenticated;

create or replace function private.holds_loyalty_card_for_reward(p_reward_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.loyalty_cards lc
      join public.loyalty_programs lp on lp.id = lc.program_id
     where lp.reward_id   = p_reward_id
       and lc.consumer_id = (select auth.uid())
  );
$$;

revoke execute on function private.holds_loyalty_card_for_reward(uuid)
  from public, anon, service_role;
grant execute on function private.holds_loyalty_card_for_reward(uuid)
  to authenticated;

create policy loyalty_programs_cardholder_select on public.loyalty_programs
  for select to authenticated
  using (private.holds_loyalty_card_for_program(loyalty_programs.id));

create policy rewards_cardholder_select on public.rewards
  for select to authenticated
  using (private.holds_loyalty_card_for_reward(rewards.id));

-- ================================================ part 2: the shared claim writer
-- doc 35 section 11's "one implementation of the rule math" applied to claim
-- writing: the completion prize below must NOT be a second, parallel claim
-- writer. This is `claim_reward`'s (0013/0015) steps 4, 5 and 6 lifted
-- verbatim - the claim row, the redeem ledger row, the link back, and the
-- balance cache - with claim_reward's own GUARDS (reward liveness, blacklist,
-- per-customer limits, campaign budget, inventory, balance) left where they
-- are. Those guards raise; a raise inside the award path would roll back a
-- ledger write the consumer legitimately earned.
--
-- `p_points_cost = 0` (the loyalty completion) skips the whole ledger branch
-- because 0012's points_transactions carries `check (points <> 0)`: a
-- zero-point redeem row is not a smaller correction, it is an invalid one.
-- That branch is claim_reward's own pre-existing behaviour, unchanged.
--
-- Not SECURITY DEFINER: it is only ever called from inside one (claim_reward
-- or award_receipt_points), so it already runs as the owner - the same shape
-- 0041's private helpers have.
create or replace function private.write_reward_claim(
  p_business_id       uuid,
  p_reward_id         uuid,
  p_consumer_id       uuid,
  p_points_cost       integer,
  p_prev_balance      integer,
  p_claim_expiry_days integer,
  p_campaign_id       uuid,
  p_actor_id          uuid
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_claim_id uuid;
  v_txn_id   uuid;
begin
  insert into public.reward_claims
    (business_id, reward_id, consumer_id, status, points_spent, expires_at,
     created_by, updated_by)
  values
    (p_business_id, p_reward_id, p_consumer_id, 'claimed', p_points_cost,
     now() + make_interval(days => p_claim_expiry_days), p_actor_id, p_actor_id)
  returning id into v_claim_id;

  if p_points_cost > 0 then
    insert into public.points_transactions
      (business_id, consumer_id, type, points, balance_after,
       claim_id, campaign_id, created_by)
    values
      (p_business_id, p_consumer_id, 'redeem', -p_points_cost,
       p_prev_balance - p_points_cost, v_claim_id, p_campaign_id, p_actor_id)
    returning id into v_txn_id;

    update public.reward_claims
       set points_txn_id = v_txn_id, updated_by = p_actor_id
     where id = v_claim_id;

    update public.business_customers
       set points_balance = p_prev_balance - p_points_cost, updated_by = p_actor_id
     where business_id = p_business_id
       and consumer_id = p_consumer_id;
  end if;

  return v_claim_id;
end
$$;

revoke execute on function private.write_reward_claim(uuid, uuid, uuid, integer, integer, integer, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- claim_reward
-- 0015's function verbatim except for its last block, which now delegates to
-- the shared writer above. Signature, guard order, lock order and every
-- message are unchanged, so this is a plain `create or replace`.
create or replace function public.claim_reward(p_reward_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid                  uuid := auth.uid();
  v_business_id          uuid;
  v_campaign_id          uuid;
  v_points_cost          integer;
  v_reward_limit         integer;
  v_campaign_limit       integer;   -- campaigns.budget->>'per_customer_limit', when present
  v_max_redemptions      integer;   -- campaigns.budget->>'max_redemptions', when present
  v_claim_expiry_days    integer;
  v_prev_balance         integer;
  v_segment              text;
  v_claim_count          integer;   -- this consumer's claims of THIS reward
  v_campaign_claim_count integer;   -- this consumer's claims across the campaign
  v_campaign_redemptions integer;   -- everyone's claims across the campaign
  v_claim_id             uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;

  -- s6 step 1 guard: reward is_active + not deleted, owning campaign live and
  -- claimable (status active, inside its schedule window). One combined lookup:
  -- any miss is indistinguishable to the consumer, hence one message.
  select r.business_id, r.campaign_id, r.points_cost, r.per_customer_limit,
         r.claim_expiry_days,
         nullif(c.budget->>'per_customer_limit', '')::integer,
         nullif(c.budget->>'max_redemptions', '')::integer
    into v_business_id, v_campaign_id, v_points_cost, v_reward_limit,
         v_claim_expiry_days, v_campaign_limit, v_max_redemptions
    from public.rewards r
    join public.campaigns c on c.id = r.campaign_id
   where r.id = p_reward_id
     and r.is_active = true
     and r.deleted_at is null
     and c.status = 'active'
     and c.deleted_at is null
     and (c.starts_at is null or now() >= c.starts_at)
     and (c.ends_at is null or now() < c.ends_at);
  if not found then
    raise exception using errcode = 'P0001', message = 'REWARD_UNAVAILABLE';
  end if;

  -- s6 step 1 (s5 row lock): ensure the pair row exists, then lock it. The
  -- select for update serializes all claims (and awards) for this
  -- (business, consumer) pair for the rest of the transaction.
  insert into public.business_customers (business_id, consumer_id, created_by, updated_by)
  values (v_business_id, v_uid, v_uid, v_uid)
  on conflict (business_id, consumer_id) do nothing;

  select bc.points_balance, bc.segment
    into v_prev_balance, v_segment
    from public.business_customers bc
   where bc.business_id = v_business_id
     and bc.consumer_id = v_uid
     for update;
  -- Defence in depth: the insert above guarantees the row, but a null balance
  -- must never be able to reach the balance_after arithmetic below.
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

  -- s6 step 1 guard: blacklisted consumers cannot claim
  if v_segment = 'blacklisted' then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_BLACKLISTED';
  end if;

  -- s6 step 1 guard: the reward's own per_customer_limit is REWARD-scoped:
  -- it counts this consumer's non-cancelled claims of this one reward.
  -- Cancelled claims released their slot; every other status counts.
  select count(*)::integer
    into v_claim_count
    from public.reward_claims rc
   where rc.reward_id = p_reward_id
     and rc.consumer_id = v_uid
     and rc.status <> 'cancelled';
  if v_claim_count >= v_reward_limit then
    raise exception using errcode = 'P0001', message = 'REWARD_LIMIT_REACHED';
  end if;

  -- amendment (0015): lock the campaign row before ANY campaign-wide count.
  -- Without this, concurrent claims by different consumers each read a stale
  -- count and can both pass a cap. Taken only when a cap is configured so
  -- uncapped campaigns keep full parallelism.
  if v_campaign_limit is not null or v_max_redemptions is not null then
    perform 1 from public.campaigns c where c.id = v_campaign_id for update;
  end if;

  -- s6 step 1 guard (doc 34 s5): campaigns.budget->>'per_customer_limit' is
  -- CAMPAIGN-scoped: it counts this consumer's non-cancelled claims across
  -- ALL of the campaign's rewards, not just p_reward_id. Doc 34 s12 registers
  -- CAMPAIGN_LIMIT_REACHED for this cap (422, this consumer only).
  if v_campaign_limit is not null then
    select count(*)::integer
      into v_campaign_claim_count
      from public.reward_claims rc
      join public.rewards cr on cr.id = rc.reward_id
     where cr.campaign_id = v_campaign_id
       and rc.consumer_id = v_uid
       and rc.status <> 'cancelled';
    if v_campaign_claim_count >= v_campaign_limit then
      raise exception using errcode = 'P0001', message = 'CAMPAIGN_LIMIT_REACHED';
    end if;
  end if;

  -- Doc 34 s5 + doc 35 s6 step 1: campaigns.budget->>'max_redemptions' caps
  -- non-cancelled claims across the WHOLE campaign (all rewards, all
  -- consumers). The campaign row lock above makes this count race-safe.
  if v_max_redemptions is not null then
    select count(*)::integer
      into v_campaign_redemptions
      from public.reward_claims rc
      join public.rewards cr on cr.id = rc.reward_id
     where cr.campaign_id = v_campaign_id
       and rc.status <> 'cancelled';
    if v_campaign_redemptions >= v_max_redemptions then
      raise exception using errcode = 'P0001', message = 'CAMPAIGN_BUDGET_EXHAUSTED';
    end if;
  end if;

  -- s6 step 2: conditional inventory decrement (doc 23 integrity: stock never
  -- oversold). remaining is null = unlimited: the null branch of the where
  -- clause still matches and null - 1 stays null, so unlimited never blocks
  -- and never starts counting down.
  update public.rewards
     set remaining = remaining - 1, updated_by = v_uid
   where id = p_reward_id
     and (remaining is null or remaining > 0);
  if not found then
    raise exception using errcode = 'P0001', message = 'REWARD_OUT_OF_STOCK';
  end if;

  -- s6 step 3: balance check under the pair lock. Any raise from here rolls
  -- back the inventory decrement above with the rest of the transaction.
  if v_points_cost > 0 and v_prev_balance < v_points_cost then
    raise exception using errcode = 'P0001', message = 'POINTS_INSUFFICIENT';
  end if;

  -- s6 steps 4, 5 and 6 - the claim row, exactly one redeem ledger row, the
  -- link back, and the balance cache, all in this transaction. Moved into
  -- private.write_reward_claim (0078) with no change of behaviour so the
  -- loyalty completion prize in doc 35 step 11 goes through THIS writer
  -- rather than a second, parallel one. The points_cost = 0 case (loyalty
  -- completion / gift) writes no ledger row at all and leaves the balance
  -- untouched, exactly as before.
  v_claim_id := private.write_reward_claim(
    v_business_id, p_reward_id, v_uid, v_points_cost, v_prev_balance,
    v_claim_expiry_days, v_campaign_id, v_uid);

  return v_claim_id;
end
$function$;

-- Grants restated exactly as 0013/0015 set them and 0052 narrowed them: a
-- `create or replace` re-runs Supabase's project default privileges, which
-- grant EXECUTE to service_role on every new public function regardless of
-- what the previous migration revoked. Without the service_role revoke below,
-- this file would silently undo 0052's hygiene fix.
revoke execute on function public.claim_reward(uuid) from public, anon, service_role;
grant execute on function public.claim_reward(uuid) to authenticated;

-- ==================================== part 3: the progression (doc 35 step 11)
-- Called from inside award_receipt_points' transaction, after the ledger row
-- and the CRM cache are written and while the receipt and the pair row are
-- both still held FOR UPDATE. The ledger write and the stamp commit together
-- or not at all - that is the whole reason this lives here and not in a
-- post-commit job.
--
-- LIVENESS (doc 34 section 2, mirrored from `isCampaignLive` in
-- src/features/campaigns/lifecycle.ts and from claim_reward's own guard):
-- status `active`, not soft-deleted, `starts_at` inclusive, `ends_at`
-- exclusive - evaluated at the RECEIPT's event time, never at processing
-- time, exactly as doc 34 requires ("calls isCampaignLive(campaign,
-- receipt.receipt_date) - receipt time, never processing time"). Recurrence
-- is [V1] and unimplemented on both sides of the wire, so it is not
-- consulted here either.
--
-- `campaigns.type`, not `campaign_type`: doc 34's column is `type` and it is
-- the loyalty/membership pair that carries a loyalty_programs payload.
--
-- NOTHING HERE METERS ANYTHING WITH `sum(points) where campaign_id = X`.
-- 0041 established why that formula is wrong in both directions
-- (`points_transactions.points` is the WHOLE receipt's total and
-- `campaign_id` names only the primary applied campaign). This function does
-- not need per-campaign attribution at all: `p_points` IS the whole-receipt
-- total, which is exactly what doc 35's `points_target` row asks for
-- ("+= TOTAL points awarded"), and every other program type is metered off
-- the receipt itself.
create or replace function private.advance_loyalty_cards(
  p_receipt_id     uuid,
  p_business_id    uuid,
  p_consumer_id    uuid,
  p_event_ts       timestamptz,
  p_total_centavos integer,
  p_points         integer
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_event_day    date := private.manila_day(p_event_ts);
  v_prog         record;
  v_card         record;
  v_delta        integer;
  v_stamps_today integer;
  v_new_progress integer;
  v_expiry_days  integer;
begin
  for v_prog in
    select lp.id,
           lp.program_type,
           lp.target_value,
           lp.reward_id,
           lp.min_amount_per_stamp_centavos,
           lp.max_stamps_per_day,
           lp.resets_on_completion
      from public.loyalty_programs lp
      join public.campaigns c on c.id = lp.campaign_id
     where lp.business_id = p_business_id
       and lp.deleted_at is null
       and c.type in ('loyalty', 'membership')
       and c.status = 'active'
       and c.deleted_at is null
       and (c.starts_at is null or p_event_ts >= c.starts_at)
       and (c.ends_at   is null or p_event_ts <  c.ends_at)
     order by lp.id
  loop
    -- doc 35 step 11, qualifier 1: the anti-gaming floor. A null column is
    -- NO floor, not a floor of zero - which is why this is an explicit
    -- `is not null` branch rather than a `coalesce(..., 0)` comparison that
    -- would read identically and behave identically only by accident.
    if v_prog.min_amount_per_stamp_centavos is not null
       and coalesce(p_total_centavos, 0) < v_prog.min_amount_per_stamp_centavos then
      continue;
    end if;

    -- doc 35's increment table. `custom` is deliberately absent (see this
    -- file's header, decision (a)); a null delta means "no ratified
    -- arithmetic" and stamps nothing.
    v_delta := case v_prog.program_type
                 when 'visit_count'   then 1
                 when 'receipt_count' then 1
                 when 'points_target' then p_points
                 -- pesos, matching target_value's unit. floor(), not integer
                 -- division, so the rounding is stated rather than inherited
                 -- from a truncation that only agrees with floor for
                 -- non-negative inputs.
                 when 'spend_amount'  then floor(coalesce(p_total_centavos, 0)::numeric / 100)::integer
                 else null
               end;
    if v_delta is null then
      continue;
    end if;

    -- The card. Created on the first qualifying receipt; the unique
    -- (program_id, consumer_id) makes the upsert the whole race story, and
    -- the pair row is already held FOR UPDATE by the caller anyway.
    insert into public.loyalty_cards
      (business_id, program_id, consumer_id, created_by, updated_by)
    values (p_business_id, v_prog.id, p_consumer_id, p_consumer_id, p_consumer_id)
    on conflict (program_id, consumer_id) do nothing;

    select lc.id, lc.progress, lc.completed_count, lc.last_stamp_at
      into v_card
      from public.loyalty_cards lc
     where lc.program_id  = v_prog.id
       and lc.consumer_id = p_consumer_id;

    -- Decision (c): a non-resetting card that has reached its target is
    -- finished. Without this, "progress freezes at target" means the card
    -- sits permanently at `progress >= target_value` and re-completes on
    -- every subsequent receipt, minting a free prize each time.
    if not v_prog.resets_on_completion
       and v_card.progress >= v_prog.target_value then
      continue;
    end if;

    -- doc 35 step 11, qualifier 2: stamps already today, Asia/Manila.
    -- Metered on the stamp ledger rather than on `last_stamp_at`, which can
    -- only ever answer for one stamp (see this file's header). A REVERSED
    -- stamp is excluded, mirroring 0039: a clawed-back event never happened,
    -- so it does not go on occupying its day's slot forever.
    select count(*)::integer
      into v_stamps_today
      from public.loyalty_stamps ls
     where ls.card_id = v_card.id
       and ls.reversed_at is null
       and private.manila_day(ls.event_ts) = v_event_day;

    if v_stamps_today >= v_prog.max_stamps_per_day then
      continue;
    end if;

    -- The attribution row. This is what makes a clawback able to unwind
    -- exactly what this receipt contributed, in this program's own unit.
    insert into public.loyalty_stamps
      (business_id, card_id, program_id, consumer_id, receipt_id, delta, event_ts)
    values
      (p_business_id, v_card.id, v_prog.id, p_consumer_id, p_receipt_id,
       v_delta, p_event_ts);

    v_new_progress := v_card.progress + v_delta;

    if v_new_progress >= v_prog.target_value then
      -- The completion prize. Its expiry comes from the REWARD's own
      -- claim_expiry_days, never a constant.
      select r.claim_expiry_days
        into v_expiry_days
        from public.rewards r
       where r.id = v_prog.reward_id;

      -- p_campaign_id is null: it is consumed only by the redeem ledger row,
      -- which a zero-cost claim never writes. p_prev_balance likewise.
      perform private.write_reward_claim(
        p_business_id, v_prog.reward_id, p_consumer_id,
        0, null, v_expiry_days, null, p_consumer_id);

      if v_prog.resets_on_completion then
        -- carryover is KEPT, not zeroed
        v_new_progress := v_new_progress - v_prog.target_value;
      else
        v_new_progress := v_prog.target_value;
      end if;

      update public.loyalty_cards lc
         set progress        = v_new_progress,
             completed_count = lc.completed_count + 1,
             -- greatest() ignores nulls, so a fresh card takes p_event_ts and
             -- a backdated receipt processed after a newer one does not drag
             -- "the most recent stamp" backwards.
             last_stamp_at   = greatest(lc.last_stamp_at, p_event_ts),
             updated_by      = p_consumer_id
       where lc.id = v_card.id;
    else
      update public.loyalty_cards lc
         set progress      = v_new_progress,
             last_stamp_at = greatest(lc.last_stamp_at, p_event_ts),
             updated_by    = p_consumer_id
       where lc.id = v_card.id;
    end if;
  end loop;
end
$$;

revoke execute on function private.advance_loyalty_cards(uuid, uuid, uuid, timestamptz, integer, integer)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------- the clawback unwind
-- doc 35 section 9: "Also unwinds loyalty progress attributable to the receipt
-- (floor at 0)." Attributable is the load-bearing word, and it is why the
-- stamp ledger exists: each row already records exactly what THIS receipt
-- gave THIS card, in that card's own unit.
--
-- Returns the number of stamps it reversed so the caller can record it in the
-- audit row - the clawback's own evidence trail is where an unwind that
-- silently did nothing would otherwise hide.
create or replace function private.unwind_loyalty_stamps(p_receipt_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_stamp   record;
  v_unwound integer := 0;
begin
  for v_stamp in
    select ls.id, ls.card_id, ls.delta
      from public.loyalty_stamps ls
     where ls.receipt_id = p_receipt_id
       and ls.reversed_at is null
  loop
    -- greatest(0, ...) is what makes "floor at 0" structural. Without it a
    -- reset card (progress 15 after a completion, a stamp worth 70) would
    -- take progress negative and the whole clawback would raise on
    -- loyalty_cards_progress_check - i.e. the floor is not decoration, its
    -- absence is a failed clawback.
    update public.loyalty_cards lc
       set progress = greatest(0, lc.progress - v_stamp.delta)
     where lc.id = v_stamp.card_id;

    update public.loyalty_stamps ls
       set reversed_at = now()
     where ls.id = v_stamp.id;

    v_unwound := v_unwound + 1;
  end loop;

  return v_unwound;
end
$$;

revoke execute on function private.unwind_loyalty_stamps(uuid)
  from public, anon, authenticated, service_role;

-- ================================================ part 4: award_receipt_points
-- 0042's function verbatim except for two things: `total_centavos` joins the
-- receipt read (step 11 needs it for both the min-amount floor and the
-- spend_amount increment), and the progression call lands after the visit is
-- applied and before the receipt is stamped processed. Signature UNCHANGED
-- from 0040/0041/0042, so this is a plain `create or replace`.
create or replace function public.award_receipt_points(
  p_receipt_id    uuid,
  p_points        integer,
  p_rule_snapshot jsonb       default null,
  p_campaign_id   uuid        default null,
  p_expires_at    timestamptz default null,
  p_verify_no_prior_fixed_visit_earn boolean default false,
  p_campaign_budget_checks jsonb default null
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
  v_expires_at    timestamptz;
  v_budget_check       record;
  v_campaign_budget    jsonb;
  v_max_total_points   integer;
  v_per_customer_limit integer;
  v_campaign_awarded   integer;
  v_campaign_earn_count integer;
begin
  if p_receipt_id is null then
    raise exception using errcode = 'P0001', message = 'AWARD_RECEIPT_ID_REQUIRED';
  end if;
  if p_points is null or p_points <= 0 then
    raise exception using errcode = 'P0001', message = 'AWARD_POINTS_INVALID';
  end if;

  -- total_centavos joins this read as of 0078: doc 35 step 11 needs it for
  -- both the min_amount_per_stamp_centavos floor and the spend_amount
  -- increment, and re-reading the receipt later would read it outside the
  -- lock this select takes.
  select r.id, r.business_id, r.user_id, r.status, r.receipt_date, r.created_at,
         r.total_centavos
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

  perform 1
     from public.points_transactions pt
    where pt.receipt_id = p_receipt_id
      and pt.type = 'earn';
  if found then
    raise exception using errcode = 'P0001', message = 'RECEIPT_ALREADY_AWARDED';
  end if;

  insert into public.business_customers (business_id, consumer_id)
  values (v_receipt.business_id, v_receipt.user_id)
  on conflict (business_id, consumer_id) do nothing;

  select bc.points_balance, bc.segment
    into v_prev_balance, v_segment
    from public.business_customers bc
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

  if v_segment = 'blacklisted' then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_BLACKLISTED';
  end if;

  if p_verify_no_prior_fixed_visit_earn then
    v_visit_day := private.manila_day(coalesce(v_receipt.receipt_date, v_receipt.created_at));
    if private.fixed_per_visit_already_paid(v_receipt.business_id, v_receipt.user_id, v_visit_day) then
      raise exception using errcode = 'P0001', message = 'FIXED_PER_VISIT_RACE';
    end if;
  end if;

  if p_campaign_budget_checks is not null then
    for v_budget_check in
      select (elem->>'campaign_id')::uuid as campaign_id,
             (elem->>'points')::integer   as points
        from jsonb_array_elements(p_campaign_budget_checks) as elem
       order by (elem->>'campaign_id')::uuid
    loop
      select c.budget
        into v_campaign_budget
        from public.campaigns c
       where c.id = v_budget_check.campaign_id
         for update;
      if not found then
        continue;
      end if;

      v_max_total_points   := nullif(v_campaign_budget->>'max_total_points', '')::integer;
      v_per_customer_limit := nullif(v_campaign_budget->>'per_customer_limit', '')::integer;

      if v_max_total_points is not null then
        v_campaign_awarded := private.campaign_points_awarded(v_receipt.business_id, v_budget_check.campaign_id);
        if v_campaign_awarded + v_budget_check.points > v_max_total_points then
          raise exception using errcode = 'P0001', message = 'CAMPAIGN_BUDGET_RACE';
        end if;
      end if;

      if v_per_customer_limit is not null then
        v_campaign_earn_count := private.campaign_customer_earn_count(
          v_receipt.business_id, v_budget_check.campaign_id, v_receipt.user_id);
        if v_campaign_earn_count >= v_per_customer_limit then
          raise exception using errcode = 'P0001', message = 'CAMPAIGN_BUDGET_RACE';
        end if;
      end if;
    end loop;
  end if;

  -- Task 1.3: the flat, platform-wide 12-month rolling expiry (doc 35 section
  -- 7) is now authoritative HERE, not merely passed through. p_expires_at
  -- survives as a caller override (see this migration's header) but every
  -- caller that sends null - which is every caller today - gets the platform
  -- default computed from THIS insert's own clock, matching created_at
  -- exactly since points_transactions.created_at (0012) also defaults to
  -- now() evaluated in the same transaction snapshot.
  v_expires_at := coalesce(p_expires_at, now() + interval '12 months');

  insert into public.points_transactions
    (business_id, consumer_id, type, points, balance_after,
     receipt_id, campaign_id, rule_snapshot, expires_at)
  values
    (v_receipt.business_id, v_receipt.user_id, 'earn', p_points,
     v_prev_balance + p_points,
     p_receipt_id, p_campaign_id, p_rule_snapshot, v_expires_at)
  returning id into v_txn_id;

  update public.business_customers bc
     set points_balance  = v_prev_balance + p_points,
         lifetime_points = bc.lifetime_points + p_points
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id;

  perform private.apply_receipt_visit(p_receipt_id);

  -- T4.5 / doc 35 section 3 step 11. INSIDE this transaction, under the same
  -- receipt and pair locks taken above: the ledger write and the stamp commit
  -- together or not at all. The event timestamp is the receipt's own (doc 40:
  -- coalesce(receipt_date, created_at)), identical to the value the
  -- fixed_per_visit dedupe keys on, so a late upload is metered against the
  -- Manila day it was actually spent on.
  perform private.advance_loyalty_cards(
    p_receipt_id,
    v_receipt.business_id,
    v_receipt.user_id,
    coalesce(v_receipt.receipt_date, v_receipt.created_at),
    v_receipt.total_centavos,
    p_points);

  update public.receipts
     set processed_at = now()
   where id = p_receipt_id;

  return v_txn_id;
end
$$;

-- System function, service_role ONLY. Signature unchanged, so this restates
-- the existing grant pair rather than widening or narrowing it - and it has
-- to be restated, because `create or replace` re-applies Supabase's project
-- default privileges to the function every time.
revoke execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)
  to service_role;

-- ============================================ part 5: clawback_receipt_points
-- 0031's function verbatim except for the loyalty unwind, which 0031's own
-- header named as a known omission ("no loyalty-card unwind (doc 35 section 9
-- 'unwinds loyalty progress'). There is no loyalty_cards table yet") - the
-- table did in fact exist, but nothing wrote to it, which amounts to the same
-- thing. The unwind runs on BOTH sides of the fully-spent-balance branch: a
-- clawback that could write no ledger row because the balance was already
-- zero still has a fraudulent stamp to take back.
create or replace function public.clawback_receipt_points(
  p_receipt_id uuid,
  p_actor_id   uuid,
  p_reason     text,
  p_request_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt      record;
  v_earn         record;
  v_balance      integer;
  v_clawed       integer;
  v_shortfall    integer;
  v_txn_id       uuid;
  v_reason       text;
  v_admin_role   text;
  v_stamps_unwound integer;
begin
  -- Step 1: inputs. The reason is checked FIRST and separately, before
  -- anything is read, because doc 15 states it twice as a security control and
  -- doc 31 section 11 makes it the pattern for "any write touching tenant/user data".
  -- audit_logs_admin_reason_required would catch a blank one at the very end of
  -- this function anyway; catching it here means the caller gets
  -- CLAWBACK_REASON_REQUIRED instead of a 23514 raised after the ledger row was
  -- already written and rolled back.
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception using errcode = 'P0001', message = 'CLAWBACK_REASON_REQUIRED';
  end if;
  if p_receipt_id is null or p_actor_id is null then
    raise exception using errcode = 'P0001', message = 'CLAWBACK_INPUT_INVALID';
  end if;

  -- Step 2: the actor is an ACTIVE platform admin, by TABLE TRUTH.
  --
  -- This function is SECURITY DEFINER and granted to service_role only, so the
  -- claim that gates the policies above is not available and would be the
  -- wrong thing to trust here anyway: doc 12 fixes claims as RLS hints that
  -- refresh at most hourly, and requires that "destructive-permission checks
  -- (staff removal, suspension) also verify against the table server-side".
  -- Clawing back points is the most destructive action in this slice, and an
  -- admin deactivated ten minutes ago still holds a valid claim.
  select pa.role into v_admin_role
    from public.platform_admins pa
   where pa.user_id = p_actor_id and pa.is_active = true;
  if v_admin_role is null or v_admin_role = 'support' then
    -- doc 01's matrix: `support` is read-only everywhere and never mutates.
    raise exception using errcode = 'P0001', message = 'CLAWBACK_FORBIDDEN';
  end if;

  -- Step 3: load and lock the receipt (0018's step 2, same reason - it
  -- serializes a concurrent award or a concurrent second clawback here rather
  -- than letting them race further down).
  select r.id, r.business_id, r.user_id, r.status, r.total_centavos
    into v_receipt
    from public.receipts r
   where r.id = p_receipt_id
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'RECEIPT_NOT_FOUND';
  end if;

  -- Step 4: the earn row this reverses. doc 37 registers CLAWBACK_INVALID_STATE
  -- for exactly two conditions and this is the first: "No earn row for the
  -- receipt". A receipt that was never awarded has nothing to claw back, and
  -- the correct action on it is an ordinary review rejection.
  select pt.id, pt.points, pt.business_id, pt.consumer_id
    into v_earn
    from public.points_transactions pt
   where pt.receipt_id = p_receipt_id
     and pt.type = 'earn';
  if not found then
    raise exception using errcode = 'P0001', message = 'CLAWBACK_INVALID_STATE';
  end if;

  -- Step 5: the second condition - "or already reversed". pt_receipt_earn_once
  -- guarantees at most one earn per receipt, so at most one row may point at
  -- it; doc 35 section 9 states the idempotency requirement as "at most one
  -- clawback/reversal per reverses_id (service check inside the pair lock)".
  -- The check is here rather than after the pair lock because the RECEIPT lock
  -- taken in step 3 already serializes every caller reaching this line for this
  -- receipt, and the earn row is reachable only through it.
  perform 1
     from public.points_transactions pt
    where pt.reverses_id = v_earn.id
      and pt.type in ('clawback', 'reversal');
  if found then
    raise exception using errcode = 'P0001', message = 'CLAWBACK_INVALID_STATE';
  end if;

  -- Step 6: lock the pair and read the balance under it (doc 35 section 5: "the row
  -- lock IS the correctness guarantee for balance_after"). The pair row must
  -- exist - 0018 created it before writing the earn - so a missing one is a
  -- corrupted ledger, not a case to paper over.
  select bc.points_balance into v_balance
    from public.business_customers bc
   where bc.business_id = v_earn.business_id
     and bc.consumer_id = v_earn.consumer_id
     for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

  -- Step 7: the clamp. doc 35 section 9: "points = -min(original_earn_points,
  -- current_balance) - clamped; the ledger never drives a balance negative".
  -- The shortfall is NOT carried as debt (section 9's residual-debt policy); it is
  -- recorded in the audit row's `after` as doc 35 names it, and doc 37's
  -- consequences ladder handles the repeat case through segments and
  -- suspension rather than through a negative balance.
  v_clawed    := least(v_earn.points, v_balance);
  v_shortfall := v_earn.points - v_clawed;

  -- The fully-spent case. points_transactions has `check (points <> 0)`, so
  -- when the balance is already zero there is NO ledger row that can be
  -- written - a zero-point clawback is not a smaller correction, it is an
  -- invalid one. doc 35's worked example stops one step short of this (balance
  -- 100, earn 970 -> row of -100, shortfall 870); this is the same case with
  -- the balance at 0, and the honest handling is to write no ledger row, record
  -- the whole earn as shortfall, and still reject the receipt. Skipping the
  -- rejection instead would leave a receipt confirmed fraudulent sitting at
  -- status='approved'.
  if v_clawed > 0 then
    insert into public.points_transactions
      (business_id, consumer_id, type, points, balance_after,
       receipt_id, reverses_id, actor_id)
    values
      (v_earn.business_id, v_earn.consumer_id, 'clawback', -v_clawed,
       v_balance - v_clawed, p_receipt_id, v_earn.id, p_actor_id)
    returning id into v_txn_id;

    -- Step 8: the CRM cache, same transaction (doc 35 section 3 step 10's counterpart
    -- on the way down). points_balance mirrors the ledger exactly. The two
    -- lifetime counters are unwound by the ORIGINAL amounts and floored at zero
    -- per doc 35 section 9 ("floor at 0"): they are sums over history, and the history
    -- entry they summed is now known to be fraudulent, so leaving them inflated
    -- would keep a fraudulent receipt influencing segment and cohort reporting
    -- forever. greatest(...) is what makes the floor structural rather than a
    -- hope about ordering.
    --
    -- visit_count is deliberately NOT decremented. doc 40 defines a visit as a
    -- distinct (user, business, Manila day) with >= 1 approved receipt, so one
    -- receipt out of several on the same day is not one visit, and the counter
    -- is a cache doc 40 recomputes from the receipts table - where this receipt
    -- is about to stop being approved. Guessing at a decrement here would
    -- corrupt a number that heals itself.
    update public.business_customers bc
       set points_balance          = v_balance - v_clawed,
           lifetime_points         = greatest(0, bc.lifetime_points - v_earn.points),
           lifetime_spend_centavos = greatest(
                                       0,
                                       bc.lifetime_spend_centavos
                                         - coalesce(v_receipt.total_centavos, 0)
                                     )
     where bc.business_id = v_earn.business_id
       and bc.consumer_id = v_earn.consumer_id;
  else
    -- Balance already zero: the cache's points_balance is right as it stands,
    -- but the lifetime counters still carry the fraudulent earn and are unwound
    -- on the same argument as above.
    update public.business_customers bc
       set lifetime_points         = greatest(0, bc.lifetime_points - v_earn.points),
           lifetime_spend_centavos = greatest(
                                       0,
                                       bc.lifetime_spend_centavos
                                         - coalesce(v_receipt.total_centavos, 0)
                                     )
     where bc.business_id = v_earn.business_id
       and bc.consumer_id = v_earn.consumer_id;
  end if;

  -- Step 8b (0078): doc 35 section 9's remaining clause - "Also unwinds
  -- loyalty progress attributable to the receipt (floor at 0)". OUTSIDE the
  -- branch above on purpose: a clawback that could write no ledger row
  -- because the balance was already spent to zero still has a fraudulent
  -- stamp to take back, and the stamp is what buys the prize.
  --
  -- Progress only. completed_count stands and any completion claim this
  -- receipt triggered is left alone: doc 35 section 9 names progress, and the
  -- prize may already be redeemed at a counter. Reversing a redeemed claim is
  -- a different decision than this function owns.
  v_stamps_unwound := private.unwind_loyalty_stamps(p_receipt_id);

  -- Step 9: the receipt. doc 37 ladder step 5: "receipt -> rejected/
  -- fraud_suspected with reviewed_by set". Note what is NOT written:
  -- reject_note stays untouched. The admin's reason is free text that may name
  -- another consumer or another tenant's receipt (that is usually the whole
  -- finding), and reject_note is read back by the business review queue; the
  -- reason belongs in audit_logs, whose read audience is the tenant owner for
  -- their own rows and the admin for everything.
  --
  -- Moving to 'rejected' also releases this receipt's number from
  -- receipts_number_unique (0017 excludes rejected rows from that index), which
  -- is correct: if the number was claimed fraudulently, the honest holder of
  -- the same printed receipt must be able to claim it afterwards.
  update public.receipts r
     set status        = 'rejected',
         reject_reason = 'fraud_suspected',
         reviewed_by   = p_actor_id,
         reviewed_at   = now(),
         updated_by    = p_actor_id
   where r.id = p_receipt_id;

  -- Step 10: the audit row, INSIDE the transaction.
  --
  -- This is the one thing this function does that src/features/receipts/server/
  -- review.ts could not: that service writes its audit row through PostgREST as
  -- a separate statement and spends a long comment justifying the ordering it
  -- had to choose. Here the ledger write and its justification commit or roll
  -- back together, so an unauditable clawback is not a race that has to be lost
  -- gracefully - it is unreachable.
  --
  -- actor_kind='admin' makes `reason` mandatory at the database layer
  -- (audit_logs_admin_reason_required, 0022); step 1 above is the same check
  -- moved early enough to produce a useful error.
  insert into public.audit_logs
    (actor_id, actor_kind, actor_role, business_id, action,
     entity_type, entity_id, before, after, reason, request_id)
  values
    (p_actor_id, 'admin', v_admin_role, v_earn.business_id,
     'fraud.clawback_applied', 'receipt', p_receipt_id,
     jsonb_build_object(
       'status', v_receipt.status,
       'points_balance', v_balance,
       'earn_points', v_earn.points
     ),
     jsonb_build_object(
       'status', 'rejected',
       'reject_reason', 'fraud_suspected',
       'points_balance', v_balance - v_clawed,
       'clawed_points', v_clawed,
       -- doc 35 section 9 names this key: "recorded in the audit trail (audit_logs
       -- action='points.clawback', after.shortfall_points)". The ACTION verb
       -- follows 0022's registry instead, which lists fraud.clawback_applied by
       -- name from doc 37's reviewer-action mapping; the two docs disagree only
       -- about the verb and 0022 is the one this database's shape constraint
       -- and index were written against.
       'shortfall_points', v_shortfall,
       'transaction_id', v_txn_id,
       -- 0078: how many loyalty stamps this clawback took back. Recorded
       -- because an unwind that silently did nothing is otherwise invisible
       -- in the one place a fraud case is later reconstructed from.
       'loyalty_stamps_unwound', v_stamps_unwound
     ),
     v_reason, p_request_id);

  return jsonb_build_object(
    'transaction_id',   v_txn_id,
    'earn_points',      v_earn.points,
    'clawed_points',    v_clawed,
    'shortfall_points', v_shortfall,
    'balance_after',    v_balance - v_clawed,
    'loyalty_stamps_unwound', v_stamps_unwound
  );
end
$$;

-- Service-role only, identical in posture to 0018 and unchanged from 0031;
-- restated because `create or replace` re-applies the project default
-- privileges that grant service_role EXECUTE at CREATE time.
revoke execute on function public.clawback_receipt_points(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.clawback_receipt_points(uuid, uuid, text, text)
  to service_role;
