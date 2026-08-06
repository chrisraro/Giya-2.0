-- ============================================================================
-- rpc_balance_check_smoke.sql (pgTAP)
-- Smoke tests for 0056-0059: public.balance_check, public.balance_check_
-- findings, public.balance_check_summary, private.balance_check_coverage_
-- days, private.balance_check_priority_count, private.balance_check_is_
-- priority, private.balance_check_findings_pair_cleanup, task 2.2 + three
-- review-fix passes. Runs entirely inside one transaction and rolls back.
-- Execute as a privileged role (postgres) against a database with
-- migrations 0001-0059 applied. The suite runs as `postgres` throughout
-- EXCEPT one deliberate `set local role service_role` block (review fix
-- C2) - see that section for why running everything as a privileged role
-- would otherwise hide exactly the class of bug it exists to catch.
--
-- Fixture strategy: mirror rpc_campaigns_sweep_smoke.sql / rpc_points_expiry_
-- smoke.sql. Two businesses (owners register via register_business under
-- set-local-role authenticated), several consumers created by inserting
-- directly into auth.users (the on_auth_user_created trigger creates
-- profiles + consumers). business_customers and points_transactions rows are
-- seeded directly as the privileged role, standing in for whatever writer
-- produced them - this suite is about the READER (balance_check), not the
-- six writers, which already have their own suites proving their own
-- atomicity (rpc_award_smoke.sql, rpc_claim_smoke.sql, rls_admin_smoke.sql's
-- clawback section, rpc_points_expiry_smoke.sql).
--
-- Consumer ids f2-f7 sort in a KNOWN, deterministic order (f2 < f3 < f4 < f5
-- < f6 < f7) so the rotating-cursor assertions below can name the EXACT pair
-- each call touches. e1-e5 are a second, visually distinct id family for the
-- review-fix additions (I2's two-business consumer, I3b's fresh pair and
-- priority target, M2's cascade fixture, C2's service_role-specific cascade
-- fixture) so they never collide with or shadow the original f-family
-- ordering.
--
-- ON pair F ("rich ledger") - review fix I1. This is NOT a concurrent-write
-- safety proxy and is not called one anywhere below: it would pass
-- identically if `public.balance_check` read the cached balance and the
-- ledger sum in two separate statements, because summing six rows correctly
-- says nothing about WHEN they are read relative to each other, only THAT
-- they sum correctly. What actually proves the single-snapshot property is
-- the STRUCTURAL assertion in the "I1: single statement, one snapshot"
-- section below - pinned via `pg_get_functiondef`, not via any fixture -
-- because this suite cannot spin up a second, truly concurrent database
-- SESSION (no dblink or equivalent is installed in this project, and no
-- other pgTAP suite in this repo does either - grep finds zero uses of
-- dblink/pg_sleep for race simulation here), and a fixture-based proxy
-- relying on Postgres's self-visibility behavior for a trigger mutating a
-- table the same query is reading would pin an implementation accident, not
-- the documented contract. Pair F stays, relabeled: it is a genuine test of
-- summation breadth over a heterogeneous, six-type ledger.
--
-- ON THE "DEFENSE" SECTION (0058, second review-fix pass). 0057 was recorded
-- applied while `public.balance_check`'s deployed body silently diverged
-- from what the committed file described - every supporting object (the new
-- table's FK, the new index, both new functions) deployed correctly, but the
-- one `create or replace function` that actually changes this job's
-- behaviour did not carry the committed text, and nothing in this suite (or
-- anywhere else) checked that the live body matched the file rather than
-- merely behaving plausibly. `pg_get_functiondef` is already read into
-- `test.balchk_def` below for the I1/M5 structural pins; the same value is
-- now ALSO checked for the markers 0058's own logic must be built from - the
-- word "tier" (present only in the priority-tier comment, so its absence is
-- exactly what a comment-stripped deploy like the one that actually shipped
-- would produce) and calls to both `balance_check_priority_count` and
-- `balance_check_coverage_days`. A migration that recreates a function is
-- only as trustworthy as the thing that checks it landed; this is that
-- check, permanently. Review fix I9 (0059) strengthens it further: those
-- three markers only catch a regression to an EARLIER body or comment-
-- stripping specifically - the two things that actually happened - so a
-- monotonic revision comment inside the body (`balance_check body
-- revision: <migration>`) is now pinned exactly, forcing whoever next
-- recreates this function to bump both the comment and this assertion's
-- expected value together.
--
-- ON THE C2 FIX (0059, third review-fix pass). 0058's pair-cleanup trigger
-- function was plain plpgsql, so its internal DELETE on balance_check_
-- findings ran with the INVOKER's privileges - and service_role (the role
-- every internal application code path runs as) has DELETE revoked on that
-- table. The result: service_role could not delete ANY business_customers
-- row at all, unconditionally, worse than the FOR KEY SHARE lock I7 had
-- just removed. This suite could not have caught it on its own, because it
-- runs entirely as postgres, which owns balance_check_findings and was
-- never subject to that revoke - see the dedicated `set local role
-- service_role` block below, the fix (private.balance_check_findings_pair_
-- cleanup is now `security definer`), and I10 (private.balance_check_is_
-- priority, the one shared implementation the tier-0 predicate now has
-- instead of two independent copies that could silently disagree).
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(73);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('f1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-balchk-owner@example.com', '{"full_name": "Balance Check Owner"}'::jsonb),
  ('f2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-balchk-clean@example.com', '{"full_name": "Clean Pair"}'::jsonb),
  ('f3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-balchk-drift@example.com', '{"full_name": "Drifted Pair"}'::jsonb),
  ('f4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-balchk-rich@example.com', '{"full_name": "Rich Ledger Pair"}'::jsonb),
  ('f5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-balchk-rot1@example.com', '{"full_name": "Rotation Pair 1"}'::jsonb),
  ('f6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-balchk-rot2@example.com', '{"full_name": "Rotation Pair 2"}'::jsonb),
  ('f7777777-7777-4777-8777-777777777777', 'authenticated', 'authenticated',
   'giya-balchk-rot3@example.com', '{"full_name": "Rotation Pair 3"}'::jsonb),
  ('e1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-balchk-owner2@example.com', '{"full_name": "Balance Check Owner 2"}'::jsonb),
  ('e2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-balchk-twobiz@example.com', '{"full_name": "Two-Business Pair"}'::jsonb),
  ('e3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-balchk-priority@example.com', '{"full_name": "Never-Checked Bystander"}'::jsonb),
  ('e4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-balchk-cascade@example.com', '{"full_name": "Cascade Pair"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "f1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz',
  (select public.register_business('Balance Check Cafe', 'cafe', 'cebu', '56 Ledger Row')::text),
  true);
