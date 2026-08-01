-- ============================================================================
-- rpc_routing_breakdown_smoke.sql (pgTAP)
-- Smoke tests for 0035: public.receipt_routing_breakdown (decision D10).
--
-- Eight independent rules can route a receipt to a human and nobody had ever
-- measured what fraction of real receipts trips at least one. This function is
-- the measurement, so the properties that make it trustworthy are what is
-- asserted here, not the arithmetic (which src/features/receipts/
-- routing-breakdown.test.ts owns):
--
--   * TENANCY. A business-scoped call counts that tenant's receipts and no
--     other's. This is the assertion that matters most: the function is
--     service_role only and the TypeScript caller holds the fence, so a bug
--     here is a cross-tenant leak wearing a percentage sign.
--   * ATTRIBUTION. Each recorded reason is counted once per receipt, a receipt
--     carrying several reasons contributes to each, and reason counts are taken
--     over receipts IN REVIEW alone.
--   * BACKFILL HONESTY. A receipt in review whose parse_meta predates
--     `review_reasons` is counted as 'unattributed' rather than folded into any
--     real reason. This is the whole reason the bucket exists: inflating a rule
--     with rows that are not evidence for it would tune a threshold on history.
--   * THE WINDOW. p_days bounds the population, and a clamp stops a zero or a
--     negative from returning an empty breakdown that reads like a healthy
--     platform with no receipts.
--   * GRANTS. service_role only, the 0016 / 0028 pairing: the function reads
--     parse_meta, which 0017 deliberately withholds from `authenticated`.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0035 applied. pgTAP
-- lives in the extensions schema.
--
-- Fixture strategy: identical to rpc_sweeps_smoke.sql and rpc_award_smoke.sql.
-- Insert directly into auth.users (the on_auth_user_created trigger creates
-- profiles + consumers), create each tenant via register_business under
-- set-local-role authenticated, then seed receipts as the privileged role
-- (standing in for the service-role pipeline). Every fixture id is captured
-- from its own "returning id" CTE and never looked up by name or by a global
-- select over the table, so live data can never be picked up instead of the
-- fixture's own rows.
--
-- now() is transaction-frozen, which is what makes the window arithmetic below
-- exact: the ages the fixtures are inserted with and the cutoff the function
-- computes are read from the same instant.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(14);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('e5111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-rate-owner-a@example.com', '{"full_name": "Rate Owner A"}'::jsonb),
  ('e5222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-rate-owner-b@example.com', '{"full_name": "Rate Owner B"}'::jsonb),
  ('e5333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-rate-consumer@example.com', '{"full_name": "Rate Consumer"}'::jsonb);

-- TWO tenants, because a single-tenant fixture cannot fail the tenancy
-- assertion: every count would be right by accident.
select set_config('request.jwt.claims',
  '{"sub": "e5111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz_a',
  (select public.register_business('Rate Cafe A', 'cafe', 'cebu', '1 Threshold Street')::text),
  true);
reset role;

select set_config('request.jwt.claims',
  '{"sub": "e5222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz_b',
  (select public.register_business('Rate Cafe B', 'cafe', 'cebu', '2 Threshold Street')::text),
  true);
reset role;

-- Tenant A's population, chosen so every branch of the function is exercised
-- and no two counts are the same number (a fixture where several buckets hold
-- the same value cannot tell a mis-grouped query from a correct one):
--
--   2 approved, 1 rejected, 1 queued (collapses to 'pending')
--   4 in review:
--     * one tripping ONE rule            (parse_confidence_low)
--     * one tripping TWO rules           (parse_confidence_low + llm_assisted_field)
--     * one tripping the operator rule   (ocr_operator_failure, from D7)
--     * one with NO review_reasons key   (the backfill -> 'unattributed')
--
-- So: review=4, parse_confidence_low=2, llm_assisted_field=1,
-- ocr_operator_failure=1, unattributed=1. The reason counts sum to 5 against 4
-- reviews, which is correct and is exactly the overlap the surfaces warn about.
insert into public.receipts
  (business_id, user_id, status, image_path, image_hash, sha256, parse_meta)
values
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'approved', 'e5333333-3333-4333-8333-333333333333/a1.jpg',
   '1111111111111111', 'rate-a1-sha-000000000000000000000000000000000000', null),
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'approved', 'e5333333-3333-4333-8333-333333333333/a2.jpg',
   '2222222222222222', 'rate-a2-sha-000000000000000000000000000000000000', null),
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'rejected', 'e5333333-3333-4333-8333-333333333333/a3.jpg',
   '3333333333333333', 'rate-a3-sha-000000000000000000000000000000000000', null),
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'queued', 'e5333333-3333-4333-8333-333333333333/a4.jpg',
   '4444444444444444', 'rate-a4-sha-000000000000000000000000000000000000', null),
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'review', 'e5333333-3333-4333-8333-333333333333/a5.jpg',
   '5555555555555555', 'rate-a5-sha-000000000000000000000000000000000000',
   '{"review_reasons": ["parse_confidence_low"]}'::jsonb),
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'review', 'e5333333-3333-4333-8333-333333333333/a6.jpg',
   '6666666666666666', 'rate-a6-sha-000000000000000000000000000000000000',
   '{"review_reasons": ["llm_assisted_field", "parse_confidence_low"]}'::jsonb),
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'review', 'e5333333-3333-4333-8333-333333333333/a7.jpg',
   '7777777777777777', 'rate-a7-sha-000000000000000000000000000000000000',
   '{"review_reasons": ["ocr_operator_failure"]}'::jsonb),
  -- The backfill: a real parse_meta from before review_reasons existed. It has
  -- the shape of a genuine document, deliberately, so the test proves the
  -- function keys on the ABSENT KEY and not on a null column.
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'review', 'e5333333-3333-4333-8333-333333333333/a8.jpg',
   '8888888888888888', 'rate-a8-sha-000000000000000000000000000000000000',
   '{"engine": "parse/v1", "tier": "heuristic"}'::jsonb);

