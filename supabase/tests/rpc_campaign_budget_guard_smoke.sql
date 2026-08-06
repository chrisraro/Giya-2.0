-- ============================================================================
-- rpc_campaign_budget_guard_smoke.sql (pgTAP)
-- Smoke tests for 0040/0041: the campaign budget race guard added to
-- public.award_receipt_points (task 1.2, doc 34 section 5), and its review
-- fix (C1): CORRECT PER-CAMPAIGN ATTRIBUTION from `rule_snapshot`, never a
-- naive `sum(points) where campaign_id = X`. Covers:
--   * ATTRIBUTION (review C1): a campaign's running total counts only what
--     ITS OWN rule_snapshot entries attribute to it - not the whole-receipt
--     `points` column when it happens to be the PRIMARY `campaign_id`, and
--     YES when it is a stacked, non-primary contributor.
--   * max_total_points: a running cap shared across every consumer, closed
--     race-safely by locking the campaigns row before re-checking the total
--     (the cross-consumer race 0015 already hardened for claim_reward).
--   * per_customer_limit at award time (review I1: armed for this cap alone
--     too, not only when max_total_points is also set).
--   * "budget with room for exactly one contribution, two sequential
--     awards": the second raises CAMPAIGN_BUDGET_RACE, and a corrected
--     retry (the value award.ts's own recovery would send) succeeds.
--   * a clawed-back contribution stops counting against the budget (mirrors
--     0039's fixed_per_visit clawback exclusion).
--   * a vanished/unknown campaign id in the array is skipped, not fatal.
--   * omitting p_campaign_budget_checks entirely (every caller before task
--     1.2) enforces nothing, byte-identical to 0038's own behaviour.
--
-- Fixture/harness conventions mirror rpc_award_smoke.sql exactly (same fixed
-- test-user ids family, same set_config capture pattern, same single
-- transaction that rolls back). Execute as a privileged role (postgres)
-- against a database with migrations 0001-0041 applied.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(27);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('d1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-budget-owner@example.com', '{"full_name": "Budget Owner"}'::jsonb),
  ('d2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-budget-consumer-a@example.com', '{"full_name": "Budget Consumer A"}'::jsonb),
  ('d3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-budget-consumer-b@example.com', '{"full_name": "Budget Consumer B"}'::jsonb),
  ('d4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-budget-consumer-c@example.com', '{"full_name": "Budget Consumer C"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "d1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Budget Cafe', 'cafe', 'cebu', '9 Guardrail Ave')::text),
  true);
reset role;

-- Campaign M: max_total_points = 100, shared across consumers A and B.
with ins as (
  insert into public.campaigns (business_id, type, status, name, budget)
  values (current_setting('test.biz')::uuid, 'promotion', 'active', 'Capped Promo',
          '{"max_total_points": 100}'::jsonb)
  returning id
)
select set_config('test.camp_mtp', (select id::text from ins), true);

-- Campaign L: per_customer_limit = 1, tested against consumer C alone.
with ins as (
  insert into public.campaigns (business_id, type, status, name, budget)
  values (current_setting('test.biz')::uuid, 'promotion', 'active', 'One Per Customer',
          '{"per_customer_limit": 1}'::jsonb)
  returning id
)
select set_config('test.camp_pcl', (select id::text from ins), true);

-- Campaign S: max_total_points = 100, used ONLY for the attribution-
-- correctness section (review C1) - a campaign that is sometimes the
-- receipt's PRIMARY campaign_id and sometimes a stacked, non-primary one.
with ins as (
  insert into public.campaigns (business_id, type, status, name, budget)
  values (current_setting('test.biz')::uuid, 'promotion', 'active', 'Attribution Campaign',
          '{"max_total_points": 100}'::jsonb)
  returning id
)
select set_config('test.camp_attr', (select id::text from ins), true);