reset role;

select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz2',
  (select public.register_business('Balance Check Diner', 'restaurant', 'cebu', '57 Ledger Row')::text),
  true);
reset role;

-- Pair A ("clean"): two earn rows summing to 500, cache agrees.
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'f2222222-2222-4222-8222-222222222222', 500);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.biz')::uuid, 'f2222222-2222-4222-8222-222222222222', 'earn', 300, 300),
  (current_setting('test.biz')::uuid, 'f2222222-2222-4222-8222-222222222222', 'earn', 200, 500);

-- Pair B ("drifted"): one earn row of 500, cache says 650 - a genuine,
-- constructed mismatch (the class of bug this whole task exists to catch;
-- no real writer produces this, which is exactly why it has to be
-- constructed directly as the privileged role rather than through any RPC).
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'f3333333-3333-4333-8333-333333333333', 650);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.biz')::uuid, 'f3333333-3333-4333-8333-333333333333', 'earn', 500, 500);

-- Pair F ("rich ledger", review fix M3 widened it to six of the seven
-- points_transactions.type values): earn/redeem/adjust/expire/clawback/
-- reversal, cache agrees with the signed sum
-- (1000 - 300 + 50 - 100 - 20 + 75 = 705). `reversal` is what cancel_claim
-- and expire_claims write - two of the six writers this job polices, and
-- 0056 shipped with no fixture exercising that type at all.
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 705);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'earn',     1000, 1000),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'redeem',   -300,  700),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'adjust',     50,  750),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'expire',   -100,  650),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'clawback',  -20,  630),
  (current_setting('test.biz')::uuid, 'f4444444-4444-4444-8444-444444444444', 'reversal',   75,  705);

-- Pair G (review fix I2): ONE consumer, active at BOTH businesses, with real
-- ledger activity and a real cached balance at each - the normal case on a
-- multi-tenant loyalty platform that 0056's original suite never
-- constructed. A mutant deleting `and pt.business_id = c.business_id` from
-- the ledger sum folds BOTH businesses' activity into EVERY business's sum
-- (200 + 300 = 500 at both), manufacturing drift at both pairs
-- simultaneously; the correct query keeps them separate and both are clean.
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222', 200);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values (current_setting('test.biz')::uuid, 'e2222222-2222-4222-8222-222222222222', 'earn', 200, 200);

insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz2')::uuid, 'e2222222-2222-4222-8222-222222222222', 300);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values (current_setting('test.biz2')::uuid, 'e2222222-2222-4222-8222-222222222222', 'earn', 300, 300);

-- ------------------------------------------------------ table fence + RLS
select has_table('public', 'balance_check_findings', 'balance_check_findings exists');

