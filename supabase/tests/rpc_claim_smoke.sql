-- ============================================================================
-- rpc_claim_smoke.sql (pgTAP)
-- Smoke tests for the 0013 reward RPCs: public.claim_reward and
-- public.validate_redemption, plus the ledger insert fence and the
-- business_customers balance-cache column fence. Runs entirely inside one
-- transaction and rolls back. Execute as a privileged role (postgres) against
-- a database with migrations 0001-0013 applied. pgTAP lives in the extensions
-- schema.
--
-- Fixture strategy: mirror rls_campaigns_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- create two tenants via register_business under set-local-role authenticated,
-- add marketing/staff members to tenant 1 for the role matrix, then seed the
-- reward catalog and the consumer's starting balance as the privileged role
-- (stands in for the service-role points pipeline: one earn ledger row + the
-- matching business_customers balance).
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(35);

-- ---------------------------------------------------------------- fixtures
-- Six fixed test users: two business owners, one consumer with a balance,
-- one blacklisted consumer, one marketing member and one staff member of
-- tenant 1 (permission matrix: staff may validate redemptions, marketing may
-- not).
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('a1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-claims-owner1@example.com', '{"full_name": "Claims Owner One"}'::jsonb),
  ('a2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-claims-owner2@example.com', '{"full_name": "Claims Owner Two"}'::jsonb),
  ('a3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-claims-consumer@example.com', '{"full_name": "Claims Consumer"}'::jsonb),
  ('a4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-claims-blacklisted@example.com', '{"full_name": "Blocked Consumer"}'::jsonb),
  ('a5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-claims-marketing@example.com', '{"full_name": "Marketing Member"}'::jsonb),
  ('a6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-claims-staff@example.com', '{"full_name": "Counter Staff"}'::jsonb);

-- owner1 registers tenant 1; the returned business id is captured directly
-- from the RPC call (register_business returns the new business uuid per
-- 0003_auth_plumbing.sql), so tenant 1 never has to be looked up by name
select set_config('request.jwt.claims',
  '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz1',
  (select public.register_business('Claim Cafe', 'cafe', 'cebu', '1 Redemption Road')::text),
  true);
reset role;