-- One receipt per award call in this suite; sha256 is globally unique.
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd2222222-2222-4222-8222-222222222222', 'approved',
          'd2222222-2222-4222-8222-222222222222/budget-a1.jpg', 'b0c1d2e3f4a50201',
          'giya-budget-smoke-sha-0000000000000000000000000000000000000001',
          '2026-08-01T10:00:00Z'::timestamptz, 10000)
  returning id
)
select set_config('test.rc_mtp_a1', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'approved',
          'd3333333-3333-4333-8333-333333333333/budget-b1.jpg', 'b0c1d2e3f4a50202',
          'giya-budget-smoke-sha-0000000000000000000000000000000000000002',
          '2026-08-01T11:00:00Z'::timestamptz, 10000)
  returning id
)
select set_config('test.rc_mtp_b1', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd4444444-4444-4444-8444-444444444444', 'approved',
          'd4444444-4444-4444-8444-444444444444/budget-c1.jpg', 'b0c1d2e3f4a50203',
          'giya-budget-smoke-sha-0000000000000000000000000000000000000003',
          '2026-08-01T12:00:00Z'::timestamptz, 5000)
  returning id
)
select set_config('test.rc_pcl_c1', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd4444444-4444-4444-8444-444444444444', 'approved',
          'd4444444-4444-4444-8444-444444444444/budget-c2.jpg', 'b0c1d2e3f4a50204',
          'giya-budget-smoke-sha-0000000000000000000000000000000000000004',
          '2026-08-01T13:00:00Z'::timestamptz, 5000)
  returning id
)
select set_config('test.rc_pcl_c2', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd2222222-2222-4222-8222-222222222222', 'approved',
          'd2222222-2222-4222-8222-222222222222/budget-a2.jpg', 'b0c1d2e3f4a50205',
          'giya-budget-smoke-sha-0000000000000000000000000000000000000005',
          '2026-08-01T14:00:00Z'::timestamptz, 5000)
  returning id
)
select set_config('test.rc_missing_camp', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd2222222-2222-4222-8222-222222222222', 'approved',
          'd2222222-2222-4222-8222-222222222222/budget-attr-x.jpg', 'b0c1d2e3f4a50206',
          'giya-budget-smoke-sha-0000000000000000000000000000000000000006',
          '2026-08-01T15:00:00Z'::timestamptz, 20000)
  returning id
)
select set_config('test.rc_attr_x', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'approved',
          'd3333333-3333-4333-8333-333333333333/budget-attr-y.jpg', 'b0c1d2e3f4a50207',
          'giya-budget-smoke-sha-0000000000000000000000000000000000000007',
          '2026-08-01T16:00:00Z'::timestamptz, 6000)
  returning id
)
select set_config('test.rc_attr_y', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd4444444-4444-4444-8444-444444444444', 'approved',
          'd4444444-4444-4444-8444-444444444444/budget-attr-z.jpg', 'b0c1d2e3f4a50208',
          'giya-budget-smoke-sha-0000000000000000000000000000000000000008',
          '2026-08-01T17:00:00Z'::timestamptz, 2000)
  returning id
)
select set_config('test.rc_attr_z', (select id::text from ins), true);

-- ============================================================ max_total_points
-- Budget has room for exactly one 60-point contribution on top of nothing
-- (cap 100): the FIRST award of 60 fits (remaining 100), the race case is a
-- SECOND contribution that would push the total to 110. Every rule_snapshot
-- below carries a REAL `bonuses` entry naming the campaign, exactly the
-- shape `enrichRuleSnapshot` decorates in award.ts, so 0041's attribution
-- read has something correct to attribute.

-- 1. first award: consumer A contributes 60 points from campaign M (as its
--    entire total, for simplicity), budget check says
--    {campaign_id: camp_mtp, points: 60} - 0 + 60 <= 100, fits.
select public.award_receipt_points(
  current_setting('test.rc_mtp_a1')::uuid, 60,
  jsonb_build_object(
    'engine', 'points/v1', 'total_points', 60,
    'bonuses', jsonb_build_array(jsonb_build_object(
      'rule_id', 'r-mtp-a1', 'campaign_id', current_setting('test.camp_mtp'), 'bonus_points', 60))),
  current_setting('test.camp_mtp')::uuid,
  null,
  false,
  jsonb_build_array(jsonb_build_object(
    'campaign_id', current_setting('test.camp_mtp'),
    'points', 60)));

select is(
  (select points::text from public.points_transactions
    where receipt_id = current_setting('test.rc_mtp_a1')::uuid and type = 'earn'),
  '60',
  'first max_total_points award (60, cap 100) lands normally');