select ok(
  (select relrowsecurity from pg_class
    where oid = 'public.balance_check_findings'::regclass),
  'RLS is enabled on balance_check_findings');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'balance_check_findings'),
  0,
  'balance_check_findings carries zero policies (deny-all by construction)');

select ok(
  not has_table_privilege('anon', 'public.balance_check_findings', 'SELECT')
  and not has_table_privilege('authenticated', 'public.balance_check_findings', 'SELECT'),
  'anon and authenticated cannot select balance_check_findings');

select ok(
  has_table_privilege('service_role', 'public.balance_check_findings', 'SELECT'),
  'service_role can select balance_check_findings');

select ok(
  not has_table_privilege('service_role', 'public.balance_check_findings', 'INSERT')
  and not has_table_privilege('service_role', 'public.balance_check_findings', 'UPDATE')
  and not has_table_privilege('service_role', 'public.balance_check_findings', 'DELETE')
  and not has_table_privilege('service_role', 'public.balance_check_findings', 'TRUNCATE'),
  'service_role cannot write balance_check_findings directly - only public.balance_check may');

select throws_ok(
  $$ truncate public.balance_check_findings $$,
  'P0001',
  'balance_check_findings cannot be truncated (integrity evidence)',
  'the no-truncate statement trigger fires even for a role that still holds the privilege');

-- ------------------------------------------------------------ grants (I-A)
select ok(
  not has_function_privilege('anon', 'public.balance_check(integer)', 'EXECUTE'),
  'anon cannot execute public.balance_check');

select ok(
  not has_function_privilege('authenticated', 'public.balance_check(integer)', 'EXECUTE'),
  'authenticated cannot execute public.balance_check');

select ok(
  has_function_privilege('service_role', 'public.balance_check(integer)', 'EXECUTE'),
  'service_role can execute public.balance_check');

select ok(
  not has_function_privilege('anon', 'public.balance_check_summary()', 'EXECUTE'),
  'anon cannot execute public.balance_check_summary');

select ok(
  not has_function_privilege('authenticated', 'public.balance_check_summary()', 'EXECUTE'),
  'authenticated cannot execute public.balance_check_summary');

select ok(
  has_function_privilege('service_role', 'public.balance_check_summary()', 'EXECUTE'),
  'service_role can execute public.balance_check_summary');

select ok(
  not has_function_privilege('anon', 'private.balance_check_coverage_days(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.balance_check_coverage_days(integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.balance_check_coverage_days(integer)', 'EXECUTE'),
  'private.balance_check_coverage_days is reachable by no client or service role');

select ok(
  not has_function_privilege('anon', 'private.balance_check_priority_count(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.balance_check_priority_count(integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.balance_check_priority_count(integer)', 'EXECUTE'),
  'private.balance_check_priority_count is reachable by no client or service role');

