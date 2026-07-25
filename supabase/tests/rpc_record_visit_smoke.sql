-- ============================================================================
-- rpc_record_visit_smoke.sql (pgTAP)
-- Smoke tests for 0023: public.record_receipt_visit, the ledger-free CRM
-- counter path a zero-point approval takes. Covers the guard order, the doc 40
-- Asia/Manila visit rule (including the UTC/Manila date-boundary case and
-- backdated receipts), spend accumulation, the untouched points columns, the
-- idempotency of a second call, and the service_role-only grant. Also pins the
-- interaction with the award path: an award that follows a recorded visit
-- mints points without adding the same receipt's spend twice.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0023 applied. pgTAP
-- lives in the extensions schema.
--
-- Fixture strategy: identical to rpc_award_smoke.sql. Insert directly into
-- auth.users (the on_auth_user_created trigger creates profiles + consumers),
-- create the tenant via register_business under set-local-role authenticated,
-- then seed receipts as the privileged role (standing in for the service-role
-- pipeline). Every fixture id is captured from its own "returning id" CTE and
-- never looked up by name or by a global select over the table, so live E2E
-- data can never be picked up instead of the fixture's own rows.
--
-- Manila arithmetic used by the visit assertions (UTC+8, no DST):
--   rv1 2026-07-25T10:00Z -> 2026-07-25 18:00 Manila -> day 2026-07-25
--   rv2 2026-07-25T13:00Z -> 2026-07-25 21:00 Manila -> day 2026-07-25 (same)
--   rv3 2026-07-25T17:00Z -> 2026-07-26 01:00 Manila -> day 2026-07-26 (NEXT
--       Manila day, while still the same UTC date as rv1: this is the case a
--       naive UTC comparison gets wrong)
--   rv4 2026-07-24T02:00Z -> 2026-07-24 10:00 Manila -> day 2026-07-24
--       (backdated, submitted last)
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(30);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('d1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-visit-owner@example.com', '{"full_name": "Visit Owner"}'::jsonb),
  ('d3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-visit-consumer@example.com', '{"full_name": "Visit Consumer"}'::jsonb),
  ('d5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-visit-nodate@example.com', '{"full_name": "Dateless Visitor"}'::jsonb),
  ('d6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-visit-mixed@example.com', '{"full_name": "Mixed Path Visitor"}'::jsonb);

-- the owner registers the tenant; the business id comes straight back from the
-- RPC (0003_auth_plumbing.sql), so the tenant is never looked up by name
select set_config('request.jwt.claims',
  '{"sub": "d1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Visit Cafe', 'cafe', 'cebu', '23 Counter Row')::text),
  true);
reset role;

-- ---- receipts. sha256 is globally unique (receipts_sha_unique), so every
-- ---- fixture uses a distinctive prefix that cannot collide with live rows.
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'approved',
          'd3333333-3333-4333-8333-333333333333/visit-1.jpg', 'b0b1c2d3e4f50101',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000001',
          '2026-07-25T10:00:00Z'::timestamptz, 48500)
  returning id
)
select set_config('test.rv1', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'approved',
          'd3333333-3333-4333-8333-333333333333/visit-2.jpg', 'b0b1c2d3e4f50102',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000002',
          '2026-07-25T13:00:00Z'::timestamptz, 10000)
  returning id
)
select set_config('test.rv2', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'approved',
          'd3333333-3333-4333-8333-333333333333/visit-3.jpg', 'b0b1c2d3e4f50103',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000003',
          '2026-07-25T17:00:00Z'::timestamptz, 20000)
  returning id
)
select set_config('test.rv3', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'approved',
          'd3333333-3333-4333-8333-333333333333/visit-4.jpg', 'b0b1c2d3e4f50104',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000004',
          '2026-07-24T02:00:00Z'::timestamptz, 5000)
  returning id
)
select set_config('test.rv4', (select id::text from ins), true);