-- 2. running total after the first award, read via the CORRECTLY ATTRIBUTED
--    aggregate (0041), not a naive points/campaign_id filter.
select is(
  public.campaign_points_awarded(current_setting('test.biz')::uuid, current_setting('test.camp_mtp')::uuid),
  60,
  'campaign running total is 60 after the first award');

-- 3. THE RACE: consumer B's award believes (per its own advisory precheck)
--    the campaign still has room for a 50-point contribution - 60 + 50 = 110
--    exceeds the 100 cap, so the authoritative re-check (under the campaigns
--    row lock) must refuse rather than mint past the budget.
select throws_ok(
  $$select public.award_receipt_points(
      current_setting('test.rc_mtp_b1')::uuid, 50,
      jsonb_build_object(
        'engine', 'points/v1', 'total_points', 50,
        'bonuses', jsonb_build_array(jsonb_build_object(
          'rule_id', 'r-mtp-b1', 'campaign_id', current_setting('test.camp_mtp'), 'bonus_points', 50))),
      current_setting('test.camp_mtp')::uuid,
      null, false,
      jsonb_build_array(jsonb_build_object(
        'campaign_id', current_setting('test.camp_mtp'),
        'points', 50)))$$,
  'P0001', 'CAMPAIGN_BUDGET_RACE',
  'a contribution that would push the running total past max_total_points raises CAMPAIGN_BUDGET_RACE');

-- 4. the refused call wrote nothing at all for consumer B's receipt - honest
--    "approved, award pending" state, exactly the FIXED_PER_VISIT_RACE shape.
select is(
  (select count(*)::int from public.points_transactions
    where receipt_id = current_setting('test.rc_mtp_b1')::uuid)
  || '/' ||
  (select (processed_at is null)::text from public.receipts
    where id = current_setting('test.rc_mtp_b1')::uuid),
  '0/true',
  'the refused campaign budget race wrote no ledger row and left processed_at null');

-- 5. and the campaign running total is unaffected by the refused call
select is(
  public.campaign_points_awarded(current_setting('test.biz')::uuid, current_setting('test.camp_mtp')::uuid),
  60,
  'the running total stays 60 after the refused race attempt');

-- 6. THE RECOVERY: award.ts's own CAMPAIGN_BUDGET_RACE retry drops the
--    campaign-capped contribution ENTIRELY and re-prices with the SAME pure
--    engine - here standing in for a receipt whose fallback still has an
--    independent 40 points to award (base + something uncapped), retried
--    WITHOUT p_campaign_budget_checks and WITHOUT p_campaign_id, exactly as
--    `awardAfterCampaignBudgetRace` sends it. This is the SAME receipt id
--    `rc_mtp_b1`, since the refused call above wrote nothing and left it
--    awardable.
select public.award_receipt_points(
  current_setting('test.rc_mtp_b1')::uuid, 40,
  '{"engine":"points/v1","total_points":40}'::jsonb);

select is(
  (select points::text || '/' || (campaign_id is null)::text
     from public.points_transactions
    where receipt_id = current_setting('test.rc_mtp_b1')::uuid and type = 'earn'),
  '40/true',
  'the recovered retry awards its uncapped remainder and carries NO campaign_id (the campaign contribution was dropped, not partially awarded)');

-- 7. and campaign M's OWN running total is exactly what the surviving,
--    still-attributed award paid (60) - never inflated by the recovered
--    receipt's 40, which the race correctly decoupled from this budget, and
--    never miscounted because that recovered row carries no rule_snapshot
--    entry naming campaign M at all.
select ok(
  public.campaign_points_awarded(current_setting('test.biz')::uuid, current_setting('test.camp_mtp')::uuid) = 60,
  'campaign M''s running total stays at 60 - the cap was never exceeded and the recovered award was never mis-attributed to it');