select ok(
  not has_function_privilege('anon', 'private.balance_check_is_priority(uuid,uuid,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.balance_check_is_priority(uuid,uuid,timestamptz)', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.balance_check_is_priority(uuid,uuid,timestamptz)', 'EXECUTE'),
  'review fix I10: private.balance_check_is_priority (the one shared tier-0 predicate) is reachable by no client or service role');

select ok(
  not has_function_privilege('anon', 'private.balance_check_findings_pair_cleanup()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.balance_check_findings_pair_cleanup()', 'EXECUTE')
  and not has_function_privilege('service_role', 'private.balance_check_findings_pair_cleanup()', 'EXECUTE'),
  'review fix M17: private.balance_check_findings_pair_cleanup is reachable by no client or service role directly (trigger firing does not need it)');

-- ------------------------------------------------------------ never touches the money path
select set_config('test.pt_count_before',
  (select count(*)::text from public.points_transactions), true);
select set_config('test.bc_balance_before',
  (select points_balance::text from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'), true);

-- This is a live, shared project: business_customers can carry rows this
-- suite did not create (real historical data, or another suite's fixtures).
-- p_limit is set generously (10000) so the run below covers EVERY existing
-- candidate, and the expected return value is read from a COUNT taken in the
-- same instant, not a hardcoded literal - the assertion is "this run checked
-- everything that existed", which holds regardless of how much unrelated
-- data is already live.
select set_config('test.bc_total_before_check1',
  (select count(*)::text from public.business_customers), true);

-- Review fix I8: drifted_count is captured as a BASELINE here, before this
-- run, rather than the run's result being asserted as a hardcoded '1'. A
-- shared live database can already carry drifted findings from real data or
-- an earlier suite run; the only thing this suite can honestly assert is
-- "one MORE pair (pair B) is now drifted than before", not "exactly one
-- pair in the whole table is drifted".
select set_config('test.drifted_before_check1',
  (select count(*) filter (where drifted) from public.balance_check_findings)::text, true);

-- ------------------------------------------------------------ the check: A, B, F, G x2 (+ whatever else is live)
select set_config('test.processed_1', public.balance_check(10000)::text, true);

select is(
  current_setting('test.processed_1'),
  current_setting('test.bc_total_before_check1'),
  'the first run checks every candidate that exists at that instant (at least A, B, F and both of G''s pairs)');

select is(
  (select count(*)::text from public.points_transactions),
  current_setting('test.pt_count_before'),
  'balance_check writes zero points_transactions rows');

select is(
  (select points_balance::text from public.business_customers
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'),
  current_setting('test.bc_balance_before'),
  'balance_check leaves the drifted pair''s cached balance untouched - detection only, never auto-corrected');

-- Pair A: clean
select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f2222222-2222-4222-8222-222222222222'),
  500, 'pair A cached_balance recorded correctly');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f2222222-2222-4222-8222-222222222222'),
  500, 'pair A ledger_sum recorded correctly');
select ok(
  not (select drifted from public.balance_check_findings
        where business_id = current_setting('test.biz')::uuid
          and consumer_id = 'f2222222-2222-4222-8222-222222222222'),
  'pair A (clean) is NOT flagged as drifted');

-- Pair B: genuinely drifted
select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'),
  650, 'pair B cached_balance recorded correctly');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'),
  500, 'pair B ledger_sum recorded correctly');
select ok(
  (select drifted from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f3333333-3333-4333-8333-333333333333'),
  'pair B (genuinely drifted, 650 cached vs 500 ledger) IS flagged as drifted');

-- Pair F: rich, six-type ledger still reconciles (summation breadth - see
-- file header for why this is NOT a concurrency proxy)
select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f4444444-4444-4444-8444-444444444444'),
  705, 'pair F cached_balance recorded correctly');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f4444444-4444-4444-8444-444444444444'),
  705, 'pair F ledger_sum (six rows, six types including reversal) sums correctly in one statement');
select ok(
  not (select drifted from public.balance_check_findings
        where business_id = current_setting('test.biz')::uuid
          and consumer_id = 'f4444444-4444-4444-8444-444444444444'),
  'pair F (rich ledger, clean) is NOT flagged as drifted');

-- ============================================================================
-- I2: the ledger sum must be scoped to the CANDIDATE'S business, proven by a
-- consumer with real activity at TWO businesses. This is the fixture the
-- review found missing: every other consumer above has transactions at
-- exactly one business, so a mutant deleting `and pt.business_id =
-- c.business_id` from the sum was numerically invisible to the whole
-- original suite. Red-verified live: this exact block, run against a
-- deliberately reintroduced mutant of public.balance_check with that
-- predicate removed, failed both assertions below (both pairs read
-- cached=200/ledger=500 and cached=300/ledger=500 - the mutant's cross-
-- tenant leak - rather than each matching its own business) before being
-- run against the real function and passing.
-- ============================================================================
select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  200, 'pair G at business 1 cached_balance recorded correctly');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  200, 'pair G at business 1 ledger_sum is scoped to business 1 alone (200), NOT the cross-business total (500)');
select ok(
  not (select drifted from public.balance_check_findings
        where business_id = current_setting('test.biz')::uuid
          and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  'pair G at business 1 is NOT flagged as drifted');

select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz2')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  300, 'pair G at business 2 cached_balance recorded correctly');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz2')::uuid
      and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  300, 'pair G at business 2 ledger_sum is scoped to business 2 alone (300), NOT the cross-business total (500)');
select ok(
  not (select drifted from public.balance_check_findings
        where business_id = current_setting('test.biz2')::uuid
          and consumer_id = 'e2222222-2222-4222-8222-222222222222'),
  'pair G at business 2 is NOT flagged as drifted');

-- ============================================================================
-- I4: the read side. checked_count matches the exact candidate count the
-- first big run consumed (same dynamic value, not a hardcoded literal);
-- drifted_count is exactly ONE MORE than the baseline captured before the
-- run (review fix I8 - pair B alone is the new drift this run introduces,
-- but a shared live database may already carry others).
-- ============================================================================
select set_config('test.summary_checked', (select checked_count::text from public.balance_check_summary()), true);
select set_config('test.summary_drifted', (select drifted_count::text from public.balance_check_summary()), true);

select is(
  current_setting('test.summary_checked'),
  current_setting('test.bc_total_before_check1'),
  'balance_check_summary().checked_count matches the exact number of pairs the first run checked');