-- not-recordable statuses, one receipt each
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'queued',
          'd3333333-3333-4333-8333-333333333333/visit-q.jpg', 'b0b1c2d3e4f50105',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000005',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rv_queued', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'review',
          'd3333333-3333-4333-8333-333333333333/visit-v.jpg', 'b0b1c2d3e4f50106',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000006',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rv_review', (select id::text from ins), true);

with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos, reject_reason)
  values (current_setting('test.biz')::uuid,
          'd3333333-3333-4333-8333-333333333333', 'rejected',
          'd3333333-3333-4333-8333-333333333333/visit-x.jpg', 'b0b1c2d3e4f50107',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000007',
          '2026-07-25T10:00:00Z'::timestamptz, 30000, 'duplicate')
  returning id
)
select set_config('test.rv_rejected', (select id::text from ins), true);

-- approved but never matched to a business (business_id nullable until Stage 5)
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (null,
          'd3333333-3333-4333-8333-333333333333', 'approved',
          'd3333333-3333-4333-8333-333333333333/visit-n.jpg', 'b0b1c2d3e4f50108',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000008',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rv_nobiz', (select id::text from ins), true);

-- doc 36 Stage 8 allows a receipt with a total and a NUMBER but no date, so
-- receipt_date is null here; doc 40 says event_ts falls back to created_at.
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd5555555-5555-4555-8555-555555555555', 'approved',
          'd5555555-5555-4555-8555-555555555555/visit-d.jpg', 'b0b1c2d3e4f50109',
          'giya-visit-smoke-sha-0000000000000000000000000000000000000009',
          null, 12300)
  returning id, created_at
)
select set_config('test.rv_nodate', (select id::text from ins), true),
       set_config('test.rv_nodate_created',
                  (select created_at::text from ins), true);

-- the cross-path receipt: its visit is recorded first, then it is awarded
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_date, total_centavos)
  values (current_setting('test.biz')::uuid,
          'd6666666-6666-4666-8666-666666666666', 'approved',
          'd6666666-6666-4666-8666-666666666666/visit-m.jpg', 'b0b1c2d3e4f5010a',
          'giya-visit-smoke-sha-000000000000000000000000000000000000000a',
          '2026-07-25T10:00:00Z'::timestamptz, 30000)
  returning id
)
select set_config('test.rv_mixed', (select id::text from ins), true);

-- ---------------------------------------------------------------- first visit
-- The pair row does not exist yet: creating it is part of what 0023 fixes.
select public.record_receipt_visit(current_setting('test.rv1')::uuid);

