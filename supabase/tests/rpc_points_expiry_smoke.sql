-- ============================================================================
-- rpc_points_expiry_smoke.sql (pgTAP)
-- Task 1.3: points expiry enforcement, INCLUDING the review-fix pass
-- (0045/0046, plus 0042's replaced append-only fence). Covers doc 35 section
-- 7's FIFO remainder formula ordered by EXPIRY not creation (private.
-- points_lot_remainders / private.points_expirable_remainder), the wallet's
-- shared read (public.points_next_expiry), the sweep (public.expire_points)
-- including its self-clearing candidate scan and restored audit fields, the
-- warn job (public.points_expiry_warn) using the PROJECTED remainder at both
-- horizons rather than the soonest lot, its self-clearing scan and its
-- concurrency-safe lock, the pg_cron schedules for both, the service_role-only
-- grant on every new `public.` surface (including `points_expirable_remainder`,
-- missed by the first pass), the not-even-service_role posture on both
-- `private.` helpers, and the append-only fence's one permanent exception.
--
-- Runs entirely inside one transaction and rolls back. Execute as a
-- privileged role (postgres) against a database with migrations 0001-0046
-- applied.
--
-- Fixture strategy: one business ("Expiry Cafe"), consumer ids prefixed by
-- scenario, each isolated so every assertion filters by its own (business,
-- consumer) pair. Consumer id PREFIXES are chosen deliberately for the I2
-- self-clearing proof: 'a1111.../a2222.../a3333...' sort before every other
-- prefix used here ('e', 'f', 'g', 'm'), so a small `p_limit` on
-- `expire_points` deterministically reaches them first regardless of what
-- else exists in this transaction or the live project.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(60);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('e1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-expiry-owner@example.com', '{"full_name": "Expiry Owner"}'::jsonb),
  ('e2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-expiry-main@example.com', '{"full_name": "Main Scenario"}'::jsonb),
  ('e3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-expiry-full@example.com', '{"full_name": "Fully Consumed"}'::jsonb),
  ('e4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-expiry-clawback@example.com', '{"full_name": "Clawback Only"}'::jsonb),
  ('e5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-expiry-warn30@example.com', '{"full_name": "Warn Thirty"}'::jsonb),
  ('e6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-expiry-warnboth@example.com', '{"full_name": "Warn Both"}'::jsonb),
  ('f1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-expiry-ordering@example.com', '{"full_name": "I1 Ordering"}'::jsonb),
  ('81111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-expiry-shadow@example.com', '{"full_name": "I3 Shadow"}'::jsonb),
  ('a1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-expiry-selfclear1@example.com', '{"full_name": "I2 Self Clear 1"}'::jsonb),
  ('a2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-expiry-selfclear2@example.com', '{"full_name": "I2 Self Clear 2"}'::jsonb),
  ('a3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-expiry-selfclear3@example.com', '{"full_name": "I2 Self Clear 3"}'::jsonb),
  ('d1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-expiry-backfilled@example.com', '{"full_name": "M5 Backfilled"}'::jsonb),
  ('91111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-expiry-fence@example.com', '{"full_name": "I4 Fence"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Expiry Cafe', 'cafe', 'cebu', '1 Rolling Ave')::text),
  true);
reset role;

-- ---- scenario "main": two lots, one redeem, one clawback (unaffected by the
-- I1 ordering fix: both lots carry non-null expires_at already in creation
-- order, so expiry order and creation order agree here).
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222', 550);

with e1 as (
  insert into public.points_transactions
    (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
  values (current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222',
          'earn', 500, 500, now() - interval '400 days', now() - interval '35 days')
  returning id, expires_at
)
select set_config('test.main_lot1_expires', (select expires_at::text from e1), true);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at)
values (current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222',
        'redeem', -200, 300, now() - interval '200 days');

with e2 as (
  insert into public.points_transactions
    (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
  values (current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222',
          'earn', 300, 600, now() - interval '100 days', now() + interval '265 days')
  returning id, expires_at
)
select set_config('test.main_lot2_expires', (select expires_at::text from e2), true);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at)
values (current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222',
        'clawback', -50, 550, now() - interval '50 days');