select is(
  current_setting('test.summary_drifted'),
  (current_setting('test.drifted_before_check1')::int + 1)::text,
  'balance_check_summary().drifted_count is exactly one more than the pre-run baseline - pair B is the one new drift this run introduces');
select ok(
  (select oldest_checked_at from public.balance_check_summary()) is not null,
  'balance_check_summary().oldest_checked_at is populated once at least one pair has been checked');

-- ============================================================================
-- I1: single statement, one snapshot - the STRUCTURAL proof (review fix,
-- replacing pair F's retired "concurrency proxy" framing). Pins that there
-- is no statement boundary (no `;`) between the candidate scan reading
-- business_customers and the `returning` clause of the upsert into
-- balance_check_findings, and that both public.business_customers and
-- public.points_transactions are read somewhere inside that same unbroken
-- span. A future refactor that split the read into two separate statements
-- - reintroducing the exact torn-read window the migration header argues
-- against - would break this assertion rather than ship silently.
--
-- Review fix C1: the semicolon check strips `--` line comments FIRST
-- (regexp_replace(span, '--[^\n]*', '', 'g')). The original version checked
-- the raw span, which is wrong in principle - a `;` inside a comment is not
-- a statement boundary - and it was not hypothetical: 0057's own prose
-- described the guarantee as "unbroken by any `;`", a comment that itself
-- contains the character it was warning about, which would have failed this
-- exact assertion the moment a fully-commented body (rather than the
-- accidentally-stripped one 0057 actually shipped) ever reached the
-- database. Every comment in the function bodies this migration deploys is
-- now worded to avoid the character regardless, in addition to the fix
-- below - defence in depth, not either/or.
-- ============================================================================
select set_config('test.balchk_def', pg_get_functiondef('public.balance_check(integer)'::regprocedure), true);
select set_config('test.balchk_span',
  substring(current_setting('test.balchk_def')
    from position('with candidates as (' in current_setting('test.balchk_def'))
    for (position('returning drifted' in current_setting('test.balchk_def'))
         - position('with candidates as (' in current_setting('test.balchk_def'))
         + length('returning drifted'))),
  true);
select set_config('test.balchk_span_no_comments',
  regexp_replace(current_setting('test.balchk_span'), '--[^\n]*', '', 'g'),
  true);

select ok(
  position(';' in current_setting('test.balchk_span_no_comments')) = 0,
  'no semicolon (no statement boundary) between "with candidates as (" and "returning drifted", once line comments are stripped - the candidate read and the upsert are structurally ONE statement');
select ok(
  current_setting('test.balchk_span') ~ 'from public\.business_customers'
  and current_setting('test.balchk_span') ~ 'from public\.points_transactions',
  'both public.business_customers and public.points_transactions are read inside that same unbroken span');

-- ============================================================================
-- DEFENSE (0058): the live body must carry the markers this migration's own
-- logic is built from, not merely behave as if it does. See the file header
-- for exactly what this catches - it is the check that would have caught
-- 0057's divergence immediately instead of leaving it for a live pg_proc
-- query in a later review.
-- ============================================================================
select ok(
  current_setting('test.balchk_def') ~* 'tier',
  'the live balance_check body contains "tier" - proof the deployed function carries the priority-tier logic''s own documentation, not just a behaviourally-similar but differently-sourced body (this exact gap - a green migration whose deployed function silently lacked this - is what 0058 exists to correct)');
select ok(
  current_setting('test.balchk_def') ~ 'balance_check_priority_count\('
  and current_setting('test.balchk_def') ~ 'balance_check_coverage_days\(',
  'the live balance_check body calls both private.balance_check_priority_count and private.balance_check_coverage_days by name - not merely words that could appear in an unrelated comment');

-- Review fix I9: the three markers above catch a regression to an EARLIER
-- body or comment-stripping specifically - the two things that actually
-- happened - but any FUTURE body that happens to be a superset of those
-- three words/calls passes regardless of what else changed, so an unrelated
-- deployment gap on a later migration touching this function would go
-- undetected the same way 0057's did. A monotonic revision marker inside
-- the body closes that: whoever next recreates public.balance_check must
-- bump BOTH this comment and this assertion's expected value, or the two
-- go out of sync in an obviously wrong way rather than staying silently
-- plausible.
select is(
  (regexp_match(current_setting('test.balchk_def'), 'balance_check body revision:\s*(\d+)'))[1],
  '0059',
  'review fix I9: the live balance_check body carries the current revision marker exactly - a future migration that recreates this function without bumping it fails here');

-- ============================================================================
-- M5: LIMIT NULL is unbounded in Postgres. Structural pin that p_limit is
-- clamped before it ever reaches a `limit` clause, plus the behavioral
-- sanity check that a null call does not error.
-- ============================================================================
select ok(
  current_setting('test.balchk_def') ~ 'greatest\(coalesce\(p_limit,\s*500\),\s*0\)',
  'p_limit is clamped via greatest(coalesce(p_limit, 500), 0) before reaching any limit clause - null cannot become unbounded');

select lives_ok(
  $$ select public.balance_check(null) $$,
  'balance_check(null) does not error - it degrades to the clamped default rather than an unbounded pass');

-- ------------------------------------------------------------ p_limit=0 edge case
select is(
  public.balance_check(0)::text,
  '0',
  'p_limit=0 checks nothing and returns 0 (no error)');

-- ============================================================================
-- ROTATION: genuine self-clearing under a TIGHT p_limit, proven by naming the
-- EXACT pair each call touches (deterministic consumer-id ordering - see file
-- header). Three fresh, never-checked pairs (C, D, E) are added AFTER the
-- runs above, so at this point A/B/F/G-biz1/G-biz2 already carry a real
-- checked_at and C/D/E carry none (null sorts first). This is the same shape
-- rpc_points_expiry_smoke.sql and rpc_campaigns_sweep_smoke.sql use for
-- their own I2/I1 self-clearing proofs: a p_limit=200/8-fixture "second run
-- is 0" cannot tell "rotated" from "stuck"; a p_limit=1 run that reaches a
-- LATER pair only once EARLIER ones have had their turn can.
-- ============================================================================
insert into public.business_customers (business_id, consumer_id, points_balance)
values
  (current_setting('test.biz')::uuid, 'f5555555-5555-4555-8555-555555555555', 100),
  (current_setting('test.biz')::uuid, 'f6666666-6666-4666-8666-666666666666', 100),
  (current_setting('test.biz')::uuid, 'f7777777-7777-4777-8777-777777777777', 100);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values
  (current_setting('test.biz')::uuid, 'f5555555-5555-4555-8555-555555555555', 'earn', 100, 100),
  (current_setting('test.biz')::uuid, 'f6666666-6666-4666-8666-666666666666', 'earn', 100, 100),
  (current_setting('test.biz')::uuid, 'f7777777-7777-4777-8777-777777777777', 'earn', 100, 100);

select is(public.balance_check(1)::text, '1', 'rotation call 1 processes exactly one pair');
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f5555555-5555-4555-8555-555555555555'),
  1, 'rotation call 1 touched pair C (f5..., the smallest never-checked consumer_id)');
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id in ('f6666666-6666-4666-8666-666666666666',
                           'f7777777-7777-4777-8777-777777777777')),
  0, 'rotation call 1 did NOT touch D or E - the whole budget went to one pair, not spread or repeated');

