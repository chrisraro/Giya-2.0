-- ============================================================================
-- 0041_campaign_budget_attribution.sql
-- Review fix (task 1.2, C1): meter campaign budgets in the right currency.
--
-- THE DEFECT 0040 SHIPPED WITH. `points_transactions.points` is the WHOLE
-- RECEIPT's total, and `points_transactions.campaign_id` names only the
-- PRIMARY applied campaign (doc 35 step 9: "the primary applied campaign or
-- null"). 0040's guard summed `points` filtered by `campaign_id = X` as its
-- running total for X's `max_total_points` - which is wrong in both
-- directions doc 34 section 5's own naive formula does not anticipate:
--   * a 340-point receipt where campaign X contributed a 150-point bonus
--     stacked under a different primary campaign counts the FULL 340 against
--     X's budget - premature auto-pause and a false "budget exhausted" email
--     for a campaign that only ever gave away 150 of its cap;
--   * a stacked, non-primary, capped campaign's `campaign_id` never appears
--     on any earn row at all, so its running total reads 0 forever - the
--     ORIGINAL over-grant defect this task exists to close, still open.
-- Doc 34 section 5 prescribes the naive `sum(points) where campaign_id = $1`
-- formula, so this was a doc defect inherited verbatim, not an invention of
-- 0040's - see the amendment to docs/30-modules/34-campaign-engine.md section
-- 5 landing alongside this migration.
--
-- THE FIX. `rule_snapshot` already freezes, per multiplier/bonus rule
-- actually applied, which campaign it belongs to (`enrichRuleSnapshot` in
-- award.ts has decorated every entry with `campaign_id` since campaign
-- stacking shipped, well before this task) and how many points that ONE
-- rule contributed (`points_delta` for a multiplier's extra, `bonus_points`
-- for a bonus - never derived from the other). That is the ONLY currency a
-- per-campaign budget can honestly be metered in, so this migration adds one
-- new pure helper, `private.campaign_earn_contribution(rule_snapshot,
-- campaign_id)`, that sums exactly those two arrays' entries matching the
-- target campaign - and two aggregate wrappers built on it,
-- `private.campaign_points_awarded` (the running total, doc 34's
-- `max_total_points`) and `private.campaign_customer_earn_count` (the
-- award-time `per_customer_limit`), each expressed as ONE SQL aggregate
-- (task 1.2 review I3: no unbounded fetch-all-rows-and-sum-in-JS, on either
-- side of the wire - `award_receipt_points` step 4c below and
-- `src/features/campaigns/server/exhaustion.ts`'s pause check both now call
-- through this same definition, mirroring 0038's "ONE PREDICATE, TWO
-- CALLERS" shape exactly, public definer wrappers included for the
-- TypeScript advisory reads).
--
-- A CLAWED-BACK EARN NEVER "AWARDED" ITS CONTRIBUTION, mirroring 0039's own
-- fix to `fixed_per_visit_already_paid` for the identical reason: a
-- `clawback`/`reversal` row never mutates the original earn row (0012:
-- "corrections are compensating entries ... never mutations"), so without
-- this exclusion a reversed campaign contribution would go on counting
-- against that campaign's budget and that consumer's limit forever.
--
-- BACKFILL POSTURE, STATED PLAINLY. This attribution reads `rule_snapshot`,
-- which has carried `campaign_id` per multiplier/bonus entry since campaign
-- stacking first shipped (pre-dating this task); no row in this schema's
-- history lacks it. If a FUTURE engine version ever stopped writing that
-- decoration, an old row would simply contribute 0 to this aggregate - the
-- same "under-count rather than crash" posture 0038's own header states for
-- its equivalent read - and that is a documented, accepted risk of this
-- shape, not a migration this file performs.
--
-- STEP 4c'S OWN CHANGE. Its guard logic (lock the campaign row, compare
-- `awarded + entry.points` to `max_total_points`, compare
-- `earn_count` to `per_customer_limit`) is UNCHANGED; only the SOURCE of
-- `v_campaign_awarded`/`v_campaign_earn_count` moves from a naive
-- `points`/`campaign_id` filter to these two new aggregate functions. The
-- comment claiming the `business_customers` lock alone made the
-- `per_customer_limit` half race-safe is corrected: that lock serializes
-- THIS consumer's own concurrent awards, but a `per_customer_limit`-only
-- campaign that TypeScript never listed in `p_campaign_budget_checks` had
-- NOTHING checking it here at all (review I1) - the actual fix for that is
-- on the TypeScript side (award.ts now arms this guard whenever EITHER cap
-- is configured, not only `max_total_points`), and this migration only fixes
-- the stale comment that misdescribed the guard as already covering it.
--
-- Source docs:
--   * docs/30-modules/34-campaign-engine.md section 5 (amended alongside
--     this migration for the correct attribution formula)
--   * docs/30-modules/35-points-engine.md section 9 ("frozen shape", the
--     rule_snapshot this reads), section 11 ("one implementation of the
--     rule math" - this migration reads that ONE implementation's output,
--     never recomputes it)
--   * supabase/migrations/0038_fixed_per_visit_visit_day.sql (the
--     private/public definer-wrapper shape this mirrors),
--     0039_fixed_per_visit_excludes_clawback.sql (the reverses_id exclusion
--     this mirrors),
--     0040_campaign_budget_award_guard.sql (the guard this corrects)
-- ============================================================================