-- ---- scenario "full": one lot, one redeem that drains it entirely.
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333', 0);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333',
        'earn', 200, 200, now() - interval '400 days', now() - interval '35 days');

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at)
values (current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333',
        'redeem', -200, 0, now() - interval '100 days');

-- ---- scenario "clawback": one lot, consumed ONLY by a clawback (no redeem).
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e4444444-4444-4444-8444-444444444444', 60);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'e4444444-4444-4444-8444-444444444444',
        'earn', 100, 100, now() - interval '400 days', now() - interval '35 days');

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at)
values (current_setting('test.biz')::uuid, 'e4444444-4444-4444-8444-444444444444',
        'clawback', -40, 60, now() - interval '100 days');

-- ---- scenario "warn30": one lot expiring in 20 days (inside 30d, outside 7d).
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e5555555-5555-4555-8555-555555555555', 150);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'e5555555-5555-4555-8555-555555555555',
        'earn', 150, 150, now() - interval '345 days', now() + interval '20 days');

-- ---- scenario "warn-both": one lot expiring in 5 days (inside BOTH horizons).
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e6666666-6666-4666-8666-666666666666', 80);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'e6666666-6666-4666-8666-666666666666',
        'earn', 80, 80, now() - interval '360 days', now() + interval '5 days');

-- ---- scenario "ordering" (I1 counter-example): a positive adjust (null
-- expiry, day 1) then an earn (expires in 1 day, day 2), then one redeem
-- draining exactly the adjust's amount. Doc 35's FIFO (expiry order, null=+∞)
-- must drain the EARN first (it can actually expire) leaving the
-- never-expiring adjust untouched, not the other way around.
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'f1111111-1111-4111-8111-111111111111', 300);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, adjust_reason)
values (current_setting('test.biz')::uuid, 'f1111111-1111-4111-8111-111111111111',
        'adjust', 500, 500, now() - interval '2 days', 'pgTAP fixture');

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'f1111111-1111-4111-8111-111111111111',
        'earn', 300, 800, now() - interval '1 days', now() + interval '1 days');

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at)
values (current_setting('test.biz')::uuid, 'f1111111-1111-4111-8111-111111111111',
        'redeem', -500, 300, now());

-- ---- scenario "shadow" (I3 counter-example): lot A (50pts, 10 days out)
-- would shadow lot B (500pts, 12 days out) under a "soonest lot" warn - the
-- projected-remainder formula must report BOTH (550) at the 30d horizon in
-- ONE run.
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, '81111111-1111-4111-8111-111111111111', 550);

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, '81111111-1111-4111-8111-111111111111',
        'earn', 50, 50, now() - interval '355 days', now() + interval '10 days');

insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, '81111111-1111-4111-8111-111111111111',
        'earn', 500, 550, now() - interval '353 days', now() + interval '12 days');

-- ---- scenario "self-clear" (I2, sweep): three pairs, each ONE past-due lot,
-- consumer ids sorting before every other fixture in this file so a small
-- p_limit reaches them deterministically.
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'a1111111-1111-4111-8111-111111111111', 100);
insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'a1111111-1111-4111-8111-111111111111',
        'earn', 100, 100, now() - interval '400 days', now() - interval '35 days');

insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'a2222222-2222-4222-8222-222222222222', 100);
insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'a2222222-2222-4222-8222-222222222222',
        'earn', 100, 100, now() - interval '400 days', now() - interval '35 days');

insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'a3333333-3333-4333-8333-333333333333', 100);
insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'a3333333-3333-4333-8333-333333333333',
        'earn', 100, 100, now() - interval '400 days', now() - interval '35 days');

-- ---- scenario "backfilled" (M5): a lot whose expires_at is ALREADY past at
-- the moment it is created, simulating 0042's own backfill of pre-existing
-- history. Must be silently swept (never warned - the warn job's job is lead
-- time before something that has not happened yet).
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'd1111111-1111-4111-8111-111111111111', 90);
insert into public.points_transactions
  (business_id, consumer_id, type, points, balance_after, created_at, expires_at)
values (current_setting('test.biz')::uuid, 'd1111111-1111-4111-8111-111111111111',
        'earn', 90, 90, now() - interval '400 days', now() - interval '5 days');

