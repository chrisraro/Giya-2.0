-- ============================================================================
-- rpc_award_smoke.sql (pgTAP)
-- Smoke tests for 0018: public.award_receipt_points, the second and last
-- ledger write path. Covers the guard order, one-earn-per-receipt, the
-- balance_after chain, the doc 40 Asia/Manila visit rule (including the
-- UTC/Manila date-boundary case and backdated receipts), the CRM counters,
-- processed_at, and the service_role-only grant. Runs entirely inside one
-- transaction and rolls back. Execute as a privileged role (postgres) against
-- a database with migrations 0001-0018 applied. pgTAP lives in the extensions
-- schema.
--
-- Fixture strategy: mirror rpc_claim_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- create the tenant via register_business under set-local-role authenticated,
-- then seed campaigns and receipts as the privileged role (standing in for the
-- service-role receipt pipeline). Every fixture id is captured from its own
-- "returning id" CTE and never looked up by name or by a global select over
-- the table, so live E2E data can never be picked up instead of the fixture's
-- own rows.
--
-- Manila arithmetic used by the visit assertions (UTC+8, no DST):
--   rc1 2026-07-25T10:00Z -> 2026-07-25 18:00 Manila -> day 2026-07-25
--   rc2 2026-07-25T13:00Z -> 2026-07-25 21:00 Manila -> day 2026-07-25 (same)
--   rc3 2026-07-25T17:00Z -> 2026-07-26 01:00 Manila -> day 2026-07-26 (NEXT
--       Manila day, while still the same UTC date as rc1: this is the case a
--       naive UTC comparison gets wrong)
--   rc4 2026-07-24T02:00Z -> 2026-07-24 10:00 Manila -> day 2026-07-24
--       (backdated, submitted last)
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(39);

-- ---------------------------------------------------------------- fixtures
-- Four fixed test users: the tenant owner, the main consumer, a blacklisted
-- consumer, and a consumer used only for the null-receipt_date fallback.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('c1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-award-owner@example.com', '{"full_name": "Award Owner"}'::jsonb),
  ('c3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-award-consumer@example.com', '{"full_name": "Award Consumer"}'::jsonb),
  ('c4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-award-blacklisted@example.com', '{"full_name": "Blocked Scanner"}'::jsonb),
  ('c5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-award-nodate@example.com', '{"full_name": "Dateless Scanner"}'::jsonb);

-- the owner registers the tenant; the business id comes straight back from the
-- RPC (0003_auth_plumbing.sql), so the tenant is never looked up by name
select set_config('request.jwt.claims',
  '{"sub": "c1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Award Cafe', 'cafe', 'cebu', '18 Ledger Lane')::text),
  true);
reset role;

-- campaign whose id the earn rows carry as provenance
with ins as (
  insert into public.campaigns (business_id, type, status, name)
  values (current_setting('test.biz')::uuid, 'promotion', 'active', 'Friday Double')
  returning id
)
select set_config('test.camp', (select id::text from ins), true);

-- the blacklisted pair row (segment set before any award is attempted)
insert into public.business_customers (business_id, consumer_id, segment)
values (current_setting('test.biz')::uuid,
        'c4444444-4444-4444-8444-444444444444', 'blacklisted');