-- ---------------------------------------------------------- the shared predicate
-- Pure: depends only on its arguments, never touches a table. `coalesce(...,
-- '[]'::jsonb)` treats a snapshot with no multipliers/bonuses key (the
-- pre-campaign-engine shape, if one ever existed) the same as an empty array
-- rather than raising on a null jsonb_array_elements. Casts to integer, not
-- numeric: every points_delta/bonus_points this engine ever writes is a whole
-- number (doc 35's arithmetic rounds every contribution before it is frozen).
create or replace function private.campaign_earn_contribution(
  p_rule_snapshot jsonb,
  p_campaign_id   uuid
) returns integer
language sql
immutable
set search_path = ''
as $$
  select coalesce((
    select sum((m->>'points_delta')::integer)
      from jsonb_array_elements(coalesce(p_rule_snapshot->'multipliers', '[]'::jsonb)) m
     where (m->>'campaign_id')::uuid = p_campaign_id
  ), 0)
  +
  coalesce((
    select sum((b->>'bonus_points')::integer)
      from jsonb_array_elements(coalesce(p_rule_snapshot->'bonuses', '[]'::jsonb)) b
     where (b->>'campaign_id')::uuid = p_campaign_id
  ), 0);
$$;

revoke execute on function private.campaign_earn_contribution(jsonb, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------- running total (max_total_points)
create or replace function private.campaign_points_awarded(
  p_business_id uuid,
  p_campaign_id uuid
) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(private.campaign_earn_contribution(pt.rule_snapshot, p_campaign_id)), 0)::integer
    from public.points_transactions pt
   where pt.business_id = p_business_id
     and pt.type = 'earn'
     and pt.points > 0
     -- M-a-equivalent (mirrors 0039): a clawed-back/reversed earn never
     -- actually spent this campaign's budget.
     and not exists (
       select 1 from public.points_transactions rev
        where rev.reverses_id = pt.id
          and rev.type in ('clawback', 'reversal')
     );
$$;

revoke execute on function private.campaign_points_awarded(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------- per-customer count (per_customer_limit)
create or replace function private.campaign_customer_earn_count(
  p_business_id uuid,
  p_campaign_id uuid,
  p_consumer_id uuid
) returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
    from public.points_transactions pt
   where pt.business_id = p_business_id
     and pt.consumer_id = p_consumer_id
     and pt.type = 'earn'
     and pt.points > 0
     and private.campaign_earn_contribution(pt.rule_snapshot, p_campaign_id) > 0
     and not exists (
       select 1 from public.points_transactions rev
        where rev.reverses_id = pt.id
          and rev.type in ('clawback', 'reversal')
     );
$$;

revoke execute on function private.campaign_customer_earn_count(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------- public wrappers (TypeScript advisory reads)
-- `private` is not in PostgREST's exposed schema list (same note 0038 makes
-- for its own wrapper): `resolveCampaignBudgets`'s advisory precheck and
-- `pauseExhaustedCampaigns`'s post-commit exhaustion check both need a
-- `public` entry point. SECURITY DEFINER so the call succeeds despite the
-- private helpers above being revoked from every role including service_role
-- - the same posture `public.fixed_per_visit_already_paid` already has.
create or replace function public.campaign_points_awarded(
  p_business_id uuid,
  p_campaign_id uuid
) returns integer
language sql
security definer
stable
set search_path = ''
as $$
  select private.campaign_points_awarded(p_business_id, p_campaign_id);
$$;

revoke execute on function public.campaign_points_awarded(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.campaign_points_awarded(uuid, uuid)
  to service_role;

create or replace function public.campaign_customer_earn_count(
  p_business_id uuid,
  p_campaign_id uuid,
  p_consumer_id uuid
) returns integer
language sql
security definer
stable
set search_path = ''
as $$
  select private.campaign_customer_earn_count(p_business_id, p_campaign_id, p_consumer_id);
$$;

revoke execute on function public.campaign_customer_earn_count(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.campaign_customer_earn_count(uuid, uuid, uuid)
  to service_role;

-- ---------------------------------------------------------- award_receipt_points
-- Signature UNCHANGED from 0040 (still the 7-arg form), so this is a plain
-- `create or replace`; only step 4c's body changes, swapping the naive
-- points/campaign_id filter for the two aggregate functions above. Every
-- other step, guard, and message is restated verbatim.
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

  select r.id, r.business_id, r.user_id, r.status, r.receipt_date, r.created_at
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

  -- Step 4c (task 1.2; review C1 fix, 0041). Runs only when the caller sends
  -- p_campaign_budget_checks - i.e. only when priceReceipt's own advisory
  -- pass found at least one surviving contribution from a campaign with
  -- EITHER max_total_points or per_customer_limit set (review I1: armed for
  -- either cap, not only max_total_points - see award.ts). The campaigns row
  -- is locked before either count, mirroring 0015's claim_reward precedent
  -- ("lock the campaign row before ANY campaign-wide count, and only when a
  -- cap is actually configured"). Order by campaign_id so two concurrent
  -- awards naming the SAME set of multiple campaigns cannot deadlock against
  -- each other by locking them in different orders.
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

      -- doc 34 section 5's running-total formula, CORRECTLY ATTRIBUTED
      -- (review C1): private.campaign_points_awarded sums each earn row's
      -- OWN contribution to THIS campaign from its frozen rule_snapshot,
      -- never the row's whole-receipt points total. "total + pending_award
      -- > max_total_points" skips the contribution; here that skip is this
      -- call refusing so award.ts can retry without it (see 0040's header on
      -- why a refusal, not a partial commit).
      if v_max_total_points is not null then
        v_campaign_awarded := private.campaign_points_awarded(v_receipt.business_id, v_budget_check.campaign_id);
        if v_campaign_awarded + v_budget_check.points > v_max_total_points then
          raise exception using errcode = 'P0001', message = 'CAMPAIGN_BUDGET_RACE';
        end if;
      end if;

      -- doc 34 section 5's award-time per_customer_limit, CORRECTLY
      -- ATTRIBUTED (review C1): counts this consumer's earn rows whose
      -- rule_snapshot attributes a POSITIVE contribution to this campaign,
      -- never rows merely naming it as the receipt's primary campaign_id.
      -- Review I1 correction: the business_customers lock above serializes
      -- this consumer's OWN concurrent awards, which is necessary but not
      -- sufficient - a per_customer_limit-only campaign this loop never
      -- receives an entry for (because award.ts never sent one) has NOTHING
      -- re-checking it here regardless of any lock. The actual fix is that
      -- award.ts now sends an entry whenever EITHER cap is configured, not
      -- only max_total_points, so this branch is reached for it.
      if v_per_customer_limit is not null then
        v_campaign_earn_count := private.campaign_customer_earn_count(
          v_receipt.business_id, v_budget_check.campaign_id, v_receipt.user_id);
        if v_campaign_earn_count >= v_per_customer_limit then
          raise exception using errcode = 'P0001', message = 'CAMPAIGN_BUDGET_RACE';
        end if;
      end if;
    end loop;
  end if;

  insert into public.points_transactions
    (business_id, consumer_id, type, points, balance_after,
     receipt_id, campaign_id, rule_snapshot, expires_at)
  values
    (v_receipt.business_id, v_receipt.user_id, 'earn', p_points,
     v_prev_balance + p_points,
     p_receipt_id, p_campaign_id, p_rule_snapshot, p_expires_at)
  returning id into v_txn_id;

  update public.business_customers bc
     set points_balance  = v_prev_balance + p_points,
         lifetime_points = bc.lifetime_points + p_points
   where bc.business_id = v_receipt.business_id
     and bc.consumer_id = v_receipt.user_id;

  perform private.apply_receipt_visit(p_receipt_id);

  update public.receipts
     set processed_at = now()
   where id = p_receipt_id;

  return v_txn_id;
end
$$;

-- System function, service_role ONLY. Signature unchanged from 0040, so this
-- restates the existing grant pair rather than widening or narrowing it.
revoke execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)
  to service_role;