-- ============================================================ per_customer_limit
-- 8. first award for consumer C from campaign L (per_customer_limit 1):
--    count is 0, 0 >= 1 is false, so it fits.
select public.award_receipt_points(
  current_setting('test.rc_pcl_c1')::uuid, 10,
  jsonb_build_object(
    'engine', 'points/v1', 'total_points', 10,
    'bonuses', jsonb_build_array(jsonb_build_object(
      'rule_id', 'r-pcl-c1', 'campaign_id', current_setting('test.camp_pcl'), 'bonus_points', 10))),
  current_setting('test.camp_pcl')::uuid,
  null, false,
  jsonb_build_array(jsonb_build_object(
    'campaign_id', current_setting('test.camp_pcl'),
    'points', 10)));

select is(
  (select points::text from public.points_transactions
    where receipt_id = current_setting('test.rc_pcl_c1')::uuid and type = 'earn'),
  '10',
  'first per_customer_limit award for this consumer lands normally (count 0 < limit 1)');

-- 9. THE RACE (review I1: armed because per_customer_limit alone is enough
--    to populate p_campaign_budget_checks - the SAME consumer, so this is
--    really the business_customers lock's OWN serialization made visible,
--    but the RPC-side re-check still has to be the thing that refuses):
--    a second contribution from the SAME campaign for the SAME consumer,
--    count now 1, 1 >= 1 is true.
select throws_ok(
  $$select public.award_receipt_points(
      current_setting('test.rc_pcl_c2')::uuid, 10,
      jsonb_build_object(
        'engine', 'points/v1', 'total_points', 10,
        'bonuses', jsonb_build_array(jsonb_build_object(
          'rule_id', 'r-pcl-c2', 'campaign_id', current_setting('test.camp_pcl'), 'bonus_points', 10))),
      current_setting('test.camp_pcl')::uuid,
      null, false,
      jsonb_build_array(jsonb_build_object(
        'campaign_id', current_setting('test.camp_pcl'),
        'points', 10)))$$,
  'P0001', 'CAMPAIGN_BUDGET_RACE',
  'a second contribution once this consumer is at per_customer_limit raises CAMPAIGN_BUDGET_RACE');

-- 10. and nothing was written for the refused second award
select is(
  (select count(*)::int from public.points_transactions
    where receipt_id = current_setting('test.rc_pcl_c2')::uuid),
  0,
  'the refused per_customer_limit race wrote no ledger row');

-- 11. recovered: the same receipt retried with the campaign contribution
--     dropped (no p_campaign_id, no p_campaign_budget_checks) awards its
--     uncapped remainder, mirroring the max_total_points recovery above.
select public.award_receipt_points(
  current_setting('test.rc_pcl_c2')::uuid, 5,
  '{"engine":"points/v1","total_points":5}'::jsonb);

select is(
  (select points::text from public.points_transactions
    where receipt_id = current_setting('test.rc_pcl_c2')::uuid and type = 'earn'),
  '5',
  'the recovered retry awards its uncapped remainder once the campaign contribution is dropped');

-- ============================================================ vanished campaign id
-- 12. an unknown campaign id in the array is skipped (not found -> continue)
--     rather than raised as an error - a receipt priced against a campaign
--     that was hard-deleted between priceReceipt's read and this call must
--     not be stranded by a guard with nothing left to enforce.
select public.award_receipt_points(
  current_setting('test.rc_missing_camp')::uuid, 15,
  '{"engine":"points/v1","total_points":15}'::jsonb,
  null, null, false,
  jsonb_build_array(jsonb_build_object(
    'campaign_id', '00000000-0000-4000-8000-000000000000',
    'points', 999999)));

select is(
  (select points::text from public.points_transactions
    where receipt_id = current_setting('test.rc_missing_camp')::uuid and type = 'earn'),
  '15',
  'a vanished/unknown campaign id in p_campaign_budget_checks is skipped, not fatal');

-- ============================================================ backward compatibility
-- 13. omitting p_campaign_budget_checks entirely (every caller before task
--     1.2, and any award.ts call whose surviving candidates have no cap)
--     enforces nothing - byte-identical to 0038/0039's own signature. Proven
--     by re-querying campaign M's running total: still exactly 60 (test 7's
--     value) - the vanished-campaign-id award and the two per_customer_limit
--     awards above, all of which omitted or named a DIFFERENT campaign,
--     never touched campaign M's own total.
select is(
  public.campaign_points_awarded(current_setting('test.biz')::uuid, current_setting('test.camp_mtp')::uuid),
  60,
  'campaign M running total is unaffected by every later call that named no p_campaign_budget_checks against it');