-- 1. the pair row now exists and carries spend and one visit, with the points
--    columns untouched: no ledger row was written, so no balance may move
select is(
  (select points_balance::text || '/' || lifetime_points::text || '/'
       || lifetime_spend_centavos::text || '/' || visit_count::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  '0/0/48500/1',
  'first recorded visit set spend 48500 and visit_count 1, points columns still 0');

-- 2. THE point of this function: no ledger row of any type
select is(
  (select count(*)::int from public.points_transactions
    where receipt_id = current_setting('test.rv1')::uuid),
  0,
  'record_receipt_visit wrote no points_transactions row');

-- 3. processed_at is stamped, exactly as the award path stamps it
select ok(
  (select processed_at is not null from public.receipts
    where id = current_setting('test.rv1')::uuid),
  'record_receipt_visit set receipts.processed_at');

-- 4. the receipt stays approved
select is(
  (select status from public.receipts where id = current_setting('test.rv1')::uuid),
  'approved',
  'record_receipt_visit does not change receipts.status');

-- 5. both visit timestamps anchor on the receipt's own receipt_date
select is(
  (select first_visit_at::text || '/' || last_visit_at::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  ('2026-07-25T10:00:00Z'::timestamptz)::text || '/'
    || ('2026-07-25T10:00:00Z'::timestamptz)::text,
  'first_visit_at and last_visit_at are the receipt_date of the first receipt');

-- 6. the idempotency marker is set
select ok(
  (select visit_recorded_at is not null from public.receipts
    where id = current_setting('test.rv1')::uuid),
  'the receipt is marked visit_recorded_at');

-- ---------------------------------------------------------------- idempotency
-- Capture processed_at, then call again. A reprocess or a retry must be a
-- no-op: no second visit, no second helping of spend, no moved timestamp.
select set_config('test.rv1_processed',
  (select processed_at::text from public.receipts
    where id = current_setting('test.rv1')::uuid), true);

select public.record_receipt_visit(current_setting('test.rv1')::uuid);

-- 7. counters are byte-identical after the second call
select is(
  (select points_balance::text || '/' || lifetime_points::text || '/'
       || lifetime_spend_centavos::text || '/' || visit_count::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  '0/0/48500/1',
  'a second record_receipt_visit call double-counts neither the visit nor the spend');

-- 8. and it did not move the monitoring timestamp either
select is(
  (select processed_at from public.receipts
    where id = current_setting('test.rv1')::uuid),
  current_setting('test.rv1_processed')::timestamptz,
  'the no-op second call left processed_at where it was');

-- ---------------------------------------------------------------- same Manila day
select public.record_receipt_visit(current_setting('test.rv2')::uuid);

-- 9. same Manila day (18:00 then 21:00 Manila) = ONE visit, per doc 40
select is(
  (select visit_count::text || '/' || lifetime_spend_centavos::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  '1/58500',
  'second receipt on the SAME Manila day accumulates spend without a new visit');

-- 10. last_visit_at still advances within the day
select is(
  (select last_visit_at from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  '2026-07-25T13:00:00Z'::timestamptz,
  'last_visit_at advanced to the later same-day receipt_date');

-- ---------------------------------------------------------------- next Manila day
-- rv3 is 2026-07-25T17:00Z: the same UTC date as rv1/rv2 but 2026-07-26 in
-- Manila. This is the assertion a naive UTC comparison fails.
select public.record_receipt_visit(current_setting('test.rv3')::uuid);

-- 11. the Manila date boundary is crossed, so this IS a new visit
select is(
  (select visit_count from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  2,
  'receipt at 17:00Z (2026-07-26 Manila) increments visit_count to 2 despite the same UTC date');

-- 12. and last_visit_at follows it forward
select is(
  (select last_visit_at from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  '2026-07-25T17:00:00Z'::timestamptz,
  'last_visit_at is the 17:00Z receipt_date after the third recorded visit');

-- ---------------------------------------------------------------- backdated
select public.record_receipt_visit(current_setting('test.rv4')::uuid);

-- 13. a receipt older than last_visit_at does NOT buy an extra visit
select is(
  (select visit_count from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  2,
  'backdated receipt does not increment visit_count (strictly-later rule)');

-- 14. and last_visit_at never moves backwards
select is(
  (select last_visit_at from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  '2026-07-25T17:00:00Z'::timestamptz,
  'backdated receipt does not drag last_visit_at backwards');

-- 15. first_visit_at is set once and never rewritten
select is(
  (select first_visit_at from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  '2026-07-25T10:00:00Z'::timestamptz,
  'first_visit_at is unchanged by later recorded visits');

-- 16. four recorded receipts, all four totals in lifetime_spend_centavos, and
--     the points columns still exactly where the ledger left them: at zero
select is(
  (select points_balance::text || '/' || lifetime_points::text || '/'
       || lifetime_spend_centavos::text || '/' || visit_count::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd3333333-3333-4333-8333-333333333333'),
  '0/0/83500/2',
  'spend 83500 (48500+10000+20000+5000) over 2 visits, points_balance and lifetime_points still 0');

-- 17. and not one ledger row exists for the pair
select is(
  (select count(*)::int from public.points_transactions
    where consumer_id = 'd3333333-3333-4333-8333-333333333333'
      and business_id = current_setting('test.biz')::uuid),
  0,
  'the whole visit-recording path wrote no ledger rows at all');

-- ---------------------------------------------------------------- null receipt_date
-- 18. doc 40: event_ts falls back to created_at, so a dateless receipt still
--     registers a visit and still anchors both visit timestamps
select public.record_receipt_visit(current_setting('test.rv_nodate')::uuid);

select is(
  (select visit_count::text || '/' || (first_visit_at = last_visit_at)::text || '/'
       || (last_visit_at = current_setting('test.rv_nodate_created')::timestamptz)::text
       || '/' || lifetime_spend_centavos::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd5555555-5555-4555-8555-555555555555'),
  '1/true/true/12300',
  'receipt with null receipt_date counts one visit anchored on created_at');

-- ---------------------------------------------------------------- status guards
-- 19-22. only approved receipts with a business and a consumer are recordable,
--        and the message is 0018's so callers keep one taxonomy
select throws_ok(
  $$select public.record_receipt_visit(current_setting('test.rv_queued')::uuid)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'queued receipt raises RECEIPT_NOT_AWARDABLE');

select throws_ok(
  $$select public.record_receipt_visit(current_setting('test.rv_review')::uuid)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'receipt in review raises RECEIPT_NOT_AWARDABLE');

select throws_ok(
  $$select public.record_receipt_visit(current_setting('test.rv_rejected')::uuid)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'rejected receipt raises RECEIPT_NOT_AWARDABLE');

select throws_ok(
  $$select public.record_receipt_visit(current_setting('test.rv_nobiz')::uuid)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'approved receipt with null business_id raises RECEIPT_NOT_AWARDABLE');

-- 23. unknown receipt id gets the same code (no existence oracle, no crash)
select throws_ok(
  $$select public.record_receipt_visit('00000000-0000-4000-8000-000000000000'::uuid)$$,
  'P0001', 'RECEIPT_NOT_AWARDABLE',
  'unknown receipt id raises RECEIPT_NOT_AWARDABLE');

-- 24. null receipt id, same message 0018 raises
select throws_ok(
  $$select public.record_receipt_visit(null::uuid)$$,
  'P0001', 'AWARD_RECEIPT_ID_REQUIRED',
  'null p_receipt_id raises AWARD_RECEIPT_ID_REQUIRED');

-- 25. none of those refusals touched the receipts they were aimed at
select is(
  (select (processed_at is null)::text || '/' || (visit_recorded_at is null)::text
     from public.receipts where id = current_setting('test.rv_queued')::uuid),
  'true/true',
  'a refused call left processed_at and visit_recorded_at null');

-- ---------------------------------------------------------------- award after visit
-- The shared helper's guard, from the other direction: a receipt whose visit
-- was already recorded is still awardable (no earn row exists yet), the points
-- land, and the spend is NOT added a second time.
select public.record_receipt_visit(current_setting('test.rv_mixed')::uuid);
select set_config('test.txn_mixed',
  public.award_receipt_points(current_setting('test.rv_mixed')::uuid, 100)::text, true);

-- 26. points minted once, spend and visit counted once
select is(
  (select points_balance::text || '/' || lifetime_points::text || '/'
       || lifetime_spend_centavos::text || '/' || visit_count::text
     from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd6666666-6666-4666-8666-666666666666'),
  '100/100/30000/1',
  'award after a recorded visit adds the points but not a second helping of spend');

-- ---------------------------------------------------------------- grants
-- 27-29. system function: only the service-role pipeline may write CRM counters
select ok(
  not has_function_privilege('anon',
    'public.record_receipt_visit(uuid)', 'EXECUTE'),
  'anon cannot execute record_receipt_visit');

select ok(
  not has_function_privilege('authenticated',
    'public.record_receipt_visit(uuid)', 'EXECUTE'),
  'authenticated cannot execute record_receipt_visit');

select ok(
  has_function_privilege('service_role',
    'public.record_receipt_visit(uuid)', 'EXECUTE'),
  'service_role can execute record_receipt_visit');

-- 30. the shared helper is reachable only from inside the definer functions
select ok(
  not has_function_privilege('anon', 'private.apply_receipt_visit(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.apply_receipt_visit(uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.apply_receipt_visit(uuid)', 'EXECUTE'),
  'no app role can execute private.apply_receipt_visit directly');

select * from finish();

rollback;
