-- ============================================================================
-- rpc_points_expiry_smoke.sql (pgTAP)
-- Task 1.3: points expiry enforcement. Covers doc 35 section 7's FIFO
-- remainder formula (private.points_lot_remainders / private.
-- points_expirable_remainder, 0043), the wallet's shared read (public.
-- points_next_expiry, 0043), the sweep (public.expire_points, 0043), the
-- warn job and its 30d/7d dedupe (public.points_expiry_warn, 0044), the
-- pg_cron schedules for both, and the service_role-only grant on every new
-- `public.` surface plus the not-even-service_role posture on both `private.`
-- helpers.
--
-- Runs entirely inside one transaction and rolls back. Execute as a
-- privileged role (postgres) against a database with migrations 0001-0044
-- applied.
--
-- Fixture strategy: one business ("Expiry Cafe"), five consumers, each
-- isolated to one scenario so every assertion below filters by its own
-- (business, consumer) pair rather than trusting a global return count from
-- `expire_points`/`points_expiry_warn` (both scan every pair in the
-- database, so their integer return values are not deterministic against
-- whatever else the live project holds - see 0043/0044's own headers on this
-- being a pre-filter, not an exact one). Ledger rows are inserted directly
-- (as the privileged role, which bypasses RLS and the trigger fences the same
-- way rpc_award_smoke.sql's fixtures do for business_customers) rather than
-- through award_receipt_points, so each scenario's `created_at`/`expires_at`
-- can be pinned exactly instead of depending on `now()` at insert time.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(37);

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
   'giya-expiry-warnboth@example.com', '{"full_name": "Warn Both"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Expiry Cafe', 'cafe', 'cebu', '1 Rolling Ave')::text),
  true);
reset role;

-- ---- scenario "main": two lots, one redeem, one clawback.
-- earn1 500pts, PAST due (expires 35d ago); redeem -200; earn2 300pts, future
-- due (expires 265d out); clawback -50. D = 200+50 = 250.
--   lot1 (500): remaining = min(500, max(0, 500-250))      = 250  (partial)
--   lot2 (300): remaining = min(300, max(0, 800-250))      = 300  (untouched)
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

-- ============================================================================
-- FIFO remainder vectors (private.points_lot_remainders / private.
-- points_expirable_remainder), doc 35 section 7's formula at two granularities
-- ============================================================================

-- 1. partial consumption: lot1's 500 minus 250 of debits leaves 250
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222')
   where txn_id = (select id from public.points_transactions
                     where business_id = current_setting('test.biz')::uuid
                       and consumer_id = 'e2222222-2222-4222-8222-222222222222'
                       and type = 'earn' and points = 500)),
  250,
  'FIFO vector: partially-consumed lot (500pts, 250 debited) leaves remainder 250');

-- 2. multiple lots: the LATER lot is untouched because debits are fully
--    absorbed by the earlier lot first (FIFO, oldest first)
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222')
   where txn_id = (select id from public.points_transactions
                     where business_id = current_setting('test.biz')::uuid
                       and consumer_id = 'e2222222-2222-4222-8222-222222222222'
                       and type = 'earn' and points = 300)),
  300,
  'FIFO vector: a later, untouched lot keeps its full 300 while the earlier lot absorbs every debit');

-- 3. fully consumed lot expires 0
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333')),
  0,
  'FIFO vector: a lot drained exactly by its own redeem leaves remainder 0');

-- 4. clawback interaction: a clawback with NO redeem still consumes FIFO
select is(
  (select remaining from private.points_lot_remainders(
     current_setting('test.biz')::uuid, 'e4444444-4444-4444-8444-444444444444')),
  60,
  'FIFO vector: a clawback alone (no redeem) reduces the lot remainder via D, 100-40=60');