select is(public.balance_check(1)::text, '1', 'rotation call 2 processes exactly one pair');
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f6666666-6666-4666-8666-666666666666'),
  1, 'rotation call 2 touched pair D (f6...), NOT re-selecting C');

select is(public.balance_check(1)::text, '1', 'rotation call 3 processes exactly one pair');
select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f7777777-7777-4777-8777-777777777777'),
  1, 'rotation call 3 touched pair E (f7...), NOT re-selecting C or D');

select is(
  (select count(*)::int from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id in ('f5555555-5555-4555-8555-555555555555',
                           'f6666666-6666-4666-8666-666666666666',
                           'f7777777-7777-4777-8777-777777777777')),
  3, 'C, D and E all now have exactly one finding each - coverage genuinely advanced');

-- call 4/4: C/D/E are now the MOST recently checked pairs in the whole
-- table, so the cursor MUST rotate to something outside {C, D, E} next -
-- proving rotation cycles the WHOLE candidate set. Which specific older pair
-- it lands on is not asserted (a live, shared project - some other pre-
-- existing row could sort first); what matters, and is fully determined
-- regardless of what else is live, is that it is NOT one of the three
-- just-rotated pairs.
select is(public.balance_check(1)::text, '1', 'rotation call 4 processes exactly one pair');
select ok(
  not exists (
    select 1 from public.balance_check_findings f
     where f.checked_at = (select max(checked_at) from public.balance_check_findings)
       and f.business_id = current_setting('test.biz')::uuid
       and f.consumer_id in ('f5555555-5555-4555-8555-555555555555',
                              'f6666666-6666-4666-8666-666666666666',
                              'f7777777-7777-4777-8777-777777777777')
  ),
  'call 4''s freshest checked_at belongs to a pair OUTSIDE {C, D, E} - the cursor rotated back into the older candidate pool rather than re-selecting one of the trio it just finished');

