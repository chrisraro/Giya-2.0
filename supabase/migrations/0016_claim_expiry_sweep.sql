-- ============================================================================
-- 0016_claim_expiry_sweep.sql
-- Claim expiry sweep RPC. Fixes the gap where nothing ever flips a
-- reward_claims row from 'claimed' to 'expired': a consumer who claimed a
-- reward (points debited at claim time per 0013) and never redeemed it lost
-- those points forever, kept consuming a per_customer_limit slot, and kept
-- the reward's decremented inventory.
-- Source docs:
--   * docs/30-modules/35-points-engine.md section 6 "Claim expiry sweep":
--     for each status='claimed' with expires_at <= now(), set
--     status='expired'; insert points_transactions type='reversal',
--     points = +points_spent, reverses_id = points_txn_id, claim_id set;
--     restore balance; increment rewards.remaining (if tracked, capped by
--     rewards_remaining_lte_total). Worked example: balance 970, claim 500,
--     day 30 sweep writes reversal +500, balance_after 970, remaining 49 -> 50.
--   * docs/30-modules/35-points-engine.md section 5 (row lock on
--     business_customers is the correctness guarantee for balance_after).
-- Conventions per 0013 (security definer, set search_path = '', revoke/grant
-- pairing, stable message strings via raise exception using errcode).
-- ============================================================================

-- ---------------------------------------------------------------- expire_claims
-- Doc 35 s6 "Claim expiry sweep". Invoked by the jobs worker (queue
-- claims.expiry_sweep, hourly), never by a client: unlike claim_reward /
-- validate_redemption this is a system function, so it is granted to
-- service_role ONLY (see the revoke/grant pairing below). auth.uid() is null
-- under the service role, so ledger rows are written with created_by /
-- actor_id null, which the 0012 schema documents as "system".
--
-- Processes up to p_limit lapsed claims and returns how many it expired.
--
-- Idempotency: candidates are selected by status='claimed', and the first
-- thing each iteration does is flip that status to 'expired'. A claim already
-- swept is never re-selected, so re-running the sweep (job retry, overlapping
-- schedules) can never double-refund; a run with no candidates returns 0.
create or replace function public.expire_claims(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim        record;
  v_prev_balance integer;
  v_campaign_id  uuid;
  v_expired      integer := 0;
begin
  -- Candidate scan, driven by reward_claims_expiry_idx (partial index on
  -- expires_at where status='claimed', built in 0012 for exactly this sweep).
  -- "for update skip locked" is the standard queue-drain idiom: each row is
  -- locked as it is picked, and rows already locked by a concurrent sweep
  -- worker are skipped instead of waited on, so two overlapping workers
  -- partition the backlog between them and never block or double-process
  -- the same claim.
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
    -- s5 row lock, taken FIRST: lock order is business_customers then
    -- rewards, matching claim_reward (0013), so a sweep refunding a pair and
    -- a concurrent claim by the same pair can never deadlock. balance_after
    -- below is computed under this lock, keeping ledger order per pair
    -- strictly serialized.
    select bc.points_balance
      into v_prev_balance
      from public.business_customers bc
     where bc.business_id = v_claim.business_id
       and bc.consumer_id = v_claim.consumer_id
       for update;
    -- Defence in depth, mirroring 0013: a paid claim can only exist because
    -- claim_reward created the pair row, so a missing row here means drift
    -- that must not silently mint or lose points.
    if not found and v_claim.points_spent > 0 then
      raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
    end if;

    -- s6 sweep step 1: flip the claim. This is also the idempotency latch:
    -- once 'expired', the claim can never match the candidate scan again.
    update public.reward_claims
       set status = 'expired'
     where id = v_claim.id;

    -- s6 sweep step 2: refund, ONLY when points actually moved at claim
    -- time. points_spent = 0 (loyalty completion / gift) wrote no redeem row
    -- in 0013, so the sweep writes no reversal either: the ledger check
    -- points <> 0 would reject it and there is nothing to account for.
    if v_claim.points_spent > 0 then
      -- carry campaign_id from the original redeem row when available
      -- (null when the redeem row cannot be resolved)
      select pt.campaign_id
        into v_campaign_id
        from public.points_transactions pt
       where pt.id = v_claim.points_txn_id;

      -- reversal row per s6: points = +points_spent, reverses_id points at
      -- the original redeem txn, claim_id set (worked example: +500,
      -- balance_after back to 970)
      insert into public.points_transactions
        (business_id, consumer_id, type, points, balance_after,
         claim_id, campaign_id, reverses_id)
      values
        (v_claim.business_id, v_claim.consumer_id, 'reversal',
         v_claim.points_spent, v_prev_balance + v_claim.points_spent,
         v_claim.id, v_campaign_id, v_claim.points_txn_id);

      -- s6 sweep step 3: restore the balance cache in the same transaction
      update public.business_customers
         set points_balance = v_prev_balance + v_claim.points_spent
       where business_id = v_claim.business_id
         and consumer_id = v_claim.consumer_id;
    end if;

    -- s6 sweep step 4: restore inventory (worked example: remaining 49 -> 50).
    -- Two guards, both required:
    --   * "remaining is not null": null means unlimited inventory; it never
    --     counted down at claim time (0013), so it must stay null here, not
    --     become 1.
    --   * "total_inventory is null or remaining < total_inventory": the
    --     increment is capped so it can never push remaining past
    --     total_inventory and violate rewards_remaining_lte_total (doc 35 s6:
    --     "capped by rewards_remaining_lte_total"). A no-op here (drift, or
    --     total_inventory lowered after the claim) is preferred over aborting
    --     the whole sweep on the check constraint.
    update public.rewards
       set remaining = remaining + 1
     where id = v_claim.reward_id
       and remaining is not null
       and (total_inventory is null or remaining < total_inventory);

    v_expired := v_expired + 1;
  end loop;

  return v_expired;
end
$$;

-- System sweep, service_role ONLY. Deliberately narrower than claim_reward /
-- validate_redemption (granted to authenticated in 0013): no consumer or
-- staff member may ever drain the expiry queue, only the jobs worker.
revoke execute on function public.expire_claims(integer) from public, anon, authenticated;
grant execute on function public.expire_claims(integer) to service_role;