-- 5. aggregate at asof=now(): only the past-due lot1 counts (250), not lot2
select is(
  private.points_expirable_remainder(
    current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222', now()),
  250,
  'aggregate remainder at now() counts only the past-due lot (lot1''s 250)');

-- 6. aggregate at a future asof past BOTH lots' expiry: both count (550)
select is(
  private.points_expirable_remainder(
    current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222',
    now() + interval '300 days'),
  550,
  'aggregate remainder at a far-future asof counts both lots (250+300=550)');

-- 7. the public wrapper agrees with the private formula (spot check)
select is(
  public.points_expirable_remainder(
    current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222', now()),
  250,
  'public.points_expirable_remainder matches the private formula it wraps');

-- ============================================================================
-- public.points_next_expiry (the wallet's shared read)
-- ============================================================================

-- 8. the past-due lot is excluded (that is the sweep's job); the soonest
--    FUTURE lot (lot2, 300pts) is what the wallet would show
select is(
  (select points::text || '/' || (expires_at = current_setting('test.main_lot2_expires')::timestamptz)::text
     from public.points_next_expiry(
       current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222')),
  '300/true',
  'points_next_expiry skips the already-past-due lot and returns the future lot (300pts)');

-- 9. a fully-drained pair has nothing left to show
select ok(
  not exists (
    select 1 from public.points_next_expiry(
      current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333')
  ),
  'points_next_expiry returns no rows for a pair with nothing left to expire');

-- ============================================================================
-- public.expire_points (the sweep)
-- ============================================================================

select public.expire_points(500);

-- 10. main pair: exactly one expire row, -250, balance_after 300
select is(
  (select points::text || '/' || balance_after::text
     from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'
      and type = 'expire'),
  '-250/300',
  'sweep wrote the main pair''s expire row: -250, balance_after 300');

-- 11. main pair: cached balance equals the ledger sum
select is(
  (select points_balance from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  'main pair: cached points_balance equals the ledger sum after the sweep');

-- 12. clawback pair: exactly one expire row, -60, balance_after 0
select is(
  (select points::text || '/' || balance_after::text
     from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444'
      and type = 'expire'),
  '-60/0',
  'sweep wrote the clawback pair''s expire row: -60, balance_after 0');

-- 13. clawback pair: cached balance equals the ledger sum
select is(
  (select points_balance from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444'),
  (select coalesce(sum(points), 0)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444'),
  'clawback pair: cached points_balance equals the ledger sum after the sweep (0)');

-- 14. the fully-consumed pair (balance 0, never a candidate) got no expire row
select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e3333333-3333-4333-8333-333333333333'
      and type = 'expire'),
  0,
  'a zero-balance pair is never a sweep candidate, so it gets no expire row');

-- 15. points_next_expiry for the main pair is unchanged by the sweep (still lot2)
select is(
  (select points::text || '/' || (expires_at = current_setting('test.main_lot2_expires')::timestamptz)::text
     from public.points_next_expiry(
       current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222')),
  '300/true',
  'points_next_expiry still shows the future lot (300pts) after the past-due lot was swept');

-- 16-17. idempotency: a second sweep run expires nothing more for either pair
select public.expire_points(500);

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'
      and type = 'expire'),
  1,
  'idempotent: a second sweep run wrote no additional expire row for the main pair');

select is(
  (select count(*)::int from public.points_transactions
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e4444444-4444-4444-8444-444444444444'
      and type = 'expire'),
  1,
  'idempotent: a second sweep run wrote no additional expire row for the clawback pair');

-- ============================================================================
-- public.points_expiry_warn (the warn job, 30d/7d dedupe)
-- ============================================================================

select public.points_expiry_warn(500);

-- 18. warn30 pair: exactly two rows (in_app + email) at the 30d horizon
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e5555555-5555-4555-8555-555555555555'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring'
      and data->>'horizon' = '30d'),
  2,
  'warn30: one 30d notice per channel (in_app + email)');

-- 19. warn30 pair: no 7d notice yet (its lot is 20 days out)
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e5555555-5555-4555-8555-555555555555'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring'
      and data->>'horizon' = '7d'),
  0,
  'warn30: no 7d notice yet, its lot is 20 days out (outside the 7d horizon)');

-- 20. warn30: the in_app row landed sent, the email row landed pending
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
  '1/1',
  'warn30: in_app landed sent immediately, email landed durable and pending');

-- 21. warn-both pair: both horizons fire from the SAME lot in one run
select is(
  (select count(*)::int from public.notifications
    where user_id = 'e6666666-6666-4666-8666-666666666666'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring'
      and data->>'horizon' = '30d'),
  2,
  'warn-both: the 5-day-out lot also fires the 30d horizon');

select is(
  (select count(*)::int from public.notifications
    where user_id = 'e6666666-6666-4666-8666-666666666666'
      and business_id = current_setting('test.biz')::uuid
      and kind = 'points_expiring'
      and data->>'horizon' = '7d'),
  2,
  'warn-both: the 5-day-out lot fires the 7d horizon too, in the SAME run');

-- 23-24. idempotency: a second warn run raises nothing new for either pair
select public.points_expiry_warn(500);

select is(
  (select count(*)::int from public.notifications
    where user_id = 'e5555555-5555-4555-8555-555555555555'
      and kind = 'points_expiring'),
  2,
  'idempotent: a second warn run raised no additional notice for warn30');

select is(
  (select count(*)::int from public.notifications
    where user_id = 'e6666666-6666-4666-8666-666666666666'
      and kind = 'points_expiring'),
  4,
  'idempotent: a second warn run raised no additional notice for warn-both');

-- ============================================================================
-- pg_cron schedules
-- ============================================================================

-- 25. the sweep is scheduled at doc 39's registered slot
select is(
  (select schedule::text || '|' || command
     from cron.job where jobname = 'points.expiry_sweep'),
  '10 18 * * *|select public.expire_points(200);',
  'points.expiry_sweep is scheduled at 10 18 * * * UTC (02:10 Manila) calling expire_points(200)');

-- 26. the warn job is scheduled right after it
select is(
  (select schedule::text || '|' || command
     from cron.job where jobname = 'points.expiry_warn'),
  '25 18 * * *|select public.points_expiry_warn(200);',
  'points.expiry_warn is scheduled at 25 18 * * * UTC (02:25 Manila) calling points_expiry_warn(200)');

-- ============================================================================
-- I-A grants: every new public.* surface is service_role only; both
-- private.* helpers are not directly callable even by service_role.
-- ============================================================================

-- 27-29. public.expire_points
select ok(
  not has_function_privilege('anon', 'public.expire_points(integer)', 'EXECUTE'),
  'anon cannot execute public.expire_points');
select ok(
  not has_function_privilege('authenticated', 'public.expire_points(integer)', 'EXECUTE'),
  'authenticated cannot execute public.expire_points');
select ok(
  has_function_privilege('service_role', 'public.expire_points(integer)', 'EXECUTE'),
  'service_role can execute public.expire_points');

-- 30-32. public.points_expiry_warn
select ok(
  not has_function_privilege('anon', 'public.points_expiry_warn(integer)', 'EXECUTE'),
  'anon cannot execute public.points_expiry_warn');
select ok(
  not has_function_privilege('authenticated', 'public.points_expiry_warn(integer)', 'EXECUTE'),
  'authenticated cannot execute public.points_expiry_warn');
select ok(
  has_function_privilege('service_role', 'public.points_expiry_warn(integer)', 'EXECUTE'),
  'service_role can execute public.points_expiry_warn');

-- 33-35. public.points_next_expiry
select ok(
  not has_function_privilege('anon', 'public.points_next_expiry(uuid, uuid)', 'EXECUTE'),
  'anon cannot execute public.points_next_expiry');
select ok(
  not has_function_privilege('authenticated', 'public.points_next_expiry(uuid, uuid)', 'EXECUTE'),
  'authenticated cannot execute public.points_next_expiry');
select ok(
  has_function_privilege('service_role', 'public.points_next_expiry(uuid, uuid)', 'EXECUTE'),
  'service_role can execute public.points_next_expiry');

-- 36-37. both private helpers: not executable even by service_role
select ok(
  not has_function_privilege('service_role', 'private.points_lot_remainders(uuid, uuid)', 'EXECUTE'),
  'service_role cannot execute the private points_lot_remainders helper directly');
select ok(
  not has_function_privilege('service_role',
    'private.points_expirable_remainder(uuid, uuid, timestamptz)', 'EXECUTE'),
  'service_role cannot execute the private points_expirable_remainder helper directly');

select * from finish();

rollback;
