-- ============================================================================
-- 0051_cancel_claim_review_fixes.sql
-- Review fixes for task 1.4 (0050_cancel_claim.sql).
--
-- M1 — a real silent behavior change 0050's own header denied. 0050's
-- private.reverse_claim_ledger unconditionally did
-- `update business_customers set points_balance = ..., updated_by =
-- p_actor_id`, and expire_claims calls it with `p_actor_id => null`
-- (system sweep, no auth.uid()). That meant every sweep run NOW NULLED
-- business_customers.updated_by, where 0016's own inline block (before the
-- 0050 refactor) touched `points_balance` only and left `updated_by`
-- whatever it already was. 0050's header claimed "the only change is that
-- the reversal block is now one call into private.reverse_claim_ledger" —
-- untrue as shipped.
--
-- THE FIX: `coalesce(p_created_by, business_customers.updated_by)`. A real
-- actor (cancel_claim, passing the consumer's auth.uid()) still stamps the
-- column, exactly as claim_reward already does on ITS OWN balance update;
-- a null actor (expire_claims, system) now leaves the column exactly as it
-- was, restoring 0016's real prior behavior. Referencing
-- `business_customers.updated_by` on the right-hand side of its own SET
-- clause reads the PRE-UPDATE value of that row, standard Postgres UPDATE
-- semantics.
--
-- M3 — the parameter was named `p_actor_id` but is written to
-- `points_transactions.created_by`, not `.actor_id` (that column is
-- reserved for staff/admin corrections per 0012's own comment: "staff/admin
-- for manual ops; null = system" — a consumer cancelling their own claim is
-- neither). Renamed to `p_created_by` so the parameter name stops implying
-- a column it never touches.
--
-- Both are pure renames/behavior-narrowings inside a plain (non-definer)
-- helper already revoked from every role, so no grant changes are needed;
-- cancel_claim and expire_claims are re-created (signatures UNCHANGED) only
-- to update their call sites' argument name.
--
-- M6 (review fix, discovered while pinning the grant matrix in pgTAP) —
-- cancel_claim additionally now revokes execute from service_role. 0050
-- only revoked from public/anon and granted to authenticated, on the
-- (wrong) assumption that revoking the implicit PUBLIC grant leaves
-- service_role with nothing; Supabase's project-level default privileges
-- grant EXECUTE on every new public-schema function to service_role
-- independently of that, so service_role could call this consumer-only
-- action. Harmless in practice (service_role is a trusted backend role,
-- and calling it would just cancel a claim exactly as the RPC already
-- guards), but cancel_claim is not a system job the way expire_claims is,
-- so the explicit revoke matches the principle-of-least-privilege posture
-- every other consumer-only entry point in this schema keeps.
--
-- Source docs:
--   * supabase/migrations/0050_cancel_claim.sql (the migration this corrects)
--   * supabase/migrations/0016_claim_expiry_sweep.sql (the prior behavior
--     being restored: business_customers.points_balance updated, updated_by
--     untouched)
--   * supabase/migrations/0013_reward_claim_rpcs.sql (claim_reward's own
--     `updated_by = v_uid` stamp on its business_customers update — the
--     precedent cancel_claim's real actor now correctly matches)
-- ============================================================================

-- Postgres refuses to rename a parameter via CREATE OR REPLACE
-- ("cannot change name of input parameter"); the signature (types) is
-- unchanged, only the name, so this is a drop-and-recreate of the same
-- identity, not a new overload.
drop function private.reverse_claim_ledger(uuid, uuid, uuid, uuid, integer, uuid, integer, uuid);

create function private.reverse_claim_ledger(
  p_claim_id      uuid,
  p_business_id   uuid,
  p_consumer_id   uuid,
  p_reward_id     uuid,
  p_points_spent  integer,
  p_points_txn_id uuid,
  p_prev_balance  integer,
  p_created_by    uuid default null
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_campaign_id uuid;
begin
  if p_points_spent > 0 then
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
       p_claim_id, v_campaign_id, p_points_txn_id, p_created_by);

    -- M1: coalesce, not overwrite. A real actor (cancel_claim) still
    -- stamps updated_by; a null actor (expire_claims, system) leaves the
    -- column exactly as it already was, matching 0016's own prior
    -- behavior (points_balance only).
    update public.business_customers
       set points_balance = p_prev_balance + p_points_spent,
           updated_by = coalesce(p_created_by, business_customers.updated_by)
     where business_id = p_business_id
       and consumer_id = p_consumer_id;
  end if;

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
-- Re-created from the live 0050 definition. Signature UNCHANGED
-- (`(uuid) returns void`); the only change is the renamed argument at the
-- reverse_claim_ledger call site (p_actor_id => v_uid becomes
-- p_created_by => v_uid). Every guard, lock, and message is restated
-- verbatim.
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

  select rc.business_id, rc.consumer_id, rc.reward_id, rc.status,
         rc.points_spent, rc.points_txn_id
    into v_claim
    from public.reward_claims rc
   where rc.id = p_claim_id
     for update;
  if not found or v_claim.consumer_id <> v_uid then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  if v_claim.status = 'redeemed' then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_REDEEMED';
  elsif v_claim.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'CLAIM_ALREADY_CANCELLED';
  elsif v_claim.status <> 'claimed' then
    raise exception using errcode = 'P0001', message = 'CLAIM_INVALID_STATE';
  end if;

  select bc.points_balance
    into v_prev_balance
    from public.business_customers bc
   where bc.business_id = v_claim.business_id
     and bc.consumer_id = v_claim.consumer_id
     for update;
  if not found and v_claim.points_spent > 0 then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_RECORD_MISSING';
  end if;

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
    p_created_by    => v_uid);
end
$$;

revoke execute on function public.cancel_claim(uuid) from public, anon, service_role;
grant execute on function public.cancel_claim(uuid) to authenticated;

-- ---------------------------------------------------------------- expire_claims
-- Re-created from the live 0050 definition. Signature UNCHANGED
-- (`(integer) returns integer`); the only change is the renamed argument
-- at the reverse_claim_ledger call site (p_actor_id => null becomes
-- p_created_by => null). Every guard and the candidate scan are restated
-- verbatim.
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
      p_created_by    => null);  -- system: no auth.uid() under service_role

    v_expired := v_expired + 1;
  end loop;

  return v_expired;
end
$$;

revoke execute on function public.expire_claims(integer) from public, anon, authenticated;
grant execute on function public.expire_claims(integer) to service_role;
