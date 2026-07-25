-- ============================================================================
-- 0013_reward_claim_rpcs.sql
-- Atomic reward claim + counter validation RPCs. With the ledger insert revoke
-- and the balance-cache column fence at the bottom of this file, these
-- SECURITY DEFINER functions become the ONLY client write path into the
-- points_transactions ledger and its derived balance caches.
-- Source docs:
--   * docs/30-modules/35-points-engine.md section 6 (claim steps 1-6,
--     redeem-at-counter guards, worked example 970 -> claim 500 -> 470)
--   * docs/30-modules/34-campaign-engine.md section 5 (budget enforcement:
--     campaign-scoped per_customer_limit, max_redemptions) and section 12
--     (CAMPAIGN_LIMIT_REACHED / CAMPAIGN_BUDGET_EXHAUSTED error registry)
--   * docs/20-data/23-schema-campaigns.md (integrity table: stock never
--     oversold, one redemption per claim, balance never negative)
--   * docs/00-product/01-personas-roles.md permission matrix ("Validate
--     redemption (QR)": owner, manager, staff; NOT marketing)
-- Conventions per 0003 (security definer, set search_path = '', revoke/grant
-- pairing) and 0012 (ledger fence). Every guard raises a stable message string
-- that the app layer maps to the doc 35 section 12 error registry.
-- ============================================================================

-- ---------------------------------------------------------------- claim_reward
-- Doc 35 s6 "Claim", one atomic transaction. The per-pair Redis lock of doc 35
-- s5 lives in the service layer; the row lock taken here on business_customers
-- is the correctness guarantee (balance_after computed under it, ledger order
-- per pair strictly serialized).
-- Step order (s6): 1 guards -> 2 inventory -> 3 balance -> 5 claim insert ->
-- 4 ledger insert -> 6 balance cache update. Steps 4/5 swap textual order only
-- because points_transactions.claim_id references the claim row; both happen
-- in the same transaction, so atomicity is unchanged.
create or replace function public.claim_reward(p_reward_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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
  v_txn_id               uuid;
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
  -- consumers). Checked here, inside the same transaction as the conditional
  -- inventory decrement below, so the cap cannot be raced past.
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

  -- s6 step 5: the claim row (inserted before the ledger row so the redeem
  -- ledger entry can carry claim_id; same transaction either way)
  insert into public.reward_claims
    (business_id, reward_id, consumer_id, status, points_spent, expires_at,
     created_by, updated_by)
  values
    (v_business_id, p_reward_id, v_uid, 'claimed', v_points_cost,
     now() + make_interval(days => v_claim_expiry_days), v_uid, v_uid)
  returning id into v_claim_id;

  -- s6 steps 4 + 6: exactly one redeem ledger row, and the balance cache
  -- maintained in the same transaction. When points_cost = 0 (loyalty
  -- completion / gift) NO ledger row is written at all (points <> 0 check
  -- would reject it, and there is nothing to account for) and the balance
  -- is untouched.
  if v_points_cost > 0 then
    insert into public.points_transactions
      (business_id, consumer_id, type, points, balance_after,
       claim_id, campaign_id, created_by)
    values
      (v_business_id, v_uid, 'redeem', -v_points_cost,
       v_prev_balance - v_points_cost, v_claim_id, v_campaign_id, v_uid)
    returning id into v_txn_id;

    update public.reward_claims
       set points_txn_id = v_txn_id, updated_by = v_uid
     where id = v_claim_id;

    update public.business_customers
       set points_balance = v_prev_balance - v_points_cost, updated_by = v_uid
     where business_id = v_business_id
       and consumer_id = v_uid;
  end if;

  return v_claim_id;
end
$$;

revoke execute on function public.claim_reward(uuid) from public, anon;
grant execute on function public.claim_reward(uuid) to authenticated;

-- ---------------------------------------------------------------- validate_redemption
-- Doc 35 s6 "Redeem at counter". The one-time token (TTL, Redis jti lock) is
-- verified in the service layer; p_token_jti is persisted here so the
-- redemptions.token_jti unique constraint makes replays impossible even if the
-- Redis check is bypassed. Staff authz per the permission matrix: owner,
-- manager, staff may validate; marketing may not.
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

  -- Input guards. A null/blank jti would silently defeat replay protection:
  -- redemptions.token_jti is a nullable unique column and unique constraints
  -- permit unlimited nulls, so every null-jti replay would insert cleanly.
  if nullif(trim(coalesce(p_token_jti, '')), '') is null then
    raise exception using errcode = 'P0001', message = 'REDEMPTION_TOKEN_INVALID';
  end if;
  if p_method not in ('qr', 'manual_code') then
    raise exception using errcode = 'P0001', message = 'REDEMPTION_METHOD_INVALID';
  end if;

  -- Load claim + reward; lock the claim row so concurrent validations of the
  -- same claim serialize (the unique constraint below is the backstop).
  select rc.business_id, rc.consumer_id, rc.status, rc.expires_at, r.name
    into v_business_id, v_consumer_id, v_status, v_expires_at, v_reward_name
    from public.reward_claims rc
    join public.rewards r on r.id = rc.reward_id
   where rc.id = p_claim_id
     for update of rc;
  if not found then
    -- unknown claim id: same message as the authz failure below, so probing
    -- random ids is not an existence oracle for other tenants' claims
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  -- staff authz: matrix "Validate redemption (QR)" = owner, manager, staff
  if not private.is_active_staff(v_business_id, array['owner','manager','staff']) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  -- s6 guard: claim must be sitting in 'claimed'
  if v_status = 'redeemed' then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_REDEEMED';
  elsif v_status <> 'claimed' then
    raise exception using errcode = 'P0001', message = 'CLAIM_INVALID_STATE';
  end if;

  -- s6 guard: claim not expired
  if v_expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'CLAIM_EXPIRED';
  end if;

  -- s6 guard: consumer not blacklisted at redemption time
  select bc.segment
    into v_segment
    from public.business_customers bc
   where bc.business_id = v_business_id
     and bc.consumer_id = v_consumer_id;
  if v_segment = 'blacklisted' then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_BLACKLISTED';
  end if;

  -- doc 23 integrity: one redemption per claim (claim_id unique). A concurrent
  -- double scan that beat the row lock resolves here; token_jti unique catches
  -- token replay the same way.
  begin
    insert into public.redemptions
      (business_id, claim_id, validated_by, method, token_jti, created_by, updated_by)
    values
      (v_business_id, p_claim_id, v_uid, p_method, p_token_jti, v_uid, v_uid);
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_REDEEMED';
  end;

  v_redeemed_at := now();

  -- Flip the claim. NO ledger entry here: the points moved at claim time
  -- (doc 35 s6, worked example: final balance is the post-claim balance).
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

revoke execute on function public.validate_redemption(uuid, text, text) from public, anon;
grant execute on function public.validate_redemption(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- ledger write fence
-- 0012 already revoked update/delete/truncate from every app role and RLS has
-- no client insert policy. Revoking insert from the client roles closes the
-- remaining gap at the privilege layer: the SECURITY DEFINER RPCs above (and
-- service-role jobs such as the award pipeline and expiry sweeps) are now the
-- only write path into the ledger.
revoke insert on public.points_transactions from anon, authenticated;

-- ---------------------------------------------------------------- balance cache fence
-- points_balance, lifetime_points, lifetime_spend_centavos and visit_count on
-- business_customers are ledger-derived caches: only the SECURITY DEFINER RPCs
-- (running as the definer, unaffected by these grants) and service-role jobs
-- may write them. Without this fence an owner/manager could UPDATE
-- points_balance directly through the 0002 staff policy and the default table
-- grant, minting a balance with no ledger row behind it.
-- Postgres note: revoking a column privilege is a no-op while a table-level
-- UPDATE grant remains, so revoke the table-level privilege and grant back
-- exactly the staff-editable columns: segment and notes per the permission
-- matrix (doc 01), plus updated_by so those writes can stamp the actor.
-- RLS (0002) still scopes WHICH rows staff may update.
revoke update on public.business_customers from anon, authenticated;
grant update (segment, notes, updated_by) on public.business_customers to authenticated;