-- ============================================================================
-- FIFO remainder vectors (private.points_lot_remainders / private.
-- points_expirable_remainder), doc 35 section 7's formula, ordered by expiry
-- ============================================================================

-- 1. partial consumption: lot1's 500 minus 250 of debits leaves 250
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222')
   where txn_id = (select id from public.points_transactions
                     where business_id = current_setting('test.biz')::uuid
                       and consumer_id = 'e2222222-2222-4222-8222-222222222222'
                       and type = 'earn' and points = 500)),
  250, 'v1 partial consumption');

-- 2. multiple lots: the LATER lot is untouched
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222')
   where txn_id = (select id from public.points_transactions
                     where business_id = current_setting('test.biz')::uuid
                       and consumer_id = 'e2222222-2222-4222-8222-222222222222'
                       and type = 'earn' and points = 300)),
  300, 'v2 later lot untouched');

-- 3. fully consumed lot expires 0
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333')),
  0, 'v3 fully consumed lot');

-- 4. clawback interaction: a clawback with NO redeem still consumes FIFO
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'e4444444-4444-4444-8444-444444444444')),
  60, 'v4 clawback-only consumption');

-- 5-6 (I1 counter-example). The earn (finite expiry) is drained FIRST,
-- leaving remainder 0; the never-expiring adjust absorbs the debit LAST and
-- keeps 300.
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'f1111111-1111-4111-8111-111111111111')
   where txn_id = (select id from public.points_transactions
                     where business_id = current_setting('test.biz')::uuid
                       and consumer_id = 'f1111111-1111-4111-8111-111111111111'
                       and type = 'earn')),
  0, 'v5 (I1) the finite-expiry lot is drained first, remainder 0');

select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'f1111111-1111-4111-8111-111111111111')
   where txn_id = (select id from public.points_transactions
                     where business_id = current_setting('test.biz')::uuid
                       and consumer_id = 'f1111111-1111-4111-8111-111111111111'
                       and type = 'adjust')),
  300, 'v6 (I1) the never-expiring (null-expiry) lot is drained LAST, keeps 300');

-- 7. aggregate at asof=now(): only the past-due lot1 counts (250), not lot2
select is(
  private.points_expirable_remainder(
    current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222', now()),
  250, 'v7 aggregate at now()');

-- 8. aggregate at a future asof past BOTH lots' expiry: both count (550)
select is(
  private.points_expirable_remainder(
    current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222',
    now() + interval '300 days'),
  550, 'v8 aggregate at far-future asof');

-- 9. the public wrapper agrees with the private formula
select is(
  public.points_expirable_remainder(
    current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222', now()),
  250, 'v9 public wrapper matches private formula');

-- ============================================================================
-- public.points_next_expiry (the wallet's shared read)
-- ============================================================================

-- 10. the past-due lot is excluded; the soonest FUTURE lot (300pts) shows
select is(
  (select points::text || '/' || (expires_at = current_setting('test.main_lot2_expires')::timestamptz)::text
     from public.points_next_expiry(
       current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222')),
  '300/true', 'v10 points_next_expiry skips the past-due lot');

-- 11. a fully-drained pair has nothing left to show
select ok(
  not exists (
    select 1 from public.points_next_expiry(
      current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333')
  ), 'v11 points_next_expiry: nothing left to show');

-- ============================================================================
-- I2 — self-clearing sweep candidate scan, proven with a small p_limit
-- ============================================================================

-- 12. first small-limit sweep reaches exactly the two lowest-sorting pairs
select public.expire_points(2);

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'a1111111-1111-4111-8111-111111111111' and type = 'expire'),
  1, 'v12 self-clear pair 1 reached on the first small-limit run');

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'a2222222-2222-4222-8222-222222222222' and type = 'expire'),
  1, 'v13 self-clear pair 2 reached on the first small-limit run');

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333' and type = 'expire'),
  0, 'v14 self-clear pair 3 NOT yet reached (limit exhausted by pairs 1-2)');

-- 15. a second small-limit run reaches pair 3 ONLY because pairs 1-2 cleared
-- and dropped out of candidacy - this is I2's whole point.
select public.expire_points(2);

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'a3333333-3333-4333-8333-333333333333' and type = 'expire'),
  1, 'v15 (I2) self-clear pair 3 IS reached once pairs 1-2 cleared a slot');

