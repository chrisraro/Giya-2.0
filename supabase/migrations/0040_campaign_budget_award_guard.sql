-- ============================================================================
-- 0040_campaign_budget_award_guard.sql
-- Award-time campaign budget enforcement (task 1.2).
--
-- THE DEFECT. Doc 34 (docs/30-modules/34-campaign-engine.md) section 5
-- requires two budget guardrails on multiplier/bonus campaign contributions
-- AT AWARD TIME:
--   * `max_total_points` - a running cap: "if total + pending_award >
--     max_total_points, the campaign's multiplier/bonus is skipped for this
--     receipt (base points still awarded) and exhaustion fires".
--   * `per_customer_limit` - "award time for multiplier/bonus campaigns
--     (counts that consumer's positive points_transactions with this
--     campaign_id)".
-- Neither was enforced. `award_receipt_points` (0018/0037/0038) wrote
-- whatever `p_points`/`p_campaign_id` the caller supplied with no check
-- against the campaign's own budget, so a multiplier/bonus campaign could
-- over-grant forever and a consumer could benefit from a bonus campaign an
-- unlimited number of times.
--
-- THE FIX HAS TWO HALVES, exactly the shape 0037/0038 used for the
-- fixed_per_visit dedupe, and for the same reason (doc 35 section 11 "one
-- implementation of the rule math"):
--   1. The ARITHMETIC - which candidate contributes how much, and which
--      contribution gets dropped ENTIRELY (doc 34: "skip, do not partially
--      award") - is TypeScript, in `resolveCampaignBudgets` and the
--      surrounding `priceReceipt` changes
--      (src/features/receipts/server/award.ts). It runs a TRIAL pricing pass
--      over the full stacked candidate set through the SAME pure engine
--      (`computePoints`) to learn each campaign-linked rule's raw
--      contribution, decides drops from that, and reprices once more with
--      the survivors - never a second implementation of doc 34 section 6's
--      additive-extras arithmetic in SQL.
--   2. RACE SAFETY is this migration's job. `priceReceipt`'s reads (the
--      running total, the customer's earn count) are ordinary, unlocked
--      selects: two concurrent awards against the SAME campaign, by
--      DIFFERENT consumers, could each read "room left" before either
--      commits and both mint past the cap. The `business_customers` row
--      lock `award_receipt_points` already takes (0018 step 4) serializes
--      concurrent awards for one (business, consumer) PAIR - exactly what
--      makes `per_customer_limit` naturally race-safe already, since it only
--      ever reads THAT consumer's own transactions - but it does nothing for
--      two DIFFERENT consumers hitting the same `max_total_points` budget.
--      This migration adds one new parameter,
--      `p_campaign_budget_checks` (jsonb array of `{campaign_id, points}`,
--      default null so every existing caller is unaffected), and one new
--      guard, mirroring how 0015 hardened `claim_reward`'s campaign-wide
--      counts: lock the `campaigns` row before re-checking its running
--      total/customer count, and refuse with `CAMPAIGN_BUDGET_RACE` if the
--      caller's own advisory read was stale. `award.ts` sends one entry per
--      SURVIVING campaign-capped contribution (i.e. after its own advisory
--      drop already ran) - so this recheck only ever has to catch the
--      genuine cross-consumer race, not repeat work `priceReceipt` already
--      did correctly.
--
-- WHY REFUSE RATHER THAN SELF-CORRECT, AND WHY THAT DOES NOT BREAK "DROP,
-- DO NOT FAIL THE AWARD". Recomputing a reduced total here would mean a
-- second implementation of the stacking arithmetic, which is precisely what
-- doc 35 section 11 forbids. Doc 34's "the whole contribution from that
-- campaign drops, other campaigns/base still pay" is honoured NOT by this
-- RPC call succeeding with a partial total, but by `award.ts` catching
-- CAMPAIGN_BUDGET_RACE and retrying ONCE with `plan.budgetRaceFallback` - a
-- plan computed by the SAME pure engine with every campaign-capped
-- contribution already dropped (the same recovery shape 0037/0038's
-- FIXED_PER_VISIT_RACE established). This refusal costs one extra round trip
-- on the rare genuine race; over-awarding past a campaign's budget costs a
-- real, unrecoverable ledger drift - the same trade 0018's own header
-- accepts ("over-award is the expensive direction to be wrong in").
--
-- ON EXHAUSTION. Doc 34 section 5 also requires the campaign to auto-pause
-- (T5, system actor), be audited, and notify its owner once
-- `max_total_points` is fully spent. None of that belongs inside this
-- ledger-writing transaction: "the pause must not fail the award" (doc 34),
-- so it is entirely POST-COMMIT TypeScript
-- (`src/features/campaigns/server/exhaustion.ts`'s `pauseExhaustedCampaigns`,
-- called by `award.ts` after `award_receipt_points`/`record_receipt_visit`
-- has already returned). This migration's ONLY exhaustion-adjacent change is
-- registering the new notification kind in `notifications.kind`'s check
-- constraint, mirroring the parenthetical note on why THAT column enumerates
-- values (0026's header) while `audit_logs.action` (0022) does not: a
-- notification write is fail-soft (`raise.ts` swallows every error and the
-- award stands regardless), so the value list is cheap to enforce and worth
-- enforcing.
--
-- WHAT DOES NOT CHANGE. Every existing guard, the lock order
-- (receipts -> business_customers -> [NEW] campaigns), the
-- fixed_per_visit dedupe (step 4b, untouched), and the FIXED_PER_VISIT_RACE
-- message are unchanged: this is the same function, re-created from the live
-- 0038 definition with exactly one new parameter and one new guard block
-- inserted after step 4b and before the earn insert. Lock order matches
-- 0015's own claim_reward precedent (business_customers -> campaigns), so no
-- new deadlock cycle is introduced.
--
-- Source docs:
--   * docs/30-modules/34-campaign-engine.md section 5 (budget guardrails,
--     the running-total formula, the per_customer_limit award-time scope,
--     "On exhaustion") and section 6 (stacking/additive-extras, the reason
--     the arithmetic stays in TypeScript)
--   * docs/30-modules/35-points-engine.md section 11 ("one implementation of
--     the rule math")
--   * supabase/migrations/0015_campaign_budget_lock.sql (the claim-time
--     precedent this mirrors: lock the campaign row before any campaign-wide
--     count, only when a cap is configured)
--   * supabase/migrations/0037_fixed_per_visit_dedup.sql,
--     0038_fixed_per_visit_visit_day.sql (the advisory-precheck +
--     authoritative-RPC-recheck + non-terminal-race-recovery shape this
--     migration and award.ts's own changes both mirror)
-- ============================================================================

-- ---------------------------------------------------------- notifications.kind
-- Registers `campaign_budget_exhausted` (doc 30 section 5.3's staff-facing
-- row, src/features/notifications/kinds.ts). Postgres auto-named this
-- unnamed column check `notifications_kind_check` in 0026; dropped and
-- re-added with the one new value rather than widened in place, since a
-- CHECK constraint's definition can only be replaced wholesale.
alter table public.notifications
  drop constraint notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in (
    'points_awarded',
    'receipt_rejected',
    'receipt_in_review',
    'reward_claimed',
    'reward_expiring',
    'campaign_budget_exhausted'
  ));

-- ---------------------------------------------------------- award_receipt_points
-- Postgres identifies a function by its parameter TYPE list; adding a 7th
-- parameter would otherwise leave the live 6-arg overload behind rather than
-- replacing it in place (0037's own note, still true here). Dropped first so
-- there is exactly one `award_receipt_points` afterwards.
drop function if exists public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean);

create or replace function public.award_receipt_points(
  p_receipt_id    uuid,
  p_points        integer,
  p_rule_snapshot jsonb       default null,
  p_campaign_id   uuid        default null,
  p_expires_at    timestamptz default null,
  p_verify_no_prior_fixed_visit_earn boolean default false,
  -- task 1.2: one entry per campaign-linked contribution THIS call's
  -- p_points already includes that comes from a campaign with a
  -- max_total_points and/or per_customer_limit cap - i.e. exactly the
  -- surviving entries in `AwardPlan.budgetChecks`
  -- (src/features/receipts/server/award.ts), AFTER `priceReceipt`'s own
  -- advisory drop already ran. Shape: [{"campaign_id": uuid, "points":
  -- integer}, ...]. Default null (and every existing caller passes nothing)
  -- keeps every non-campaign-capped award byte-identical to 0038.
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
  -- task 1.2 locals, scoped to the budget-check loop below
  v_budget_check       record;
  v_campaign_budget    jsonb;
  v_max_total_points   integer;
  v_per_customer_limit integer;
  v_campaign_awarded   integer;
  v_campaign_earn_count integer;
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
  -- real guard rather than an advisory one. receipt_date is selected too
  -- (task 1.1 / C1): step 4b needs this receipt's own visit day, read under
  -- the SAME lock this row is already taken under.
  select r.id, r.business_id, r.user_id, r.status, r.receipt_date, r.created_at
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
  -- which is what keeps ledger order per pair strictly serialized. It is also
  -- the lock the step 4b dedupe re-check and the step 4c budget re-check
  -- below rely on for race safety (4c's own per_customer_limit half - the
  -- max_total_points half additionally needs the campaigns row lock taken
  -- there, since it is not scoped to this pair). auth.uid() is null under
  -- service_role, so created_by/updated_by stay null, which 0012 documents as
  -- "system" (identical to expire_claims).
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

  -- Step 4b (task 1.1, C1 fix): the race-safe half of fixed_per_visit
  -- dedupe, keyed on VISIT DAY. Runs only when the caller's own precheck
  -- believed no PAID fixed_per_visit earn existed yet for this receipt's
  -- visit day (see award.ts). Unchanged from 0038.
  if p_verify_no_prior_fixed_visit_earn then
    v_visit_day := private.manila_day(coalesce(v_receipt.receipt_date, v_receipt.created_at));
    if private.fixed_per_visit_already_paid(v_receipt.business_id, v_receipt.user_id, v_visit_day) then
      raise exception using errcode = 'P0001', message = 'FIXED_PER_VISIT_RACE';
    end if;
  end if;

  -- Step 4c (task 1.2, NEW): the race-safe half of campaign budget
  -- enforcement (doc 34 section 5). Runs only when the caller sends
  -- p_campaign_budget_checks - i.e. only when priceReceipt's own advisory
  -- pass found at least one surviving contribution from a campaign-capped
  -- campaign. One entry per campaign; the campaigns row is locked before
  -- either count, mirroring 0015's claim_reward precedent exactly ("lock the
  -- campaign row before ANY campaign-wide count, and only when a cap is
  -- actually configured"). Order by campaign_id so two concurrent awards
  -- naming the SAME set of multiple campaigns cannot deadlock against each
  -- other by locking them in different orders.
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
        -- The campaign vanished (hard case, should not happen: campaigns are
        -- soft-deleted) between priceReceipt's read and this call. Nothing to
        -- enforce against a row that is not there; award.ts's own campaign
        -- load would already have dropped this contribution on any receipt
        -- priced AFTER this point.
        continue;
      end if;

      v_max_total_points   := nullif(v_campaign_budget->>'max_total_points', '')::integer;
      v_per_customer_limit := nullif(v_campaign_budget->>'per_customer_limit', '')::integer;

      -- doc 34 section 5's running-total formula, verbatim: "select
      -- coalesce(sum(points),0) from points_transactions where
      -- campaign_id=$1 and points > 0". "total + pending_award >
      -- max_total_points" skips the contribution; here that skip is this
      -- call refusing so award.ts can retry without it (see this
      -- migration's header on why a refusal, not a partial commit).
      if v_max_total_points is not null then
        select coalesce(sum(pt.points), 0)::integer
          into v_campaign_awarded
          from public.points_transactions pt
         where pt.campaign_id = v_budget_check.campaign_id
           and pt.points > 0;
        if v_campaign_awarded + v_budget_check.points > v_max_total_points then
          raise exception using errcode = 'P0001', message = 'CAMPAIGN_BUDGET_RACE';
        end if;
      end if;

      -- doc 34 section 5's award-time per_customer_limit: "counts that
      -- consumer's positive points_transactions with this campaign_id".
      -- Race-safety here actually comes from the business_customers lock
      -- already held above (this consumer's own concurrent awards are
      -- already serialized by it) - the campaigns row lock is not required
      -- for THIS half, but taking it once above for both checks keeps this
      -- loop a single lock per campaign rather than two.
      if v_per_customer_limit is not null then
        select count(*)::integer
          into v_campaign_earn_count
          from public.points_transactions pt
         where pt.campaign_id = v_budget_check.campaign_id
           and pt.consumer_id = v_receipt.user_id
           and pt.points > 0;
        if v_campaign_earn_count >= v_per_customer_limit then
          raise exception using errcode = 'P0001', message = 'CAMPAIGN_BUDGET_RACE';
        end if;
      end if;
    end loop;
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
  -- the shared helper so this path and record_receipt_visit cannot drift.
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

-- System function, service_role ONLY, mirroring 0016/0018/0023/0037/0038.
-- Signature grew by one parameter (task 1.2); grants restated for it.
revoke execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)
  to service_role;
