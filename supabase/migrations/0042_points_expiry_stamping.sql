-- ============================================================================
-- 0042_points_expiry_stamping.sql
-- Task 1.3, step 1: the 12-month rolling points expiry is already PUBLISHED
-- ("When points expire", src/app/(marketing)/terms/page.tsx; the wallet's own
-- expiry copy, src/app/(consumer)/wallet/page.tsx) but nothing stamps it.
--
-- LIVE-VERIFIED STARTING FACTS (per the task brief, re-checked here):
--   * points_transactions.expires_at already exists (0012).
--   * award_receipt_points already takes p_expires_at (0018, carried through
--     0037-0041 unchanged) and writes whatever it is given verbatim.
--   * award.ts's priceReceipt always returns expiresAt: null today, with a
--     comment that there is no per-rule expiry policy column to read (doc 35
--     section 3's "Schema deltas proposed" #1, points_rules.expires_after_days,
--     was ACCEPTED in the doc amendment log but never actually migrated - see
--     0012, which has no such column). So the plumbing is wired end to end and
--     the VALUE flowing through it has always been null.
--   * Only ONE code path ever inserts a positive points_transactions row: this
--     RPC. (grep across supabase/migrations for `'earn'` confirms it - 0031's
--     clawback RPC inserts type='clawback', never 'earn'; referral_bonus is
--     [V1] and unwritten anywhere yet.)
--
-- DECISION: THE STAMP IS AUTHORITATIVE IN THE RPC, NOT THE CALLER.
--
-- The task brief asks this to be decided deliberately. Two options existed:
--   (a) award.ts computes `receipt.createdAt + 12 months` (or now() + 12
--       months) and sends it as p_expires_at, the RPC keeps trusting the
--       caller verbatim (0018's original contract);
--   (b) the RPC computes the platform's flat expiry policy itself and treats
--       p_expires_at as an override rather than the source of truth.
-- (b) is what this migration does, for the reason the brief itself names as
-- "safer": every earn writer gets it automatically, with no chance of a
-- second earn-writing caller (there is exactly one today, but doc 35 section 8
-- adds adjust and section 10 adds referral_bonus as future [V1] earn-adjacent
-- writers) forgetting to compute the stamp, or computing it from the wrong
-- clock. This mirrors the repo's existing posture on every OTHER ledger
-- invariant that matters (one earn per receipt, the balance floor, the
-- fixed_per_visit dedupe's RPC-side backstop): the database is where an
-- invariant that must ALWAYS hold is enforced, and TypeScript is where a
-- POLICY DECISION (which rule wins, how much to award) is made. Which lots
-- expire is arithmetic, not policy - doc 35 section 7 states the flat 12-month
-- rule with no per-business or per-rule variation today - so it belongs here.
--
-- p_expires_at is NOT removed from the signature: `coalesce(p_expires_at, now()
-- + interval '12 months')` keeps it as a caller-supplied OVERRIDE (useful the
-- day a per-rule expiry policy is ratified into points_rules for real, per doc
-- 35's still-open "Schema deltas proposed" item) while making the platform
-- default authoritative for every caller that does not name one - which today
-- is award.ts, which now sends null deliberately (see its own updated comment)
-- rather than compute a duplicate of this arithmetic in TypeScript.
--
-- `now() + interval '12 months'` equals `created_at + interval '12 months'`
-- for THIS row, because points_transactions.created_at (0012) defaults to
-- now() and both defaults evaluate against the same transaction snapshot -
-- the brief's phrasing ("created_at + interval '12 months'") and this
-- migration's implementation are the same value.
--
-- BACKFILL. The live database carries earn rows written before this
-- migration, all with expires_at still null (task brief: "1 earn row, 0 with
-- expiry" at the time of writing). The policy has been PUBLIC since those
-- points were earned (the terms page and wallet copy both predate this
-- migration per the brief's own framing), so leaving them at "never expires"
-- would be silently more generous than the rule ever claimed to be, not more
-- conservative - the backfill closes that gap using the row's own created_at,
-- identically to what would have been stamped had this migration shipped
-- first.
--
-- Source docs: docs/30-modules/35-points-engine.md section 7 ("Points expiry"
-- - the flat 12-month rolling rule, FIFO consumption formula, no per-rule
-- policy), section 3 ("expires_at on the earn row"); src/app/(marketing)/
-- terms/page.tsx ("When points expire"); supabase/migrations/0012_campaigns.sql
-- (expires_at column, pt_expiry_idx); 0018/0037/0038/0040/0041 (the RPC this
-- re-creates, signature carried forward unchanged).
-- ============================================================================

-- ---------------------------------------------------------------- award_receipt_points
-- Signature UNCHANGED from 0041 (still the 7-arg form): this is a plain
-- `create or replace`. The ONLY behavioural change is v_expires_at's source -
-- every guard, lock order, and message stays byte-identical to 0041.
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

  update public.receipts
     set processed_at = now()
   where id = p_receipt_id;

  return v_txn_id;
end
$$;

-- System function, service_role ONLY. Signature unchanged from 0041, so this
-- restates the existing grant pair rather than widening or narrowing it.
revoke execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)
  to service_role;

-- ---------------------------------------------------------------- backfill
-- The live earn row(s) predating this migration: expires_at is null today
-- because nothing ever stamped it (task brief, live-verified). The 12-month
-- policy has been public since these points were earned, so they are stamped
-- exactly as they would have been had this migration shipped first - the
-- row's OWN created_at, never this migration's clock, so a row earned months
-- ago does not get a future-shifted expiry it never had.
--
-- Scoped to type='earn' and points > 0: doc 35 section 7's X(t) definition
-- (the set of rows a lot's expiry stamp ever applies to) is positive earn
-- rows, and 0012's check (points <> 0) means every earn row is already
-- positive by construction - the points > 0 predicate is stated anyway so a
-- reader does not have to trust that invariant to see why this WHERE clause
-- is right. `and expires_at is null` makes this idempotent: replaying this
-- migration (or a future migration touching the same rows) never re-stamps a
-- row this statement already fixed.
--
-- THE TRIGGER MUST BE DISABLED FOR THIS ONE STATEMENT. 0012's
-- `points_transactions_append_only` trigger raises unconditionally on ANY
-- update, by ANY role, including the table owner running this migration -
-- that is the whole point of the trigger (fence 2 of the three the table
-- carries, belt-and-suspenders alongside the privilege revoke). A backfill
-- migration is exactly the narrow, reviewed, one-time exception that
-- justifies disabling it for the single statement below and re-enabling it
-- immediately after, in the SAME migration transaction - nothing else in this
-- file or any future one gets a window where the guard is down, and the
-- guard is back on before this transaction commits. This is not a
-- reusable escape hatch; it is what "corrections are compensating entries,
-- never edits" (0012) still requires be true of every OTHER write to this
-- table forever - THIS row is stamping in a fact (the policy's effective
-- date) that was always true of it and simply was not recorded yet, not
-- changing what it earned, when, or for whom.
alter table public.points_transactions disable trigger points_transactions_append_only;

update public.points_transactions
   set expires_at = created_at + interval '12 months'
 where type = 'earn'
   and points > 0
   and expires_at is null;

alter table public.points_transactions enable trigger points_transactions_append_only;