-- ============================================================================
-- I3a/I5: the coverage-days tripwire primitive, now budget-corrected. By
-- this point in the script the live business_customers table holds at least
-- 9 candidate pairs (A, B, F, G-biz1, G-biz2, C, D, E, plus any unrelated
-- pre-existing live row).
-- ============================================================================
select set_config('test.bc_total_now', (select count(*)::text from public.business_customers), true);

select ok(
  private.balance_check_coverage_days(1) > 7,
  'private.balance_check_coverage_days(1) exceeds the 7-day bound given the live candidate count - the tripwire condition public.balance_check checks is genuinely true here');
select is(
  private.balance_check_coverage_days(1)::text,
  current_setting('test.bc_total_now'),
  'private.balance_check_coverage_days(1) equals the exact live pair count (ceil(n/1) = n) - p_limit=1 is already below the 200-slot reservation floor, so the I5 budget correction does not change this one');
select is(
  private.balance_check_coverage_days(200)::text,
  current_setting('test.bc_total_now'),
  'review fix I5: at p_limit=200 - exactly points.expiry_sweep''s own live cron limit - the effective rotation budget collapses to the floor of 1, so coverage_days equals the full pair count rather than the naive ceil(n/200); this is the discriminating case that proves the budget correction is real, not just present in the source');
select ok(
  private.balance_check_coverage_days(500) <= 7,
  'private.balance_check_coverage_days(500) stays within the 7-day bound at the documented default p_limit (effective budget 500-200=300), given today''s (tiny) pair count');

-- ============================================================================
-- I3b/I6: doc 39's "every pair touched by clawback/expire in the last 24h"
-- priority, and the tier-0 occupancy primitive that reports it. Pair A was
-- already checked in the first big run above, so under plain oldest-checked-
-- first it is nowhere near due; a brand-new never-checked pair (H) would
-- normally win any p_limit=1 race against it. A fresh clawback lands on A
-- AFTER that first check, simulating "a reversal happened tonight, after the
-- nightly check already ran" - A must now win priority over H anyway,
-- because a pair this job just watched a reversal touch is higher-risk than
-- one that has simply never been looked at.
--
-- created_at is stamped explicitly with clock_timestamp(), not left to the
-- column's own `default now()`: `now()` is transaction_timestamp(), frozen
-- for this whole pgTAP script (see 0056's header on exactly this trap), so
-- every points_transactions row this suite has inserted anywhere carries the
-- SAME created_at - always earlier, in real terms, than a checked_at already
-- recorded via clock_timestamp() by an earlier statement in this same
-- transaction. That is purely an artifact of testing everything inside one
-- rolled-back transaction: in production each writer runs in its OWN,
-- separate transaction, so `now()` there genuinely reflects that write's
-- real wall-clock moment. Stamping clock_timestamp() here reproduces that
-- real ordering for this one fixture without changing anything about how
-- award_receipt_points/clawback_receipt_points/etc. actually write the
-- column in production.
-- ============================================================================
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after, created_at)
values (current_setting('test.biz')::uuid, 'f2222222-2222-4222-8222-222222222222', 'clawback', -50, 450, clock_timestamp());
update public.business_customers
   set points_balance = 450
 where business_id = current_setting('test.biz')::uuid
   and consumer_id = 'f2222222-2222-4222-8222-222222222222';

insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333', 100);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values (current_setting('test.biz')::uuid, 'e3333333-3333-4333-8333-333333333333', 'earn', 100, 100);