-- ============================================================================
-- public.expire_points (the sweep) - full sweep + idempotency + I5 audit
-- ============================================================================

select public.expire_points(500);

-- 16. main pair: exactly one expire row, -250, balance_after 300
select is(
  (select points::text || '/' || balance_after::text
     from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'
      and type = 'expire'),
  '-250/300', 'v16 main pair expire row');

-- 17. main pair: cached balance equals the ledger sum
select is(
  (select points_balance from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  'v17 main pair balance == ledger sum');

-- 18-19 (I5). main pair's expire row carries the audit sums, not just the
-- remainder: X(t)=500 (lot1's own points), D=250 (redeem 200 + clawback 50).
select is(
  (select (rule_snapshot->>'x_expired_sum')::int || '/' ||
          (rule_snapshot->>'d_drained_sum')::int || '/' ||
          (rule_snapshot->>'remainder')::int
     from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'
      and type = 'expire'),
  '500/250/250', 'v18 (I5) main pair''s expire row carries x_expired_sum/d_drained_sum/remainder');

select is(
  (select (rule_snapshot->>'x_expired_sum')::int || '/' ||
          (rule_snapshot->>'d_drained_sum')::int || '/' ||
          (rule_snapshot->>'remainder')::int
     from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444'
      and type = 'expire'),
  '100/40/60', 'v19 (I5) clawback pair''s expire row carries x_expired_sum/d_drained_sum/remainder');

-- 20. clawback pair: exactly one expire row, -60, balance_after 0
select is(
  (select points::text || '/' || balance_after::text
     from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444'
      and type = 'expire'),
  '-60/0', 'v20 clawback pair expire row');

-- 21. clawback pair: cached balance equals the ledger sum
select is(
  (select points_balance from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444'),
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444'),
  'v21 clawback pair balance == ledger sum');

-- 22. the fully-consumed pair (balance 0, never a candidate) got no expire row
select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e3333333-3333-4333-8333-333333333333'
      and type = 'expire'),
  0, 'v22 zero-balance pair never a sweep candidate');

-- 23. points_next_expiry for the main pair is unchanged by the sweep
select is(
  (select points::text || '/' || (expires_at = current_setting('test.main_lot2_expires')::timestamptz)::text
     from public.points_next_expiry(
       current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222')),
  '300/true', 'v23 points_next_expiry unchanged by the sweep');

-- 24 (M5). The backfilled-past-due pair IS swept.
select is(
  (select points::text || '/' || balance_after::text
     from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd1111111-1111-4111-8111-111111111111'
      and type = 'expire'),
  '-90/0', 'v24 (M5) a backfilled-already-past-due lot is swept');

-- 25-28. idempotency: a second full sweep expires nothing more for any pair
select public.expire_points(500);

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222' and type = 'expire'),
  1, 'v25 idempotent: main pair still exactly one expire row');

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444' and type = 'expire'),
  1, 'v26 idempotent: clawback pair still exactly one expire row');

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id in ('a1111111-1111-4111-8111-111111111111',
                          'a2222222-2222-4222-8222-222222222222',
                          'a3333333-3333-4333-8333-333333333333')
      and type = 'expire'),
  3, 'v27 idempotent: all three self-clear pairs still exactly one expire row each');

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'd1111111-1111-4111-8111-111111111111' and type = 'expire'),
  1, 'v28 idempotent: backfilled pair still exactly one expire row');

-- ============================================================================
-- public.points_expiry_warn — the PROJECTED remainder at both horizons (I3),
-- dedupe honored, M5's silent-sweep-no-warning case
-- ============================================================================

select public.points_expiry_warn(500);

-- 29. warn30 pair: one 30d notice per channel (in_app + email)
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e5555555-5555-4555-8555-555555555555'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring' and data->>'horizon' = '30d'),
  2, 'v29 warn30: one 30d notice per channel');

