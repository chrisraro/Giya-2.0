-- ============================================================================
-- 0082_validate_redemption_server_only.sql
-- Fix: staff could redeem a customer's claim WITHOUT the customer's QR token.
--
-- validate_redemption (0050) was EXECUTE-able by `authenticated` and checked
-- only that p_token_jti was non-blank. The signature and single-use checks on
-- the token live in the Next route (consumeRedemptionToken), so any active
-- staff member could POST /rest/v1/rpc/validate_redemption with their own
-- session, any claim id of their business and an invented jti, and mark a
-- customer's paid-for claim redeemed with no customer present - defeating doc
-- 15's signed, single-use token control. It also let staff redeem their own
-- claims with no second party.
--
-- Now:
--   * validate_redemption_as(claim, jti, method, actor) - 0050's body verbatim
--     except: the actor is explicit (the route passes the verified session
--     user, AFTER consuming the token), staff membership is checked by table
--     truth for that actor, and a self-redemption is refused. Service role only.
--   * validate_redemption(uuid, text, text) loses every client grant. Kept, not
--     dropped, so a deploy that lands the DB change before the app change fails
--     closed (permission denied) instead of erroring on an unknown function.
-- App side: src/features/rewards/server/service.ts validateRedemption.
-- ============================================================================

create or replace function public.validate_redemption_as(
  p_claim_id  uuid,
  p_token_jti text,
  p_method    text,
  p_actor_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := p_actor_id;
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

  -- Staff membership by TABLE TRUTH for the explicit actor: is_active_staff
  -- reads auth.uid(), which is null under the service role this runs as.
  -- Same predicate otherwise (0010).
  if not exists (
    select 1 from public.business_staff bs
     where bs.business_id = v_business_id
       and bs.user_id     = v_uid
       and bs.status      = 'active'
       and bs.role        = any (array['owner','manager','staff'])
  ) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  -- 0082: nobody validates their own claim. A redemption is the counter
  -- confirming a CUSTOMER is present; a staff member redeeming their own
  -- claim has no second party at all.
  if v_consumer_id = v_uid then
    raise exception using errcode = 'P0001', message = 'SELF_REDEMPTION_FORBIDDEN';
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

revoke execute on function public.validate_redemption_as(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.validate_redemption_as(uuid, text, text, uuid)
  to service_role;

revoke execute on function public.validate_redemption(uuid, text, text)
  from public, anon, authenticated;