-- ---- receipts. sha256 is globally unique (receipts_sha_unique), so every
-- ---- fixture uses a distinctive prefix that cannot collide with live rows.
-- ---- receipt_number stays null throughout so receipts_number_unique is not
-- ---- in play here (it has its own coverage in rls_receipts_smoke.sql).
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c3333333-3333-4333-8333-333333333333', 'approved',
          'c3333333-3333-4333-8333-333333333333/award-1.jpg', 'a0b1c2d3e4f50101',
          'giya-award-smoke-sha-0000000000000000000000000000000000000001',
          '2026-07-25T10:00:00Z'::timestamptz, 48500)
  returning id
)
select set_config('test.rc1', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c3333333-3333-4333-8333-333333333333', 'approved',
          'c3333333-3333-4333-8333-333333333333/award-2.jpg', 'a0b1c2d3e4f50102',
          'giya-award-smoke-sha-0000000000000000000000000000000000000002',
          '2026-07-25T13:00:00Z'::timestamptz, 10000)
  returning id
)
select set_config('test.rc2', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c3333333-3333-4333-8333-333333333333', 'approved',
          'c3333333-3333-4333-8333-333333333333/award-3.jpg', 'a0b1c2d3e4f50103',
          'giya-award-smoke-sha-0000000000000000000000000000000000000003',
          '2026-07-25T17:00:00Z'::timestamptz, 20000)
  returning id
)
select set_config('test.rc3', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c3333333-3333-4333-8333-333333333333', 'approved',
          'c3333333-3333-4333-8333-333333333333/award-4.jpg', 'a0b1c2d3e4f50104',
          'giya-award-smoke-sha-0000000000000000000000000000000000000004',
          '2026-07-24T02:00:00Z'::timestamptz, 5000)
  returning id
)
select set_config('test.rc4', (select id::text from ins), true);

-- not-awardable statuses, one receipt each
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c3333333-3333-4333-8333-333333333333', 'queued',
          'c3333333-3333-4333-8333-333333333333/award-q.jpg', 'a0b1c2d3e4f50105',
          'giya-award-smoke-sha-0000000000000000000000000000000000000005',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rc_queued', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c3333333-3333-4333-8333-333333333333', 'review',
          'c3333333-3333-4333-8333-333333333333/award-v.jpg', 'a0b1c2d3e4f50106',
          'giya-award-smoke-sha-0000000000000000000000000000000000000006',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rc_review', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos, reject_reason)
  values (current_setting('test.biz')::uuid,
          'c3333333-3333-4333-8333-333333333333', 'rejected',
          'c3333333-3333-4333-8333-333333333333/award-x.jpg', 'a0b1c2d3e4f50107',
          'giya-award-smoke-sha-0000000000000000000000000000000000000007',
          '2026-07-25T10:00:00Z'::timestamptz, 30000, 'duplicate')
  returning id
)
select set_config('test.rc_rejected', (select id::text from ins), true);

-- approved but never matched to a business (business_id nullable until Stage 5)
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (null,
          'c3333333-3333-4333-8333-333333333333', 'approved',
          'c3333333-3333-4333-8333-333333333333/award-n.jpg', 'a0b1c2d3e4f50108',
          'giya-award-smoke-sha-0000000000000000000000000000000000000008',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rc_nobiz', (select id::text from ins), true);

-- reserved for the p_points input guards, so those refusals are proven not to
-- have written anything against a fresh, otherwise perfectly awardable receipt
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c3333333-3333-4333-8333-333333333333', 'approved',
          'c3333333-3333-4333-8333-333333333333/award-p.jpg', 'a0b1c2d3e4f50109',
          'giya-award-smoke-sha-0000000000000000000000000000000000000009',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rc_points', (select id::text from ins), true);

-- blacklisted consumer's receipt
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c4444444-4444-4444-8444-444444444444', 'approved',
          'c4444444-4444-4444-8444-444444444444/award-b.jpg', 'a0b1c2d3e4f5010a',
          'giya-award-smoke-sha-000000000000000000000000000000000000000a',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rc_black', (select id::text from ins), true);

-- doc 36 Stage 8 allows a receipt with a total and a NUMBER but no date, so
-- receipt_date is null here; doc 40 says event_ts falls back to created_at.
-- created_at is captured alongside the id so the assertion is exact rather
-- than "some recent timestamp".
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'c5555555-5555-4555-8555-555555555555', 'approved',
          'c5555555-5555-4555-8555-555555555555/award-d.jpg', 'a0b1c2d3e4f5010b',
          'giya-award-smoke-sha-000000000000000000000000000000000000000b',
          null, 12300)
  returning id, created_at
)
select set_config('test.rc_nodate', (select id::text from ins), true),
       set_config('test.rc_nodate_created',
                  (select created_at::text from ins), true);