-- ============================================================ attribution correctness (review C1)
-- Campaign S (camp_attr, cap 100) is deliberately exercised BOTH as the
-- receipt's PRIMARY campaign_id (receipt X: 200-point receipt, campaign S
-- itself only contributed 30) and as a stacked, NON-primary contributor
-- (receipt Y: campaign_id is null, campaign S still contributed 60 via a
-- bonus). 0040's naive `sum(points) where campaign_id = X` would have read
-- 200 after X alone (massively over-counting a campaign that only gave away
-- 30) and would NEVER have counted Y's 60 at all (the over-grant defect this
-- whole task exists to close). 0041 must read exactly 30, then 90.

-- 14. receipt X: campaign S IS the primary campaign_id, but its OWN
--     contribution (a stacked bonus, per rule_snapshot) is only 30 of the
--     200-point receipt total.
select public.award_receipt_points(
  current_setting('test.rc_attr_x')::uuid, 200,
  jsonb_build_object(
    'engine', 'points/v1', 'total_points', 200,
    'bonuses', jsonb_build_array(jsonb_build_object(
      'rule_id', 'r-attr-x', 'campaign_id', current_setting('test.camp_attr'), 'bonus_points', 30))),
  current_setting('test.camp_attr')::uuid,
  null, false,
  jsonb_build_array(jsonb_build_object(
    'campaign_id', current_setting('test.camp_attr'),
    'points', 30)));

select is(
  (select points::text from public.points_transactions
    where receipt_id = current_setting('test.rc_attr_x')::uuid and type = 'earn'),
  '200',
  'the ledger row still records the FULL 200-point receipt total, verbatim');

-- 15. THE C1 ASSERTION: campaign S's running total is 30, not 200 - the
--     naive formula would have read the whole receipt against it because it
--     happened to be the primary campaign_id.
select is(
  public.campaign_points_awarded(current_setting('test.biz')::uuid, current_setting('test.camp_attr')::uuid),
  30,
  'C1: campaign S''s running total counts only its OWN 30-point contribution, never the whole 200-point receipt');

-- 16. receipt Y: campaign S is NOT the primary campaign_id (null here - a
--     business-default base with no primary campaign at all), but it still
--     contributed a 60-point stacked bonus. 30 + 60 = 90 <= 100, fits.
select public.award_receipt_points(
  current_setting('test.rc_attr_y')::uuid, 60,
  jsonb_build_object(
    'engine', 'points/v1', 'total_points', 60,
    'bonuses', jsonb_build_array(jsonb_build_object(
      'rule_id', 'r-attr-y', 'campaign_id', current_setting('test.camp_attr'), 'bonus_points', 60))),
  null, null, false,
  jsonb_build_array(jsonb_build_object(
    'campaign_id', current_setting('test.camp_attr'),
    'points', 60)));

select is(
  (select campaign_id is null from public.points_transactions
    where receipt_id = current_setting('test.rc_attr_y')::uuid and type = 'earn'),
  true,
  'receipt Y carries no primary campaign_id at all');

-- 17. THE OTHER C1 ASSERTION: campaign S's running total picked up Y's 60
--     points despite S never being the primary campaign_id on that receipt -
--     the naive formula would have read 0 for this contribution forever,
--     which is the original over-grant defect this task exists to close.
select is(
  public.campaign_points_awarded(current_setting('test.biz')::uuid, current_setting('test.camp_attr')::uuid),
  90,
  'C1: campaign S''s running total is 30 + 60 = 90, correctly counting a NON-primary stacked contribution');

-- 18. a further 20-point contribution to campaign S would push 90 + 20 = 110
--     past its 100 cap - proof the correctly-accumulated total still catches
--     a genuine overspend, not just that it undercounts safely.
select throws_ok(
  $$select public.award_receipt_points(
      current_setting('test.rc_attr_z')::uuid, 20,
      jsonb_build_object(
        'engine', 'points/v1', 'total_points', 20,
        'bonuses', jsonb_build_array(jsonb_build_object(
          'rule_id', 'r-attr-z', 'campaign_id', current_setting('test.camp_attr'), 'bonus_points', 20))),
      current_setting('test.camp_attr')::uuid,
      null, false,
      jsonb_build_array(jsonb_build_object(
        'campaign_id', current_setting('test.camp_attr'),
        'points', 20)))$$,
  'P0001', 'CAMPAIGN_BUDGET_RACE',
  'a correctly-attributed running total (90) still catches a contribution that would exceed the 100 cap');