-- Tenant B: one review carrying a reason tenant A never trips. If any count
-- below picks this up, the scoping is broken.
insert into public.receipts
  (business_id, user_id, status, image_path, image_hash, sha256, parse_meta)
values
  (current_setting('test.biz_b')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'review', 'e5333333-3333-4333-8333-333333333333/b1.jpg',
   '9999999999999999', 'rate-b1-sha-000000000000000000000000000000000000',
   '{"review_reasons": ["merchant_name_mismatch"]}'::jsonb);

-- An OLD receipt of tenant A's, outside every window this test asks for. It
-- exists so the window assertions prove the filter runs rather than proving
-- the fixture happens to be small.
insert into public.receipts
  (business_id, user_id, status, image_path, image_hash, sha256, parse_meta, created_at)
values
  (current_setting('test.biz_a')::uuid, 'e5333333-3333-4333-8333-333333333333',
   'review', 'e5333333-3333-4333-8333-333333333333/a9.jpg',
   'aaaaaaaaaaaaaaaa', 'rate-a9-sha-000000000000000000000000000000000000',
   '{"review_reasons": ["customer_blacklisted"]}'::jsonb,
   now() - interval '400 days');

-- ------------------------------------------------------------ the statuses
-- 1-4. the four outcome buckets, scoped to tenant A. `pending` is the queued
-- receipt: queued and processing are one waiting state, matching receiptOutcome
-- in src/features/receipts/components/receipt-copy.ts.
select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'status' and key = 'approved'),
  2::bigint,
  'approved receipts are counted');

select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'status' and key = 'review'),
  4::bigint,
  'receipts in review are counted');

select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'status' and key = 'rejected'),
  1::bigint,
  'rejected receipts are counted');

select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'status' and key = 'pending'),
  1::bigint,
  'queued and processing collapse into one pending bucket');

-- ------------------------------------------------------------ the reasons
-- 5-7. attribution. A receipt tripping two rules contributes to both, which is
-- why parse_confidence_low is 2 while only one receipt trips it alone.
select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'reason' and key = 'parse_confidence_low'),
  2::bigint,
  'a reason is counted once per receipt that recorded it, across overlaps');

select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'reason' and key = 'llm_assisted_field'),
  1::bigint,
  'the second reason on a receipt that tripped two rules is counted too');

-- D7's receipts arrive here. A merchant seeing a pile of them is seeing
-- something true that the old dead-letter path hid from them entirely.
select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'reason' and key = 'ocr_operator_failure'),
  1::bigint,
  'an operator failure is attributed like any other reason');

-- 8-9. BACKFILL HONESTY, the assertion this function exists to be trusted on.
select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'reason' and key = 'unattributed'),
  1::bigint,
  'CRITICAL: a review with no recorded reason is counted as unattributed');

select is(
  -- sum() over bigint returns numeric; cast so is() resolves to the bigint
  -- overload rather than raising 42883.
  (select sum(tally)::bigint from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'reason'),
  5::bigint,
  'reason counts exceed the review count, because a receipt can trip several rules');

-- ------------------------------------------------------------ tenancy
-- 10-11. THE ASSERTION THAT MATTERS MOST. The function is service_role only and
-- the TypeScript caller holds the fence, so a scoping bug here is a
-- cross-tenant leak wearing a percentage sign.
select is(
  (select count(*)::bigint
     from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'reason' and key = 'merchant_name_mismatch'),
  0::bigint,
  'CRITICAL: another tenant''s review reason never appears in this tenant''s breakdown');

select ok(
  (select tally from public.receipt_routing_breakdown(null, 30)
    where kind = 'reason' and key = 'merchant_name_mismatch') >= 1,
  'the platform-scoped call (p_business_id null) does see both tenants');

-- ------------------------------------------------------------ the window
-- 12-13. p_days bounds the population, and it is clamped so a hostile or
-- fat-fingered zero cannot return an empty breakdown that reads exactly like a
-- healthy platform with no receipts.
select is(
  (select count(*)::bigint
     from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 30)
    where kind = 'reason' and key = 'customer_blacklisted'),
  0::bigint,
  'a receipt older than the window is outside the breakdown');

select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.biz_a')::uuid, 0)
    where kind = 'status' and key = 'review'),
  4::bigint,
  'p_days is clamped to at least 1, so a zero window is not an empty platform');

-- ------------------------------------------------------------ grants
-- 14. service_role only, the 0016 / 0028 pairing. The function reads
-- parse_meta, which 0017 deliberately withholds from `authenticated`; handing
-- it to a client role would route around that grant with an aggregate.
select ok(
  not has_function_privilege('anon',
        'public.receipt_routing_breakdown(uuid, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated',
        'public.receipt_routing_breakdown(uuid, integer)', 'EXECUTE')
  and has_function_privilege('service_role',
        'public.receipt_routing_breakdown(uuid, integer)', 'EXECUTE'),
  'receipt_routing_breakdown is service_role only');

select * from finish();

rollback;