-- owner2 registers tenant 2 (owner2 is the non-staff probe for tenant 1); its
-- business id is never referenced again so nothing needs to be captured
select set_config('request.jwt.claims',
  '{"sub": "a2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select public.register_business('Claim Rival', 'restaurant', 'manila', '2 Other Ave');
reset role;

-- role-matrix members of tenant 1 (privileged fixture: staff writes are
-- service-role only until the staff module ships)
insert into public.business_staff (business_id, user_id, role, status)
values
  (current_setting('test.biz1')::uuid,
   'a5555555-5555-4555-8555-555555555555', 'marketing', 'active'),
  (current_setting('test.biz1')::uuid,
   'a6666666-6666-4666-8666-666666666666', 'staff', 'active');

-- reward campaign + catalog, seeded as the privileged role. Each campaign id
-- is captured off its own "returning id" CTE rather than re-selected by name
-- against the whole campaigns table, so a live campaign that happens to
-- share the name can never be picked up instead of the fixture's own row.
with ins as (
  insert into public.campaigns (business_id, type, status, name)
  values (current_setting('test.biz1')::uuid, 'reward', 'active', 'Reward Season')
  returning id
)
select set_config('test.camp1', (select id::text from ins), true);

-- second campaign whose budget caps per-customer claims across ALL its rewards
with ins as (
  insert into public.campaigns (business_id, type, status, name, budget)
  values (current_setting('test.biz1')::uuid, 'reward', 'active', 'Budget Capped',
          '{"per_customer_limit": 1}'::jsonb)
  returning id
)
select set_config('test.camp2', (select id::text from ins), true);

-- third campaign whose budget allows exactly one redemption campaign-wide
with ins as (
  insert into public.campaigns (business_id, type, status, name, budget)
  values (current_setting('test.biz1')::uuid, 'reward', 'active', 'Budget Spent',
          '{"max_redemptions": 1}'::jsonb)
  returning id
)
select set_config('test.camp3', (select id::text from ins), true);

-- campaign-liveness probes: a paused campaign and one whose window has ended
with ins as (
  insert into public.campaigns (business_id, type, status, name)
  values (current_setting('test.biz1')::uuid, 'reward', 'paused', 'Paused Promo')
  returning id
)
select set_config('test.camp4', (select id::text from ins), true);

with ins as (
  insert into public.campaigns (business_id, type, status, name, starts_at, ends_at)
  values (current_setting('test.biz1')::uuid, 'reward', 'active', 'Ended Promo',
          now() - interval '2 days', now() - interval '1 day')
  returning id
)
select set_config('test.camp5', (select id::text from ins), true);

-- reward catalog: one insert, one returning-scoped CTE. Every set_config
-- below matches by name against "ins" only, i.e. against the handful of rows
-- this very statement just inserted, so a live reward that happens to share
-- a name (e.g. a real "Free Milk Tea") can never collide with the fixture.
with ins as (
  insert into public.rewards
    (business_id, campaign_id, name, points_cost, total_inventory, remaining,
     per_customer_limit, claim_expiry_days)
  values
    -- doc 35 s6 worked example: cost 500, remaining 50 -> 49, expiry 30 days
    (current_setting('test.biz1')::uuid, current_setting('test.camp1')::uuid,
     'Free Milk Tea', 500, 50, 50, 1, 30),
    -- unaffordable at balance 470 after the first claim; finite stock so the
    -- rollback-on-failure assertion has a number to check
    (current_setting('test.biz1')::uuid, current_setting('test.camp1')::uuid,
     'Golden Feast', 5000, 10, 10, 5, 30),
    -- sold out
    (current_setting('test.biz1')::uuid, current_setting('test.camp1')::uuid,
     'Sold Out Sticker', 100, 5, 0, 1, 30),
    -- free claim, unlimited inventory (remaining null)
    (current_setting('test.biz1')::uuid, current_setting('test.camp1')::uuid,
     'Free Sticker', 0, null, null, 2, 30),
    -- camp2 pair: generous per-reward limits, but the campaign budget caps the
    -- consumer at ONE claim across BOTH rewards
    (current_setting('test.biz1')::uuid, current_setting('test.camp2')::uuid,
     'Capped Cookie', 0, null, null, 3, 30),
    (current_setting('test.biz1')::uuid, current_setting('test.camp2')::uuid,
     'Capped Brownie', 0, null, null, 3, 30),
    -- camp3: per-reward limit is loose; budget.max_redemptions = 1 is the cap
    (current_setting('test.biz1')::uuid, current_setting('test.camp3')::uuid,
     'Scarce Prize', 0, null, null, 5, 30),
    -- liveness probes
    (current_setting('test.biz1')::uuid, current_setting('test.camp4')::uuid,
     'Paused Perk', 0, null, null, 1, 30),
    (current_setting('test.biz1')::uuid, current_setting('test.camp5')::uuid,
     'Late Latte', 0, null, null, 1, 30)
  returning id, name
)
select
  set_config('test.r_main', (select id::text from ins where name = 'Free Milk Tea'), true),
  set_config('test.r_pricey', (select id::text from ins where name = 'Golden Feast'), true),
  set_config('test.r_oos', (select id::text from ins where name = 'Sold Out Sticker'), true),
  set_config('test.r_free', (select id::text from ins where name = 'Free Sticker'), true),
  set_config('test.r_capped_a', (select id::text from ins where name = 'Capped Cookie'), true),
  set_config('test.r_capped_b', (select id::text from ins where name = 'Capped Brownie'), true),
  set_config('test.r_budget', (select id::text from ins where name = 'Scarce Prize'), true),
  set_config('test.r_paused', (select id::text from ins where name = 'Paused Perk'), true),
  set_config('test.r_ended', (select id::text from ins where name = 'Late Latte'), true);

-- consumer starting balance 970 (privileged fixture: earn row + balance cache)
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values (current_setting('test.biz1')::uuid,
        'a3333333-3333-4333-8333-333333333333', 'earn', 970, 970);
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz1')::uuid,
        'a3333333-3333-4333-8333-333333333333', 970);