-- 30. warn30 pair: no 7d notice (lot is 20 days out)
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e5555555-5555-4555-8555-555555555555'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring' and data->>'horizon' = '7d'),
  0, 'v30 warn30: no 7d notice yet');

-- 31. warn30: channel split correct (in_app sent, email pending)
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e5555555-5555-4555-8555-555555555555'
      and kind = 'points_expiring' and data->>'horizon' = '30d'
      and channel = 'in_app' and status = 'sent' and sent_at is not null)
  || '/' ||
  (select count(*)::int from public.notifications
    where user_id = 'e5555555-5555-4555-8555-555555555555'
      and kind = 'points_expiring' and data->>'horizon' = '30d'
      and channel = 'email' and status = 'pending'),
  '1/1', 'v31 warn30: channel split');

-- 32-33. warn-both: both horizons fire from the same lot in one run
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e6666666-6666-4666-8666-666666666666'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring' and data->>'horizon' = '30d'),
  2, 'v32 warn-both: 30d fires');

select is(
  (select count(*)::int from public.notifications
    where user_id = 'e6666666-6666-4666-8666-666666666666'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring' and data->>'horizon' = '7d'),
  2, 'v33 warn-both: 7d fires too, same run');

-- 34-35 (I3). Shadow pair: the 30d notice reports the PROJECTED SUM of BOTH
-- lots (550), not just the soonest one (50) - proving lot B is no longer
-- shadowed. Neither lot is within 7 days, so no 7d notice yet.
select is(
  (select count(*)::int from public.notifications
    where user_id = '81111111-1111-4111-8111-111111111111'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring' and data->>'horizon' = '30d'
      and (data->>'points')::int = 550),
  2, 'v34 (I3) shadow pair''s 30d notice (both channels) reports the combined 550, not the shadowed 50');

select is(
  (select count(*)::int from public.notifications
    where user_id = '81111111-1111-4111-8111-111111111111'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring' and data->>'horizon' = '7d'),
  0, 'v35 (I3) shadow pair: no 7d notice yet (both lots are >7 days out)');

-- 36 (M5). The backfilled-already-past-due pair NEVER gets a warning, at any
-- horizon, ever - it is the sweep's business alone (see 0042's M5 note).
select is(
  (select count(*)::int from public.notifications
    where user_id = 'd1111111-1111-4111-8111-111111111111'
      and kind = 'points_expiring'),
  0, 'v36 (M5) a backfilled-already-past-due lot never gets a warning');

-- 37-39. idempotency: a second warn run raises nothing new for any pair
select public.points_expiry_warn(500);

select is(
  (select count(*)::int from public.notifications
    where user_id = 'e5555555-5555-4555-8555-555555555555' and kind = 'points_expiring'),
  2, 'v37 idempotent: warn30 unchanged');

select is(
  (select count(*)::int from public.notifications
    where user_id = 'e6666666-6666-4666-8666-666666666666' and kind = 'points_expiring'),
  4, 'v38 idempotent: warn-both unchanged');

select is(
  (select count(*)::int from public.notifications
    where user_id = '81111111-1111-4111-8111-111111111111' and kind = 'points_expiring'),
  2, 'v39 idempotent: shadow pair unchanged (same projected sum, deduped)');

-- ============================================================================
-- pg_cron schedules
-- ============================================================================

select is(
  (select schedule::text || '|' || command
     from cron.job where jobname = 'points.expiry_sweep'),
  '10 18 * * *|select public.expire_points(200);', 'v40 points.expiry_sweep schedule');

select is(
  (select schedule::text || '|' || command
     from cron.job where jobname = 'points.expiry_warn'),
  '25 18 * * *|select public.points_expiry_warn(200);', 'v41 points.expiry_warn schedule');

-- ============================================================================
-- I4 — the append-only fence permits exactly one transition, forever
-- ============================================================================

insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, '91111111-1111-4111-8111-111111111111', 42);

with e as (
  insert into public.points_transactions
    (business_id, consumer_id, type, points, balance_after, created_at)
  values (current_setting('test.biz')::uuid, '91111111-1111-4111-8111-111111111111',
          'earn', 42, 42, now())
  returning id
)
select set_config('test.fence_txn', (select id::text from e), true);

