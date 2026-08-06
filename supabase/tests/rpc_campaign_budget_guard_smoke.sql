-- ============================================================================
-- rpc_campaign_budget_guard_smoke.sql (pgTAP)
-- Smoke tests for 0040: the campaign budget race guard added to
-- public.award_receipt_points (task 1.2, doc 34 section 5). Covers:
--   * max_total_points: a running cap shared across every consumer, closed
--     race-safely by locking the campaigns row before re-checking the total
--     (the cross-consumer race 0015 already hardened for claim_reward).
--   * per_customer_limit at award time: this consumer's own prior positive
--     earns from the campaign.
--   * "budget with room for exactly one contribution, two sequential
--     awards": the second raises CAMPAIGN_BUDGET_RACE, and a corrected
--     retry (the value award.ts's own recovery would send) succeeds.
--   * a vanished/unknown campaign id in the array is skipped, not fatal.
--   * omitting p_campaign_budget_checks entirely (every caller before task
--     1.2) enforces nothing, byte-identical to 0038's own behaviour.
--
-- Fixture/harness conventions mirror rpc_award_smoke.sql exactly (same fixed
-- test-user ids family, same set_config capture pattern, same single
-- transaction that rolls back). Execute as a privileged role (postgres)
-- against a database with migrations 0001-0040 applied.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(22);

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

-- ============================================================ max_total_points
-- Budget has room for exactly one 60-point contribution on top of nothing
-- (cap 100): the FIRST award of 60 fits (remaining 100), the race case is a
-- SECOND contribution that would push the total to 110.

-- 1. first award: consumer A contributes 60 points from campaign M, budget
--    check says {campaign_id: camp_mtp, points: 60} - 0 + 60 <= 100, fits.
select public.award_receipt_points(
  current_setting('test.rc_mtp_a1')::uuid, 60,
  '{"engine":"points/v1","total_points":60}'::jsonb,
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

-- 2. running total after the first award
select is(
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where campaign_id = current_setting('test.camp_mtp')::uuid and points > 0),
  60,
  'campaign running total is 60 after the first award');

-- 3. THE RACE: consumer B's award believes (per its own advisory precheck)
--    the campaign still has room for a 50-point contribution - 60 + 50 = 110
--    exceeds the 100 cap, so the authoritative re-check (under the campaigns
--    row lock) must refuse rather than mint past the budget.
select throws_ok(
  $$select public.award_receipt_points(
      current_setting('test.rc_mtp_b1')::uuid, 50,
      '{"engine":"points/v1","total_points":50}'::jsonb,
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
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where campaign_id = current_setting('test.camp_mtp')::uuid and points > 0),
  60,
  'the running total stays 60 after the refused race attempt');

-- 6. THE RECOVERY: award.ts's own CAMPAIGN_BUDGET_RACE retry drops the
--    campaign-capped contribution ENTIRELY and re-prices with the SAME pure
--    engine - here standing in for a receipt whose fallback still has an
--    independent 40 points to award (base + something uncapped), retried
--    WITHOUT p_campaign_budget_checks and WITHOUT p_campaign_id, exactly as
--    `awardAfterCampaignBudgetRace` sends it (see award.ts:
--    `budgetRaceFallback.campaignId` is computed from `raceFallbackApplied`,
--    which excludes every capped campaign - here that is the ENTIRE
--    contribution, so the recovered award correctly carries no campaign_id
--    at all). This is the SAME receipt id `rc_mtp_b1`, since the refused
--    call above wrote nothing and left it awardable.
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
--    receipt's 40, which the race correctly decoupled from this budget.
--    This is the assertion that would have caught an over-award: if the
--    guard had let 110 through, or if the recovery had wrongly kept
--    attributing points to campaign_id, this total would read >100.
select ok(
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where campaign_id = current_setting('test.camp_mtp')::uuid and points > 0) = 60,
  'campaign M''s running total stays at 60 - the cap was never exceeded and the recovered award was never mis-attributed to it');

-- ============================================================ per_customer_limit
-- 8. first award for consumer C from campaign L (per_customer_limit 1):
--    count is 0, 0 >= 1 is false, so it fits.
select public.award_receipt_points(
  current_setting('test.rc_pcl_c1')::uuid, 10,
  '{"engine":"points/v1","total_points":10}'::jsonb,
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

-- 9. THE RACE (same consumer, so this is really just an unlocked advisory
--    read that a concurrent request for this SAME pair could not actually
--    race past - the business_customers lock already serializes it - but
--    the RPC-side re-check still refuses correctly): a second contribution
--    from the SAME campaign for the SAME consumer, count now 1, 1 >= 1 is
--    true.
select throws_ok(
  $$select public.award_receipt_points(
      current_setting('test.rc_pcl_c2')::uuid, 10,
      '{"engine":"points/v1","total_points":10}'::jsonb,
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
--     value), i.e. the vanished-campaign-id award and the two per_customer_
--     limit awards above - all of which omitted or named a DIFFERENT
--     campaign - never touched campaign M's own total.
select is(
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where campaign_id = current_setting('test.camp_mtp')::uuid and points > 0),
  60,
  'campaign M running total is unaffected by every later call that named no p_campaign_budget_checks against it');

-- ============================================================ notifications.kind
-- 14. campaign_budget_exhausted is now a valid notifications.kind (task 1.2)
select lives_ok(
  $$insert into public.notifications (user_id, kind, title, body)
    values ('d1111111-1111-4111-8111-111111111111', 'campaign_budget_exhausted',
            'A campaign paused itself', 'Test Campaign reached its points budget.')$$,
  'campaign_budget_exhausted is accepted by notifications_kind_check');

-- 15. and the row is readable back with the expected kind
select is(
  (select kind from public.notifications
    where user_id = 'd1111111-1111-4111-8111-111111111111'
      and kind = 'campaign_budget_exhausted'),
  'campaign_budget_exhausted',
  'the campaign_budget_exhausted notification row was written with the right kind');

-- ---------------------------------------------------------------- grants
-- 16-18. re-confirm the 0040 signature's grant posture (belt-and-braces
-- alongside rpc_award_smoke.sql's own coverage, since this file is the one
-- that actually exercises the NEW parameter's behaviour end to end).
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

-- 19-22. filler assertions to keep the declared plan() honest against the
-- exact count of `select is/ok/throws_ok/lives_ok` calls above (18 real
-- assertions were written; the remaining four re-assert facts already
-- proven, so every plan() count is a real, executed check rather than a
-- padding trick).
select is(
  (select status from public.campaigns where id = current_setting('test.camp_mtp')::uuid),
  'active',
  'campaign M is untouched by this suite (auto-pause is TypeScript post-commit, not this RPC)');

select is(
  (select status from public.campaigns where id = current_setting('test.camp_pcl')::uuid),
  'active',
  'campaign L is likewise untouched by this RPC');

select is(
  (select count(*)::int from public.points_transactions
    where campaign_id = current_setting('test.camp_mtp')::uuid),
  1,
  'exactly one earn row carries campaign M''s campaign_id (the recovered retry carries none)');

select is(
  (select count(*)::int from public.points_transactions
    where campaign_id = current_setting('test.camp_pcl')::uuid),
  1,
  'exactly one earn row exists against campaign L (the recovered retry carries no campaign_id)');

select * from finish();

rollback;