-- ---------------------------------------------------------------- manila_day
-- 1. the helper the visit rule is built on: 17:00Z is the NEXT Manila day
select is(
  private.manila_day('2026-07-25T17:00:00Z'::timestamptz),
  '2026-07-26'::date,
  'manila_day(2026-07-25T17:00Z) is 2026-07-26 (UTC+8 crosses the date line)');

-- 2. and 10:00Z on the same UTC date is still 2026-07-25 Manila
select is(
  private.manila_day('2026-07-25T10:00:00Z'::timestamptz),
  '2026-07-25'::date,
  'manila_day(2026-07-25T10:00Z) is 2026-07-25');

-- 3. null in, null out (called on a never-visited last_visit_at)
select ok(
  private.manila_day(null::timestamptz) is null,
  'manila_day(null) is null');

-- ---------------------------------------------------------------- first award
select set_config('test.txn1',
  public.award_receipt_points(
    current_setting('test.rc1')::uuid,
    970,
    '{"engine":"points/v1","total_points":970}'::jsonb,
    current_setting('test.camp')::uuid,
    '2027-07-25T10:00:00Z'::timestamptz)::text,
  true);

-- 4. exactly one earn row for the receipt
select is(
  (select count(*)::int from public.points_transactions
    where receipt_id = current_setting('test.rc1')::uuid and type = 'earn'),
  1,
  'award wrote exactly one earn ledger row for the receipt');

-- 5. the returned id IS that row, with points and balance_after 0 + 970
select is(
  (select points::text || '/' || balance_after::text from public.points_transactions
    where id = current_setting('test.txn1')::uuid),
  '970/970',
  'returned ledger row has points 970 and balance_after 970 (prev 0 + 970)');

-- 6. provenance columns are persisted verbatim
select is(
  (select (receipt_id = current_setting('test.rc1')::uuid)::text || '/'
       || (campaign_id = current_setting('test.camp')::uuid)::text || '/'
       || (rule_snapshot->>'total_points') || '/'
       || (expires_at = '2027-07-25T10:00:00Z'::timestamptz)::text
     from public.points_transactions
    where id = current_setting('test.txn1')::uuid),
  'true/true/970/true',
  'earn row carries receipt_id, campaign_id, rule_snapshot and expires_at');

-- 7. receipts.processed_at is stamped
select ok(
  (select processed_at is not null from public.receipts
    where id = current_setting('test.rc1')::uuid),
  'award set receipts.processed_at');

-- 8. the receipt stays approved (processed_at, not status, marks it paid)
select is(
  (select status from public.receipts where id = current_setting('test.rc1')::uuid),
  'approved',
  'award does not change receipts.status');