-- 19-20 (mirrors 0039 M-a). A clawed-back contribution never actually
-- "awarded" its points, so it must stop counting toward the campaign's
-- running total the moment it is reversed - the compensating row
-- clawback_receipt_points itself would write (0031): a NEW row,
-- type='clawback', reverses_id = the earn's id, never a mutation of the
-- original.
select set_config('test.txn_attr_y',
  (select id::text from public.points_transactions
    where receipt_id = current_setting('test.rc_attr_y')::uuid and type = 'earn'),
  true);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, reverses_id)
select current_setting('test.biz')::uuid,
       'd3333333-3333-4333-8333-333333333333',
       'clawback', -60, bc.points_balance - 60,
       current_setting('test.txn_attr_y')::uuid
  from public.business_customers bc
 where bc.business_id = current_setting('test.biz')::uuid
   and bc.consumer_id = 'd3333333-3333-4333-8333-333333333333';

select is(
  (select count(*)::int from public.points_transactions
    where reverses_id = current_setting('test.txn_attr_y')::uuid and type = 'clawback'),
  1,
  'the clawback row against receipt Y''s earn landed');

select is(
  public.campaign_points_awarded(current_setting('test.biz')::uuid, current_setting('test.camp_attr')::uuid),
  30,
  'the clawed-back 60-point contribution stops counting: campaign S''s running total drops back to 30');

-- ============================================================ notifications.kind
-- 21. campaign_budget_exhausted is now a valid notifications.kind (task 1.2)
select lives_ok(
  $$insert into public.notifications (user_id, kind, title, body)
    values ('d1111111-1111-4111-8111-111111111111', 'campaign_budget_exhausted',
            'A campaign paused itself', 'Test Campaign reached its points budget.')$$,
  'campaign_budget_exhausted is accepted by notifications_kind_check');

-- 22. and the row is readable back with the expected kind
select is(
  (select kind from public.notifications
    where user_id = 'd1111111-1111-4111-8111-111111111111'
      and kind = 'campaign_budget_exhausted'),
  'campaign_budget_exhausted',
  'the campaign_budget_exhausted notification row was written with the right kind');

-- ---------------------------------------------------------------- grants
-- 23-25. re-confirm the 0040 signature's grant posture (belt-and-braces
-- alongside rpc_award_smoke.sql's own coverage, since this file is the one
-- that actually exercises the NEW parameter's behaviour end to end), plus
-- (review M8) that the OLD 6-arg overload is genuinely gone - a surviving
-- overload would be a second entry point with its own grants.
select ok(
  not has_function_privilege('anon',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)', 'EXECUTE'),
  'anon cannot execute award_receipt_points');

select ok(
  not has_function_privilege('authenticated',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)', 'EXECUTE'),
  'authenticated cannot execute award_receipt_points');

select ok(
  has_function_privilege('service_role',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz, boolean, jsonb)', 'EXECUTE'),
  'service_role can execute award_receipt_points');

-- 26 (review M8). The dropped 6-arg overload (0037-0040's own signature
-- before this task added p_campaign_budget_checks) must not exist as a
-- second, separately-grantable entry point.
select is(
  (select count(*)::int from pg_proc
    where proname = 'award_receipt_points'
      and pronamespace = 'public'::regnamespace),
  1,
  'exactly one award_receipt_points overload exists (the dropped 6-arg form is genuinely gone)');

-- 27. campaigns M, L and S are all untouched by this suite (auto-pause is
--     TypeScript post-commit, not this RPC).
select is(
  (select count(*)::int from public.campaigns
    where id in (current_setting('test.camp_mtp')::uuid,
                 current_setting('test.camp_pcl')::uuid,
                 current_setting('test.camp_attr')::uuid)
      and status = 'active'),
  3,
  'campaigns M, L and S are all still active (this RPC never pauses anything itself)');

select * from finish();

rollback;
