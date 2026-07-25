-- ============================================================================
-- 0015_campaign_budget_lock.sql
-- Close a campaign-budget overshoot race in claim_reward.
--
-- The business_customers pair lock serializes claims per (business, consumer),
-- which makes both per-customer guards race-safe. The campaign-wide counts had
-- no campaign-level lock, so two DIFFERENT consumers claiming concurrently
-- could each read count < cap and both insert, letting a campaign exceed its
-- max_redemptions budget by the number of in-flight claims. Points integrity
-- was never at risk (no ledger corruption, no oversell: that guard is a
-- conditional update), but the budget guarantee was.
--
-- Fix: take a row lock on the campaign before any campaign-wide count, and
-- only when a cap is actually configured, so uncapped campaigns keep their
-- fully parallel claim throughput. Lock order stays business_customers (pair)
-- -> campaigns -> rewards, so no new deadlock cycle is introduced.
--
-- This is otherwise the 0013 function verbatim (re-stated in full because
-- create or replace requires the whole body).
-- ============================================================================

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
$function$;

revoke execute on function public.claim_reward(uuid) from public, anon;
grant execute on function public.claim_reward(uuid) to authenticated;