-- 9. CRM counters after the first award
select is(
  (select points_balance::text || '/' || lifetime_points::text || '/'
       || lifetime_spend_centavos::text || '/' || visit_count::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  '970/970/48500/1',
  'first award set balance 970, lifetime 970, spend 48500, visit_count 1');

-- 10. both visit timestamps anchor on the receipt's own receipt_date
select is(
  (select first_visit_at::text || '/' || last_visit_at::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  ('2026-07-25T10:00:00Z'::timestamptz)::text || '/'
    || ('2026-07-25T10:00:00Z'::timestamptz)::text,
  'first_visit_at and last_visit_at are the receipt_date of the first receipt');

-- ---------------------------------------------------------------- double award
-- 11. one earn per receipt (pt_receipt_earn_once is the DB backstop; the RPC
--     raises the clean code before the index is reached)
select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc1')::uuid, 970)$$,
  'P0001', 'RECEIPT_ALREADY_AWARDED',
  'second award of the same receipt raises RECEIPT_ALREADY_AWARDED');

-- 12. and it wrote nothing: still one earn row, balance still 970
select is(
  (select count(*)::int from public.points_transactions
    where receipt_id = current_setting('test.rc1')::uuid)
  || '/' ||
  (select points_balance::text from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  '1/970',
  'refused double award left exactly one ledger row and an unchanged balance');

-- ---------------------------------------------------------------- same Manila day
select set_config('test.txn2',
  public.award_receipt_points(current_setting('test.rc2')::uuid, 100)::text, true);

-- 13. balance_after continues the chain under the pair lock
select is(
  (select balance_after from public.points_transactions
    where id = current_setting('test.txn2')::uuid),
  1070,
  'second earn row has balance_after 1070 (prev 970 + 100)');

-- 14. same Manila day (18:00 then 21:00 Manila) = ONE visit, per doc 40
select is(
  (select visit_count::text || '/' || points_balance::text || '/'
       || lifetime_spend_centavos::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  '1/1070/58500',
  'second receipt on the SAME Manila day does not increment visit_count');

-- 15. last_visit_at still advances within the day
select is(
  (select last_visit_at from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  '2026-07-25T13:00:00Z'::timestamptz,
  'last_visit_at advanced to the later same-day receipt_date');

-- ---------------------------------------------------------------- next Manila day
-- rc3 is 2026-07-25T17:00Z: the same UTC date as rc1/rc2 but 2026-07-26 in
-- Manila. This is the assertion a naive UTC comparison fails.
select set_config('test.txn3',
  public.award_receipt_points(current_setting('test.rc3')::uuid, 200)::text, true);

-- 16. the Manila date boundary is crossed, so this IS a new visit
select is(
  (select visit_count from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  2,
  'receipt at 17:00Z (2026-07-26 Manila) increments visit_count to 2 despite the same UTC date');

-- 17. and last_visit_at follows it forward
select is(
  (select last_visit_at from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  '2026-07-25T17:00:00Z'::timestamptz,
  'last_visit_at is the 17:00Z receipt_date after the third award');

-- ---------------------------------------------------------------- backdated
-- rc4 is dated 2026-07-24 Manila and arrives last (inside the 3-day
-- receipts.max_age_days window).
select set_config('test.txn4',
  public.award_receipt_points(current_setting('test.rc4')::uuid, 50)::text, true);

-- 18. a receipt older than last_visit_at does NOT buy an extra visit
select is(
  (select visit_count from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  2,
  'backdated receipt does not increment visit_count (strictly-later rule)');

-- 19. and last_visit_at never moves backwards
select is(
  (select last_visit_at from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  '2026-07-25T17:00:00Z'::timestamptz,
  'backdated receipt does not drag last_visit_at backwards');

-- 20. first_visit_at is set once and never rewritten
select is(
  (select first_visit_at from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  '2026-07-25T10:00:00Z'::timestamptz,
  'first_visit_at is unchanged by later awards');

-- 21. points still accrue on a backdated receipt: 4 earn rows, 1320 points
select is(
  (select count(*)::int from public.points_transactions
    where consumer_id = 'c3333333-3333-4333-8333-333333333333'
      and business_id = current_setting('test.biz')::uuid
      and type = 'earn'),
  4,
  'all four approved receipts produced an earn row');

-- 22. THE invariant: ledger sum equals the cached balance (doc 35 principle 2)
select is(
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where consumer_id = 'c3333333-3333-4333-8333-333333333333'
      and business_id = current_setting('test.biz')::uuid),
  (select points_balance from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  'ledger sum equals the cached points_balance');

-- 23. and the lifetime counters accumulated every receipt total
select is(
  (select lifetime_points::text || '/' || lifetime_spend_centavos::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c3333333-3333-4333-8333-333333333333'),
  '1320/83500',
  'lifetime_points 1320 and lifetime_spend_centavos 83500 (48500+10000+20000+5000)');

-- ---------------------------------------------------------------- status guards
-- 24-26. only approved receipts are awardable
select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc_queued')::uuid, 100)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'queued receipt raises RECEIPT_NOT_AWARDABLE');

select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc_review')::uuid, 100)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'receipt in review raises RECEIPT_NOT_AWARDABLE');

select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc_rejected')::uuid, 100)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'rejected receipt raises RECEIPT_NOT_AWARDABLE');

-- 27. approved but unmatched: no business means no pair to credit
select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc_nobiz')::uuid, 100)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'approved receipt with null business_id raises RECEIPT_NOT_AWARDABLE');

-- 28. unknown receipt id gets the same code (no existence oracle, no crash)
select throws_ok(
  $$select public.award_receipt_points('00000000-0000-4000-8000-000000000000'::uuid, 100)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'unknown receipt id raises RECEIPT_NOT_AWARDABLE');

-- ---------------------------------------------------------------- input guards
-- 29. null receipt id
select throws_ok(
  $$select public.award_receipt_points(null::uuid, 100)$$,
  'P0001', 'AWARD_RECEIPT_ID_REQUIRED',
  'null p_receipt_id raises AWARD_RECEIPT_ID_REQUIRED');

-- 30. zero points would violate points <> 0 and means nothing was earned
select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc_points')::uuid, 0)$$,
  'P0001', 'AWARD_POINTS_INVALID',
  'p_points = 0 raises AWARD_POINTS_INVALID');

-- 31. negative points would be a clawback entering through the earn door
select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc_points')::uuid, -100)$$,
  'P0001', 'AWARD_POINTS_INVALID',
  'negative p_points raises AWARD_POINTS_INVALID');

-- 32. null points
select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc_points')::uuid, null::integer)$$,
  'P0001', 'AWARD_POINTS_INVALID',
  'null p_points raises AWARD_POINTS_INVALID');

-- 33. none of the four refusals above touched the otherwise-awardable receipt
select is(
  (select count(*)::int from public.points_transactions
    where receipt_id = current_setting('test.rc_points')::uuid)
  || '/' ||
  (select (processed_at is null)::text from public.receipts
    where id = current_setting('test.rc_points')::uuid),
  '0/true',
  'refused input-guard calls wrote no ledger row and left processed_at null');

-- ---------------------------------------------------------------- blacklisted
-- 34. doc 35 s12: CUSTOMER_BLACKLISTED blocks earn as well as claim/redeem
select throws_ok(
  $$select public.award_receipt_points(current_setting('test.rc_black')::uuid, 100)$$,
  'P0001', 'CUSTOMER_BLACKLISTED',
  'blacklisted consumer cannot be awarded points');

-- 35. and nothing was written for that pair
select is(
  (select count(*)::int from public.points_transactions
    where consumer_id = 'c4444444-4444-4444-8444-444444444444')
  || '/' ||
  (select points_balance::text from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c4444444-4444-4444-8444-444444444444'),
  '0/0',
  'blacklisted refusal wrote no ledger row and left the balance at 0');

-- ---------------------------------------------------------------- null receipt_date
-- 36. doc 40: event_ts falls back to created_at, so a dateless receipt still
--     registers a visit and still anchors both visit timestamps
select set_config('test.txn_nodate',
  public.award_receipt_points(current_setting('test.rc_nodate')::uuid, 123)::text, true);

select is(
  (select visit_count::text || '/' || (first_visit_at = last_visit_at)::text || '/'
       || (last_visit_at = current_setting('test.rc_nodate_created')::timestamptz)::text
       || '/' || lifetime_spend_centavos::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'c5555555-5555-4555-8555-555555555555'),
  '1/true/true/12300',
  'receipt with null receipt_date counts one visit anchored on created_at');

-- ---------------------------------------------------------------- grants
-- 37-38. system function: only the service-role pipeline may mint points
select ok(
  not has_function_privilege('anon',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz)', 'EXECUTE'),
  'anon cannot execute award_receipt_points');

select ok(
  not has_function_privilege('authenticated',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz)', 'EXECUTE'),
  'authenticated cannot execute award_receipt_points');

select ok(
  has_function_privilege('service_role',
    'public.award_receipt_points(uuid, integer, jsonb, uuid, timestamptz)', 'EXECUTE'),
  'service_role can execute award_receipt_points');

select * from finish();

rollback;