-- 42. any OTHER column is still refused. pgTAP's throws_ok 4-arg form
-- matches BOTH errcode and message (its 3-arg form matches errcode +
-- message with an auto-generated description, not errcode + free-text
-- description as might be assumed) - so the exact message the trigger
-- raises is asserted here deliberately, not merely "an error occurred".
select throws_ok(
  $$update public.points_transactions set points = points + 1
     where id = current_setting('test.fence_txn')::uuid$$,
  'P0001',
  'points_transactions is append-only (the one exception: stamping expires_at from null to a value, nothing else)',
  'v42 (I4) updating any other column still raises');

-- 43. the ONE permitted transition: expires_at null -> a value, succeeds
select lives_ok(
  $$update public.points_transactions set expires_at = now() + interval '12 months'
     where id = current_setting('test.fence_txn')::uuid$$,
  'v43 (I4) expires_at null -> value is permitted');

-- 44. and it actually landed
select ok(
  (select expires_at is not null from public.points_transactions
    where id = current_setting('test.fence_txn')::uuid),
  'v44 (I4) the permitted transition actually wrote expires_at');

-- 45. moving expires_at from one non-null value to another is still refused
select throws_ok(
  $$update public.points_transactions set expires_at = now() + interval '13 months'
     where id = current_setting('test.fence_txn')::uuid$$,
  'P0001',
  'points_transactions is append-only (the one exception: stamping expires_at from null to a value, nothing else)',
  'v45 (I4) expires_at value-to-value is still refused');

-- 46. DELETE is still refused, unconditionally (a different message: the
-- DELETE branch raises before ever reaching the column-diff check).
select throws_ok(
  $$delete from public.points_transactions where id = current_setting('test.fence_txn')::uuid$$,
  'P0001',
  'points_transactions is append-only',
  'v46 (I4) DELETE is still refused');

-- ============================================================================
-- I-A grants: every new public.* surface is service_role only (C1 adds the
-- one the first pass missed: points_expirable_remainder); both private.*
-- helpers are not directly callable even by service_role.
-- ============================================================================

select ok(not has_function_privilege('anon', 'public.expire_points(integer)', 'EXECUTE'), 'v47');
select ok(not has_function_privilege('authenticated', 'public.expire_points(integer)', 'EXECUTE'), 'v48');
select ok(has_function_privilege('service_role', 'public.expire_points(integer)', 'EXECUTE'), 'v49');

select ok(not has_function_privilege('anon', 'public.points_expiry_warn(integer)', 'EXECUTE'), 'v50');
select ok(not has_function_privilege('authenticated', 'public.points_expiry_warn(integer)', 'EXECUTE'), 'v51');
select ok(has_function_privilege('service_role', 'public.points_expiry_warn(integer)', 'EXECUTE'), 'v52');

select ok(not has_function_privilege('anon', 'public.points_next_expiry(uuid, uuid)', 'EXECUTE'), 'v53');
select ok(not has_function_privilege('authenticated', 'public.points_next_expiry(uuid, uuid)', 'EXECUTE'), 'v54');
select ok(has_function_privilege('service_role', 'public.points_next_expiry(uuid, uuid)', 'EXECUTE'), 'v55');

-- C1 fix: public.points_expirable_remainder was exercised functionally (v9)
-- but never pinned. Pinned now.
select ok(
  not has_function_privilege('anon',
    'public.points_expirable_remainder(uuid, uuid, timestamptz)', 'EXECUTE'), 'v56');
select ok(
  not has_function_privilege('authenticated',
    'public.points_expirable_remainder(uuid, uuid, timestamptz)', 'EXECUTE'), 'v57');
select ok(
  has_function_privilege('service_role',
    'public.points_expirable_remainder(uuid, uuid, timestamptz)', 'EXECUTE'), 'v58');

select ok(not has_function_privilege('service_role', 'private.points_lot_remainders(uuid, uuid)', 'EXECUTE'), 'v59');
select ok(not has_function_privilege('service_role',
    'private.points_expirable_remainder(uuid, uuid, timestamptz)', 'EXECUTE'), 'v60');

select * from finish();

rollback;
