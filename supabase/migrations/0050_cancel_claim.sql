-- ============================================================================
-- 0050_cancel_claim.sql
-- Task 1.4: let a consumer cancel their own unredeemed reward claim and get
-- their points back immediately.
--
-- THE GAP. `claim_reward` (0013) debits points and reserves inventory at
-- claim time; `expire_claims` (0016) reverses a lapsed claim, but only the
-- hourly sweep can trigger that, and only once `expires_at` has passed
-- (default 30 days, up to 365). A mis-tapped claim locks the consumer's
-- points for the full claim window with no way back. Doc 03's loyalty
-- benchmark research (Key Finding 1) names this the top complaint driver in
-- the reference app: "points debited on intent and never returned". Giya
-- already owns the correct reversal semantics (0016); this migration exposes
-- them to the claim's own consumer, on demand, instead of inventing a second
-- shape.
--
-- ONE REVERSAL, TWO CALLERS. `private.reverse_claim_ledger(...)` is the
-- shared effect both `cancel_claim` (below) and the re-created
-- `expire_claims` now call: write the reversal ledger row (only when
-- `points_spent > 0`, exactly 0016's rule for a free/loyalty-completion
-- claim), restore the `business_customers.points_balance` cache, and restore
-- `rewards.remaining` under the 0016 `rewards_remaining_lte_total` cap guard.
-- The alternative - hand-copying 0016's reversal block into a new RPC - is
-- exactly the "two hand-maintained copies that could drift" 0038/0041 already
-- warn against for this codebase's other shared predicates; this is the same
-- shape applied to a shared EFFECT instead of a shared predicate. Each caller
-- still owns its OWN guards and its OWN `reward_claims` status flip (the two
-- callers set different columns: `cancel_claim` also stamps
-- `cancelled_reason` and `updated_by`, `expire_claims` sets neither, matching
-- its existing system-actor posture), so the helper's job is narrowly "make
-- the points and inventory whole again", never authorization or status.
--
-- WHY reward_claims NEEDS NO NEW STATUS VALUE. 0012's check constraint
-- already lists `'cancelled'` among `reward_claims.status`'s allowed values
-- (`0012_campaigns.sql`), and `cancelled_reason text` already exists on the
-- table - both were provisioned ahead of this task and never had a writer
-- until now.
--
-- GUARDS, IN ORDER (doc 35 s6/s12 vocabulary). `cancel_claim` locks the claim
-- row FOR UPDATE first, exactly where `validate_redemption` (0013) takes its
-- own lock, so a concurrent staff redemption and a concurrent consumer cancel
-- of the SAME claim serialize on that row: whichever transaction commits
-- first wins, and the loser reads the winner's new status and raises a clean
-- typed error instead of racing the ledger.
--   * not found / not the caller's own claim -> FORBIDDEN (doc 13: never
--     distinguish "doesn't exist" from "exists but isn't yours" - mirrors
--     validate_redemption's own FORBIDDEN posture for both cases).
--   * status = 'redeemed'   -> CLAIM_ALREADY_REDEEMED (the race the brief
--     calls out: a staff redemption won).
--   * status = 'cancelled'  -> CLAIM_ALREADY_CANCELLED (idempotent: a second
--     cancel of the same claim never double-reverses).
--   * status <> 'claimed'   -> CLAIM_INVALID_STATE (covers 'expired': the
--     sweep already reversed this claim, so cancelling it now would be a
--     second, illegitimate reversal).
--   * otherwise: identical ledger semantics to a single-claim `expire_claims`
--     pass, via the shared helper.
--
-- VALIDATE_REDEMPTION'S OWN SIDE OF THE RACE. Before this migration,
-- `validate_redemption` had no way to name "the customer already cancelled
-- this" - a losing staff scan against a cancelled claim fell through its
-- generic `CLAIM_INVALID_STATE` branch. The brief is explicit that BOTH
-- sides of this race need "a clean typed error (CLAIM_ALREADY_REDEEMED /
-- CLAIM_ALREADY_CANCELLED)", so this migration re-creates
-- `validate_redemption` (signature UNCHANGED from 0013, still
-- `(uuid, text, text)`) with one added branch ahead of the existing
-- `CLAIM_INVALID_STATE` catch-all. Every other guard, the lock, and the
-- message strings are restated verbatim.
--
-- Source docs:
--   * docs/00-product/03-loyalty-benchmarks.md Key Finding 1 (the complaint
--     this task answers)
--   * supabase/migrations/0013_reward_claim_rpcs.sql (claim_reward's debit
--     shape; validate_redemption's claim-row lock and status guards, restated
--     here with one addition)
--   * supabase/migrations/0016_claim_expiry_sweep.sql (the reversal shape
--     this migration reuses rather than reinvents: reversal row, balance
--     cache restore, inventory restore under the total_inventory cap)
--   * supabase/migrations/0038_fixed_per_visit_visit_day.sql,
--     0041_campaign_budget_attribution.sql (the "one definition, every
--     caller reads it" precedent this migration's private helper follows)
-- ============================================================================

-- ---------------------------------------------------------------- private.reverse_claim_ledger
-- Not SECURITY DEFINER: both callers (cancel_claim, expire_claims) are
-- themselves SECURITY DEFINER and call this in the same transaction, under
-- locks they already hold (the claim row, and - when points_spent > 0 - the
-- business_customers pair row), so this helper takes no lock of its own and
-- trusts p_prev_balance as read by the caller under that lock, exactly as
-- 0016's inline block did before this refactor. Revoked from every role
-- including service_role, mirroring 0038/0041's private helpers: it is meant
-- to be reached only from inside a definer context that already holds the
-- right locks, never called directly.
create or replace function private.reverse_claim_ledger(
  p_claim_id      uuid,
  p_business_id   uuid,
  p_consumer_id   uuid,
  p_reward_id     uuid,
  p_points_spent  integer,
  p_points_txn_id uuid,
  p_prev_balance  integer,
  p_actor_id      uuid default null
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_campaign_id uuid;
begin
  -- Only when points actually moved at claim time (0013/0016: a free/
  -- loyalty-completion claim, points_spent = 0, wrote no redeem row and gets
  -- no reversal row either).
  if p_points_spent > 0 then
    -- carry campaign_id from the original redeem row when available (null
    -- when it cannot be resolved), matching 0016 verbatim.
    select pt.campaign_id
      into v_campaign_id
      from public.points_transactions pt
     where pt.id = p_points_txn_id;

    insert into public.points_transactions
      (business_id, consumer_id, type, points, balance_after,
       claim_id, campaign_id, reverses_id, created_by)
    values
      (p_business_id, p_consumer_id, 'reversal',
       p_points_spent, p_prev_balance + p_points_spent,
       p_claim_id, v_campaign_id, p_points_txn_id, p_actor_id);

    update public.business_customers
       set points_balance = p_prev_balance + p_points_spent,
           updated_by = p_actor_id
     where business_id = p_business_id
       and consumer_id = p_consumer_id;
  end if;

  -- Inventory restore, identical to 0016's guards: null stays null
  -- (unlimited never counted down), and the increment is capped so it can
  -- never push remaining past total_inventory
  -- (rewards_remaining_lte_total).
  update public.rewards
     set remaining = remaining + 1
   where id = p_reward_id
     and remaining is not null
     and (total_inventory is null or remaining < total_inventory);
end
$$;

revoke execute on function private.reverse_claim_ledger(uuid, uuid, uuid, uuid, integer, uuid, integer, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- cancel_claim
create or replace function public.cancel_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid           uuid := auth.uid();
  v_claim         record;
  v_prev_balance  integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;

  -- Lock the claim row FIRST, exactly where validate_redemption (0013) takes
  -- its own lock: a concurrent staff redemption and a concurrent consumer
  -- cancel of the SAME claim serialize here, so whichever transaction
  -- commits first is the one whose outcome sticks.
  select rc.business_id, rc.consumer_id, rc.reward_id, rc.status,
         rc.points_spent, rc.points_txn_id
    into v_claim
    from public.reward_claims rc
   where rc.id = p_claim_id
     for update;
  -- Unknown claim id and "exists but isn't yours" share one message (doc 13):
  -- probing random ids must not be an existence oracle for other consumers'
  -- claims.
  if not found or v_claim.consumer_id <> v_uid then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  if v_claim.status = 'redeemed' then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_REDEEMED';
  elsif v_claim.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_CANCELLED';
  elsif v_claim.status <> 'claimed' then
    -- covers 'expired': the sweep already reversed this claim once, so
    -- cancelling it now would double-refund.
    raise exception using errcode = 'P0001', message = 'CLAIM_INVALID_STATE';
  end if;

  -- Lock order matches claim_reward/expire_claims (business_customers after
  -- the claim row), so this can never deadlock against either. Taken
  -- unconditionally, exactly mirroring expire_claims's loop body: a claim
  -- (paid or free) can only exist because claim_reward's own step 1 already
  -- upserted this pair row, so "not found" only matters - and only raises -
  -- when points actually need to move.
  select bc.points_balance
    into v_prev_balance
    from public.business_customers bc
   where bc.business_id = v_claim.business_id
     and bc.consumer_id = v_claim.consumer_id
     for update;
  -- Defence in depth, mirroring 0013/0016: a missing pair row here means
  -- drift that must not silently mint or lose points.
  if not found and v_claim.points_spent > 0 then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

  -- Flip the claim FIRST: this is also the idempotency latch (mirrors 0016's
  -- own comment) - once 'cancelled', a second call reads status='cancelled'
  -- above and never reaches here again.
  update public.reward_claims
     set status = 'cancelled',
         cancelled_reason = 'consumer_cancelled',
         updated_by = v_uid
   where id = p_claim_id;

  perform private.reverse_claim_ledger(
    p_claim_id      => p_claim_id,
    p_business_id   => v_claim.business_id,
    p_consumer_id   => v_claim.consumer_id,
    p_reward_id     => v_claim.reward_id,
    p_points_spent  => v_claim.points_spent,
    p_points_txn_id => v_claim.points_txn_id,
    p_prev_balance  => coalesce(v_prev_balance, 0),
    p_actor_id      => v_uid);
end
$$;

-- Consumer-facing, matching claim_reward's own grant shape (0013): every
-- authenticated user may call it (the row lock + ownership check above scope
-- WHICH claim, not who may attempt), anon may not.
revoke execute on function public.cancel_claim(uuid) from public, anon;
grant execute on function public.cancel_claim(uuid) to authenticated;

-- ---------------------------------------------------------------- expire_claims
-- Re-created from the live 0016 definition. Signature UNCHANGED
-- (`(integer) returns integer`), so this is a plain `create or replace`.
-- Every guard, the "for update skip locked" candidate scan, the idempotency
-- latch (status flipped before any refund), and the return value are
-- restated verbatim; the only change is that the reversal block (the former
-- inline "carry campaign_id / insert reversal row / restore balance cache /
-- restore inventory" steps) is now one call into
-- private.reverse_claim_ledger, so this sweep and cancel_claim above can
-- never drift on what "reverse a claim" means.
create or replace function public.expire_claims(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim        record;
  v_prev_balance integer;
  v_expired      integer := 0;
begin
  for v_claim in
    select rc.id, rc.business_id, rc.reward_id, rc.consumer_id,
           rc.points_spent, rc.points_txn_id
      from public.reward_claims rc
     where rc.status = 'claimed'
       and rc.expires_at <= now()
     order by rc.expires_at
     limit p_limit
       for update skip locked
  loop
    select bc.points_balance
      into v_prev_balance
      from public.business_customers bc
     where bc.business_id = v_claim.business_id
       and bc.consumer_id = v_claim.consumer_id
       for update;
    if not found and v_claim.points_spent > 0 then
      raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
    end if;

    -- Idempotency latch: flip first, so a claim already swept is never
    -- re-selected by the candidate scan above.
    update public.reward_claims
       set status = 'expired'
     where id = v_claim.id;

    perform private.reverse_claim_ledger(
      p_claim_id      => v_claim.id,
      p_business_id   => v_claim.business_id,
      p_consumer_id   => v_claim.consumer_id,
      p_reward_id     => v_claim.reward_id,
      p_points_spent  => v_claim.points_spent,
      p_points_txn_id => v_claim.points_txn_id,
      p_prev_balance  => coalesce(v_prev_balance, 0),
      p_actor_id      => null);  -- system: no auth.uid() under service_role

    v_expired := v_expired + 1;
  end loop;

  return v_expired;
end
$$;

-- System sweep, service_role ONLY - unchanged from 0016.
revoke execute on function public.expire_claims(integer) from public, anon, authenticated;
grant execute on function public.expire_claims(integer) to service_role;

-- ---------------------------------------------------------------- validate_redemption
-- Re-created from the live 0013 definition. Signature UNCHANGED
-- (`(uuid, text, text) returns jsonb`). The only change is ONE new branch,
-- ahead of the existing CLAIM_INVALID_STATE catch-all: a staff scan that
-- loses the race to a consumer's cancel now names the reason
-- (CLAIM_ALREADY_CANCELLED) instead of falling into the generic
-- "cannot be redeemed right now" message. Every other guard, the claim-row
-- lock, the token/method validation, the redemptions insert, and the
-- returned payload are restated verbatim.
create or replace function public.validate_redemption(
  p_claim_id  uuid,
  p_token_jti text,
  p_method    text default 'qr'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := auth.uid();
  v_business_id uuid;
  v_consumer_id uuid;
  v_status      text;
  v_expires_at  timestamptz;
  v_reward_name text;
  v_segment     text;
  v_redeemed_at timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'UNAUTHENTICATED';
  end if;

  if nullif(trim(coalesce(p_token_jti, '')), '') is null then
    raise exception using errcode = 'P0001', message = 'REDEMPTION_TOKEN_INVALID';
  end if;
  if p_method not in ('qr', 'manual_code') then
    raise exception using errcode = 'P0001', message = 'REDEMPTION_METHOD_INVALID';
  end if;

  select rc.business_id, rc.consumer_id, rc.status, rc.expires_at, r.name
    into v_business_id, v_consumer_id, v_status, v_expires_at, v_reward_name
    from public.reward_claims rc
    join public.rewards r on r.id = rc.reward_id
   where rc.id = p_claim_id
     for update of rc;
  if not found then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  if not private.is_active_staff(v_business_id, array['owner','manager','staff']) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  -- s6 guard: claim must be sitting in 'claimed'. task 1.4: a claim the
  -- consumer just cancelled gets its own typed error rather than falling
  -- into the generic CLAIM_INVALID_STATE below, so a staff member who lost
  -- this exact race sees why.
  if v_status = 'redeemed' then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_REDEEMED';
  elsif v_status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_CANCELLED';
  elsif v_status <> 'claimed' then
    raise exception using errcode = 'P0001', message = 'CLAIM_INVALID_STATE';
  end if;

  if v_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'CLAIM_EXPIRED';
  end if;

  select bc.segment
    into v_segment
    from public.business_customers bc
   where bc.business_id = v_business_id
     and bc.consumer_id = v_consumer_id;
  if v_segment = 'blacklisted' then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_BLACKLISTED';
  end if;

  begin
    insert into public.redemptions
      (business_id, claim_id, validated_by, method, token_jti, created_by, updated_by)
    values
      (v_business_id, p_claim_id, v_uid, p_method, p_token_jti, v_uid, v_uid);
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_REDEEMED';
  end;

  v_redeemed_at := now();

  update public.reward_claims
     set status = 'redeemed', redeemed_at = v_redeemed_at, updated_by = v_uid
   where id = p_claim_id;

  return jsonb_build_object(
    'claim_id',      p_claim_id,
    'reward_name',   v_reward_name,
    'consumer_name', (select p.display_name from public.profiles p where p.id = v_consumer_id),
    'redeemed_at',   v_redeemed_at);
end
$$;

-- Unchanged from 0013.
revoke execute on function public.validate_redemption(uuid, text, text) from public, anon;
grant execute on function public.validate_redemption(uuid, text, text) to authenticated;