-- blacklisted consumer with plenty of points
insert into public.business_customers (business_id, consumer_id, segment, points_balance)
values (current_setting('test.biz1')::uuid,
        'a4444444-4444-4444-8444-444444444444', 'blacklisted', 1000);

-- already-expired claim (privileged fixture) for the CLAIM_EXPIRED guard; id
-- captured straight off its own returning CTE
with ins as (
  insert into public.reward_claims
    (business_id, reward_id, consumer_id, status, points_spent, expires_at)
  values
    (current_setting('test.biz1')::uuid, current_setting('test.r_pricey')::uuid,
     'a3333333-3333-4333-8333-333333333333', 'claimed', 0, now() - interval '1 day')
  returning id
)
select set_config('test.claim_exp', (select id::text from ins), true);

-- ---------------------------------------------------------------- happy path claim
select set_config('request.jwt.claims',
  '{"sub": "a3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

-- 1. consumer claims the 500-point reward (doc 35 s6 worked example)
select lives_ok(
  $$select public.claim_reward(current_setting('test.r_main')::uuid)$$,
  'consumer claims a 500-point reward with balance 970 (s6 steps 1-6)');

reset role;

select set_config('test.claim1',
  (select id::text from public.reward_claims
    where reward_id = current_setting('test.r_main')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333'), true);

-- 2. exactly ONE redeem ledger row exists for the pair
select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz1')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333'
      and type = 'redeem'),
  1,
  'claim wrote exactly one redeem ledger row');

-- 3. the redeem row carries points -500 and balance_after 470
select is(
  (select points::text || '/' || balance_after::text from public.points_transactions
    where claim_id = current_setting('test.claim1')::uuid),
  '-500/470',
  'redeem ledger row has points -500 and balance_after 470 (worked example)');

-- 4. inventory decremented 50 -> 49
select is(
  (select remaining from public.rewards where id = current_setting('test.r_main')::uuid),
  49,
  'claim decremented rewards.remaining 50 -> 49');

-- 5. claim row: status claimed, points_spent 500, points_txn_id set
select is(
  (select status || '/' || points_spent::text || '/' || (points_txn_id is not null)::text
     from public.reward_claims where id = current_setting('test.claim1')::uuid),
  'claimed/500/true',
  'claim row is claimed, points_spent 500, points_txn_id linked to the redeem row');

-- 6. balance cache updated 970 -> 470 in the same transaction
select is(
  (select points_balance from public.business_customers
    where business_id = current_setting('test.biz1')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333'),
  470,
  'business_customers.points_balance updated to 470');

-- 7. core invariant: the ledger sum IS the cached balance for the pair
select is(
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where business_id = current_setting('test.biz1')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333'),
  (select points_balance from public.business_customers
    where business_id = current_setting('test.biz1')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333'),
  'sum(points_transactions.points) equals business_customers.points_balance for the pair');

-- ---------------------------------------------------------------- claim guards
select set_config('request.jwt.claims',
  '{"sub": "a3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

-- 8. second claim of the same reward exceeds per_customer_limit = 1
select throws_ok(
  $$select public.claim_reward(current_setting('test.r_main')::uuid)$$,
  'P0001', 'REWARD_LIMIT_REACHED',
  'second claim beyond rewards.per_customer_limit raises REWARD_LIMIT_REACHED');

-- 9. 5000-point reward with balance 470 is unaffordable
select throws_ok(
  $$select public.claim_reward(current_setting('test.r_pricey')::uuid)$$,
  'P0001', 'POINTS_INSUFFICIENT',
  'claim with insufficient balance raises POINTS_INSUFFICIENT');

-- 10. unknown reward id
select throws_ok(
  $$select public.claim_reward('00000000-0000-4000-8000-000000000000'::uuid)$$,
  'P0001', 'REWARD_UNAVAILABLE',
  'nonexistent reward raises REWARD_UNAVAILABLE');

reset role;

-- 11. the failed claim left the balance untouched
select is(
  (select points_balance from public.business_customers
    where business_id = current_setting('test.biz1')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333'),
  470,
  'failed POINTS_INSUFFICIENT claim left the balance unchanged');

-- 12. and its inventory decrement rolled back with the raise
select is(
  (select remaining from public.rewards where id = current_setting('test.r_pricey')::uuid),
  10,
  'failed POINTS_INSUFFICIENT claim left rewards.remaining unchanged');

-- 13. remaining = 0 blocks the claim
select set_config('request.jwt.claims',
  '{"sub": "a3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.claim_reward(current_setting('test.r_oos')::uuid)$$,
  'P0001', 'REWARD_OUT_OF_STOCK',
  'claim of a remaining = 0 reward raises REWARD_OUT_OF_STOCK');

-- 14. paused campaign: reward is not claimable while the campaign is paused
select throws_ok(
  $$select public.claim_reward(current_setting('test.r_paused')::uuid)$$,
  'P0001', 'REWARD_UNAVAILABLE',
  'reward of a paused campaign raises REWARD_UNAVAILABLE');

-- 15. ended window: campaign.ends_at in the past blocks new claims
select throws_ok(
  $$select public.claim_reward(current_setting('test.r_ended')::uuid)$$,
  'P0001', 'REWARD_UNAVAILABLE',
  'reward of a campaign whose window has ended raises REWARD_UNAVAILABLE');
reset role;

-- 16. blacklisted consumer is refused before limits/inventory/balance
select set_config('request.jwt.claims',
  '{"sub": "a4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.claim_reward(current_setting('test.r_main')::uuid)$$,
  'P0001', 'CUSTOMER_BLACKLISTED',
  'blacklisted consumer claim raises CUSTOMER_BLACKLISTED');
reset role;

-- ---------------------------------------------------------------- points_cost = 0
select set_config('request.jwt.claims',
  '{"sub": "a3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

-- 17. free reward claim succeeds
select lives_ok(
  $$select public.claim_reward(current_setting('test.r_free')::uuid)$$,
  'points_cost = 0 reward claim succeeds');

reset role;

select set_config('test.claim_free',
  (select id::text from public.reward_claims
    where reward_id = current_setting('test.r_free')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333'), true);

-- 18. NO new ledger row of ANY type: the pair still has exactly the fixture
--     earn row plus the one redeem row from the paid claim
select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz1')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333'),
  2,
  'points_cost = 0 claim wrote NO ledger row (pair still has exactly earn + redeem)');

-- 19. the free claim exists with points_txn_id null and points_spent 0
select is(
  (select (points_txn_id is null)::text || '/' || points_spent::text
     from public.reward_claims where id = current_setting('test.claim_free')::uuid),
  'true/0',
  'free claim created with points_txn_id null and points_spent 0');

-- 20. unlimited inventory stays null (never starts counting down)
select is(
  (select remaining is null from public.rewards
    where id = current_setting('test.r_free')::uuid),
  true,
  'unlimited reward (remaining null) stays null after a claim');

-- ---------------------------------------------------------------- campaign-scoped limits
select set_config('request.jwt.claims',
  '{"sub": "a3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

-- 21. first claim under the budget-capped campaign succeeds (reward A)
select lives_ok(
  $$select public.claim_reward(current_setting('test.r_capped_a')::uuid)$$,
  'first claim under campaign budget.per_customer_limit = 1 succeeds');

-- 22. a DIFFERENT reward of the same campaign: per-reward counts are 1 and 0,
--     both under their limit of 3, but the campaign-wide count hits the
--     budget cap of 1 (doc 34 s5: the cap spans all the campaign's rewards)
select throws_ok(
  $$select public.claim_reward(current_setting('test.r_capped_b')::uuid)$$,
  'P0001', 'CAMPAIGN_LIMIT_REACHED',
  'campaign budget.per_customer_limit counts claims across ALL campaign rewards (CAMPAIGN_LIMIT_REACHED)');

-- 23. first claim under budget.max_redemptions = 1 succeeds
select lives_ok(
  $$select public.claim_reward(current_setting('test.r_budget')::uuid)$$,
  'first claim under campaign budget.max_redemptions = 1 succeeds');

-- 24. the campaign-wide redemption budget is now spent (per-reward limit 5
--     would still allow this consumer more claims)
select throws_ok(
  $$select public.claim_reward(current_setting('test.r_budget')::uuid)$$,
  'P0001', 'CAMPAIGN_BUDGET_EXHAUSTED',
  'claim beyond campaign budget.max_redemptions raises CAMPAIGN_BUDGET_EXHAUSTED');

reset role;

-- ---------------------------------------------------------------- validate_redemption
-- 25. owner2 is not staff of tenant 1: FORBIDDEN
select set_config('request.jwt.claims',
  '{"sub": "a2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.validate_redemption(current_setting('test.claim1')::uuid, 'jti-intruder')$$,
  'P0001', 'FORBIDDEN',
  'validate_redemption by non-staff of the tenant raises FORBIDDEN');
reset role;

-- 26. marketing of the SAME tenant may not validate (permission matrix:
--     owner, manager, staff only)
select set_config('request.jwt.claims',
  '{"sub": "a5555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$select public.validate_redemption(current_setting('test.claim1')::uuid, 'jti-marketing')$$,
  'P0001', 'FORBIDDEN',
  'validate_redemption by a marketing member of the same tenant raises FORBIDDEN');
reset role;

select set_config('request.jwt.claims',
  '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 27. owner validates the claim (lives_ok so a raise fails cleanly instead of
--     aborting the script; the jsonb payload is captured for the next check)
select lives_ok(
  $$select set_config('test.val1',
      public.validate_redemption(current_setting('test.claim1')::uuid, 'jti-test-1')::text,
      true)$$,
  'validate_redemption by owner succeeds');

-- 28. the captured payload carries the reward name
select is(
  (current_setting('test.val1', true))::jsonb->>'reward_name',
  'Free Milk Tea',
  'validate_redemption payload returns reward_name');

-- 29. a second scan of the same claim is refused
select throws_ok(
  $$select public.validate_redemption(current_setting('test.claim1')::uuid, 'jti-test-2')$$,
  'P0001', 'CLAIM_ALREADY_REDEEMED',
  'second validate_redemption of the same claim raises CLAIM_ALREADY_REDEEMED');

-- 30. expired claim cannot be validated
select throws_ok(
  $$select public.validate_redemption(current_setting('test.claim_exp')::uuid, 'jti-test-3')$$,
  'P0001', 'CLAIM_EXPIRED',
  'validate_redemption of an expired claim raises CLAIM_EXPIRED');

reset role;

-- 31. the claim flipped to redeemed with redeemed_at set
select is(
  (select status || '/' || (redeemed_at is not null)::text
     from public.reward_claims where id = current_setting('test.claim1')::uuid),
  'redeemed/true',
  'validated claim is status redeemed with redeemed_at set');

-- 32. exactly one redemptions row exists for the claim (claim_id unique)
select is(
  (select count(*)::int from public.redemptions
    where claim_id = current_setting('test.claim1')::uuid),
  1,
  'exactly one redemptions row exists for the validated claim');

-- 33. a staff-role member of the tenant CAN validate (permission matrix)
select set_config('request.jwt.claims',
  '{"sub": "a6666666-6666-4666-8666-666666666666", "role": "authenticated"}', true);
set local role authenticated;
select lives_ok(
  $$select public.validate_redemption(current_setting('test.claim_free')::uuid, 'jti-staff-1')$$,
  'validate_redemption by a staff member of the tenant succeeds');
reset role;

-- ---------------------------------------------------------------- privilege fences
-- 34. the 0013 ledger fence at the privilege layer: authenticated holds NO
--     table-level INSERT on points_transactions (the definer RPCs are the
--     only client write path)
select ok(
  not has_table_privilege('authenticated', 'public.points_transactions', 'INSERT'),
  'authenticated has no INSERT privilege on the ledger');

-- 35. the 0013 balance-cache fence: authenticated cannot UPDATE the
--     ledger-derived points_balance column directly (segment/notes remain
--     writable per the permission matrix)
select ok(
  not has_column_privilege('authenticated', 'public.business_customers',
                           'points_balance', 'UPDATE'),
  'authenticated has no UPDATE privilege on business_customers.points_balance');

select * from finish();

rollback;