select set_config('test.a_checked_before_priority',
  (select checked_at::text from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f2222222-2222-4222-8222-222222222222'), true);

-- I6: the primitive, called directly, BEFORE the run that resolves it -
-- exactly the one priority candidate (pair A) is visible to it right now.
select is(
  private.balance_check_priority_count(1)::text,
  '1',
  'review fix I6: private.balance_check_priority_count(1) correctly identifies pair A as the one priority candidate before the run that re-verifies it');

select is(public.balance_check(1)::text, '1', 'priority call processes exactly one pair');

select ok(
  (select checked_at from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f2222222-2222-4222-8222-222222222222')::text
  <> current_setting('test.a_checked_before_priority'),
  'pair A (fresh clawback, already checked once, would NOT be next under plain rotation) was re-verified by the priority call');
select is(
  (select cached_balance from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f2222222-2222-4222-8222-222222222222'),
  450, 'pair A''s re-verified cached_balance reflects the post-clawback value');
select is(
  (select ledger_sum from public.balance_check_findings
    where business_id = current_setting('test.biz')::uuid
      and consumer_id = 'f2222222-2222-4222-8222-222222222222'),
  450, 'pair A''s re-verified ledger_sum includes the fresh clawback (500 - 50)');
select ok(
  not exists (
    select 1 from public.balance_check_findings
     where business_id = current_setting('test.biz')::uuid
       and consumer_id = 'e3333333-3333-4333-8333-333333333333'
  ),
  'pair H (never checked, no clawback/expire activity) was NOT touched - priority genuinely outranked a never-checked pair, it was not a coincidence of ordinary rotation order');

-- I6, again: the primitive now reports 0 - pair A was just resolved and
-- nothing else in the priority tier remains, matching what the run above
-- actually did rather than a second, independent count.
select is(
  private.balance_check_priority_count(1)::text,
  '0',
  'review fix I6: private.balance_check_priority_count(1) is 0 immediately after the one priority pair was resolved');

-- ============================================================================
-- M2/I7: pair-level cleanup. A finding for a pair whose underlying
-- business_customers row is deleted (without the business or consumer
-- itself being deleted) must not survive as an unclearable stale row. As of
-- 0058 this is an AFTER DELETE trigger, not a foreign key (the composite FK
-- 0057 used took an implicit FOR KEY SHARE lock on business_customers that
-- conflicts with every money-path writer's FOR UPDATE - see 0058's header,
-- review fix I7); the observable outcome this assertion checks is identical
-- either way.
-- ============================================================================
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e4444444-4444-4444-8444-444444444444', 150);
insert into public.points_transactions (business_id, consumer_id, type, points, balance_after)
values (current_setting('test.biz')::uuid, 'e4444444-4444-4444-8444-444444444444', 'earn', 150, 150);

-- generous p_limit so this run also mops up pair H from the block above,
-- regardless of exact rotation order - this section only cares about K
select public.balance_check(100);

select ok(
  exists (
    select 1 from public.balance_check_findings
     where business_id = current_setting('test.biz')::uuid
       and consumer_id = 'e4444444-4444-4444-8444-444444444444'
  ),
  'pair K has a finding row before its business_customers row is removed');

delete from public.business_customers
 where business_id = current_setting('test.biz')::uuid
   and consumer_id = 'e4444444-4444-4444-8444-444444444444';

select ok(
  not exists (
    select 1 from public.balance_check_findings
     where business_id = current_setting('test.biz')::uuid
       and consumer_id = 'e4444444-4444-4444-8444-444444444444'
  ),
  'deleting the business_customers row cleans up balance_check_findings via the AFTER DELETE trigger - no stale, unclearable finding survives it (review fix M2, mechanism changed by I7)');

-- ============================================================================
-- C2 (Critical, 0059): the SAME cleanup, exercised as service_role
-- specifically - the role every internal application code path actually
-- runs as, and the ONE role for which the ORIGINAL (non-`security definer`)
-- trigger failed outright. Every assertion above ran as `postgres`
-- (privileged, bypasses every grant check), which is exactly why this suite
-- could not have caught the bug on its own: `postgres` owns `balance_check_
-- findings` and was never subject to its DELETE revoke in the first place.
-- Live-reproduced before this fix landed: as `service_role`, deleting a
-- `business_customers` row raised `permission denied for table balance_
-- check_findings` - the trigger's internal DELETE ran with the INVOKER's
-- (service_role's) privileges, which 0056 revokes, and the privilege check
-- fires against the RELATION regardless of whether that pair had a finding
-- at all. Pair M below never had a finding checked in by anyone - the
-- delete must still succeed cleanly.
-- ============================================================================
insert into public.business_customers (business_id, consumer_id, points_balance)
values (current_setting('test.biz')::uuid, 'e5555555-5555-4555-8555-555555555555', 175);

set local role service_role;
select lives_ok(
  $$ delete from public.business_customers
      where business_id = current_setting('test.biz')::uuid
        and consumer_id = 'e5555555-5555-4555-8555-555555555555' $$,
  'review fix C2: service_role can delete a business_customers row without error - the pair-cleanup trigger now runs SECURITY DEFINER, so its internal DELETE on balance_check_findings no longer hits service_role''s own revoke');
reset role;

select ok(
  not exists (
    select 1 from public.balance_check_findings
     where business_id = current_setting('test.biz')::uuid
       and consumer_id = 'e5555555-5555-4555-8555-555555555555'
  ),
  'pair M (never checked, no finding row ever existed) confirms the delete truly went through as service_role, not merely that no error surfaced');

-- ------------------------------------------------------------ the schedule
select is(
  (select schedule from cron.job where jobname = 'integrity.balance_check'),
  '40 18 * * *',
  'integrity.balance_check runs daily at 02:40 Manila (40 18 UTC) per doc 39''s sample slot');

select ok(
  (select active from cron.job where jobname = 'integrity.balance_check')
  and (select command from cron.job where jobname = 'integrity.balance_check')
      = 'select public.balance_check(500);',
  'integrity.balance_check is active and calls the function directly with the documented default');

select * from finish();

rollback;
