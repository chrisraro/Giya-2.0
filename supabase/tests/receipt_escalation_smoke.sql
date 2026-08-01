-- ============================================================================
-- receipt_escalation_smoke.sql (pgTAP)
-- Smoke tests for 0036: receipts.escalated_at and the escalation mechanism's
-- database-side contract.
--
-- WHAT IS WORTH ASSERTING HERE, AND WHAT IS NOT. The guards that decide whether
-- an escalation may happen at all - the submitter check, the cap, the excluded
-- fraud family, the once-per-receipt rule - are code, they live in
-- src/features/receipts/server/escalate.ts, and escalate.test.ts owns them.
-- Restating them here would be testing a fixture. What only the DATABASE can
-- answer is asserted instead:
--
--   * THE COLLISION IS REAL. `receipts_number_unique` (0017) covers
--     ('approved','review','processing') and excludes 'rejected', so moving a
--     rejected receipt back into 'review' collides with any live row already
--     claiming its number at that business. Test 7 raises the 23505 on purpose.
--     It is the single most important assertion in this file: it is the proof
--     that the pre-check and the 23505 catch in escalate.ts are load-bearing
--     rather than defensive decoration, and if a future migration relaxes that
--     index this test fails and says why.
--   * THE WRITE FENCE IS UNCHANGED. A consumer still cannot UPDATE receipts, so
--     the escalation cannot be performed client-side however the UI is edited.
--     0036 grants one column of SELECT and nothing else, and test 5 pins that.
--   * THE READ GRANT REACHES THE CONSUMER. The escalation is once per receipt
--     forever, so the consumer's own screen has to be able to see that it has
--     already happened, which needs both the column grant and
--     receipts_consumer_select. Test 6.
--   * THE ATTRIBUTION LANDS. 0035's breakdown must count an escalation as its
--     own reason rather than crediting whatever rejected the receipt first.
--     Tests 10 and 11.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0036 applied. pgTAP
-- lives in the extensions schema.
--
-- Fixture strategy per rpc_routing_breakdown_smoke.sql / rpc_award_smoke.sql:
-- insert into auth.users (the on_auth_user_created trigger creates profiles +
-- consumers), create the tenant via register_business under set-local-role
-- authenticated, then seed receipts as the privileged role, standing in for the
-- service-role pipeline. EVERY fixture id is captured from its own
-- "insert ... returning id" CTE and never looked up by name, by sha or by a
-- global select over the table, so live data can never be picked up instead of
-- the fixture's own rows.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(12);

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('e6111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-esc-owner@example.com', '{"full_name": "Escalation Owner"}'::jsonb),
  ('e6222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-esc-consumer@example.com', '{"full_name": "Escalation Consumer"}'::jsonb);

select set_config('request.jwt.claims',
  '{"sub": "e6111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.esc_biz',
  (select public.register_business('Escalation Cafe', 'cafe', 'cebu', '9 Appeal Street')::text),
  true);
reset role;

-- The live claimant. An APPROVED receipt holding receipt number OR-1000, which
-- is the state a consumer's honest resubmission ends in after their first scan
-- was rejected: 0017 excludes 'rejected' from receipts_number_unique precisely
-- so that resubmission is possible.
with inserted as (
  insert into public.receipts
    (business_id, user_id, status, receipt_number, image_path, image_hash, sha256)
  values
    (current_setting('test.esc_biz')::uuid, 'e6222222-2222-4222-8222-222222222222',
     'approved', 'OR-1000', 'e6222222-2222-4222-8222-222222222222/live.jpg',
     'e600000000000001', 'esc-live-sha-00000000000000000000000000000000')
  returning id
)
select set_config('test.esc_live', (select id::text from inserted), true);

-- The receipt whose number is already claimed. Rejected, so it coexists with
-- the row above quite legally today; escalating it is what creates the clash.
with inserted as (
  insert into public.receipts
    (business_id, user_id, status, reject_reason, receipt_number,
     image_path, image_hash, sha256, processed_at)
  values
    (current_setting('test.esc_biz')::uuid, 'e6222222-2222-4222-8222-222222222222',
     'rejected', 'unreadable', 'OR-1000',
     'e6222222-2222-4222-8222-222222222222/blocked.jpg',
     'e600000000000002', 'esc-blocked-sha-000000000000000000000000000000', now())
  returning id
)
select set_config('test.esc_blocked', (select id::text from inserted), true);

-- The ordinary case: rejected as unreadable, its number claimed by nobody.
with inserted as (
  insert into public.receipts
    (business_id, user_id, status, reject_reason, receipt_number,
     image_path, image_hash, sha256, processed_at, parse_meta)
  values
    (current_setting('test.esc_biz')::uuid, 'e6222222-2222-4222-8222-222222222222',
     'rejected', 'unreadable', 'OR-2000',
     'e6222222-2222-4222-8222-222222222222/free.jpg',
     'e600000000000003', 'esc-free-sha-00000000000000000000000000000000', now(),
     '{"review_reasons": ["parse_confidence_low"]}'::jsonb)
  returning id
)
select set_config('test.esc_free', (select id::text from inserted), true);

-- An escalation that is already open, so the cap predicate has something to
-- count and test 12 is not counting zero.
with inserted as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     escalated_at, parse_meta)
  values
    (current_setting('test.esc_biz')::uuid, 'e6222222-2222-4222-8222-222222222222',
     'review', 'e6222222-2222-4222-8222-222222222222/open.jpg',
     'e600000000000004', 'esc-open-sha-00000000000000000000000000000000',
     now(), '{"review_reasons": ["consumer_escalation"]}'::jsonb)
  returning id
)
select set_config('test.esc_open', (select id::text from inserted), true);

-- ------------------------------------------------------------ the column
-- 1-3. The column itself. Nullable is the contract, not an oversight: null
-- means "the pipeline put this here", which is every receipt in the queue
-- except the ones a customer pushed back on.
select has_column('public', 'receipts', 'escalated_at',
  'receipts.escalated_at exists');

select col_type_is('public', 'receipts', 'escalated_at', 'timestamp with time zone',
  'escalated_at is a timestamptz, so WHEN the customer pushed back is recoverable');

select col_is_null('public', 'receipts', 'escalated_at',
  'escalated_at is nullable: null is every receipt the pipeline routed itself');

-- 4. the partial index the per-consumer cap counts through
select has_index('public', 'receipts', 'receipts_open_escalation_idx',
  'the open-escalation index exists to serve the per-consumer cap');

-- ------------------------------------------------------------ the fences
-- 5. THE WRITE FENCE IS UNTOUCHED. 0017 revoked insert/update on receipts from
--    authenticated and gave no client audience a write policy, so a consumer
--    cannot set their own status however the client is edited. An escalation is
--    a consumer-initiated status change and it still has to go through the
--    server action and the service role. If this ever passes with a granted
--    UPDATE, a consumer can hand themselves status='review' on a receipt that
--    was rejected as fraudulent, which is doc 37's retry loop with the
--    database's blessing.
select is(
  (select count(*)::bigint
     from information_schema.column_privileges
    where table_schema = 'public'
      and table_name = 'receipts'
      and grantee = 'authenticated'
      and privilege_type = 'UPDATE'),
  0::bigint,
  'authenticated holds no UPDATE privilege on any receipts column, escalated_at included');

-- 6. and the READ grant does reach the submitter, which the once-per-receipt
--    rule depends on: after a merchant re-rejects an escalated receipt its
--    status and reason are indistinguishable from a first rejection, so
--    escalated_at is the only thing that stops the screen offering the button
--    a second time and letting the consumer be refused by the server.
select set_config('request.jwt.claims',
  '{"sub": "e6222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$select id, status, reject_reason, escalated_at from public.receipts
     where id = current_setting('test.esc_open')::uuid$$,
  'the submitting consumer can read escalated_at on their own receipt');

reset role;

-- ------------------------------------------------------------ the collision
-- 7. THE ASSERTION THIS FILE EXISTS FOR. receipts_number_unique covers
--    ('approved','review','processing') and excludes 'rejected'. Moving a
--    rejected receipt back into 'review' therefore collides with the live row
--    already claiming its number, and the database is right to refuse: two live
--    claims on one receipt number at one business is exactly what that index
--    prevents, and an escalation is not entitled to an exception. The honest
--    reading of the state is that the customer already resubmitted and the
--    newer scan is the live one.
--
--    escalate.ts checks for this BEFORE it writes and catches 23505 on the
--    write as well, so a consumer sees a sentence rather than a raw database
--    error. This test is what makes that code load-bearing rather than
--    defensive: relax the index and this fails.
select throws_ok(
  $$update public.receipts
       set status = 'review', escalated_at = now()
     where id = current_setting('test.esc_blocked')::uuid$$,
  '23505',
  null,
  'escalating a receipt whose number a live row already claims raises 23505 (receipts_number_unique)');

-- 8. while the ordinary case goes through cleanly: same statement, same
--    business, a receipt number nobody else is holding.
select lives_ok(
  $$update public.receipts
       set status = 'review',
           escalated_at = now(),
           processed_at = null,
           reviewed_by = null,
           reviewed_at = null,
           parse_meta = coalesce(parse_meta, '{}'::jsonb)
                        || jsonb_build_object('review_reasons',
                             '["parse_confidence_low","consumer_escalation"]'::jsonb)
     where id = current_setting('test.esc_free')::uuid$$,
  'escalating a receipt whose number is unclaimed moves it back to review');

-- 9. and it lands in the state the merchant queue reads: 'review', with the
--    original reject_reason KEPT. The reviewer is being asked "was our machine
--    wrong?", and the machine's verdict is the thing they are re-deciding, so
--    erasing it would take away the question. processed_at goes back to null
--    because the receipt has no terminal outcome again, which is also what
--    keeps 0018's "approved, award pending" marker meaningful if the merchant
--    approves and the award then fails.
select results_eq(
  $$select status, reject_reason, processed_at is null, escalated_at is not null
      from public.receipts where id = current_setting('test.esc_free')::uuid$$,
  $$values ('review'::text, 'unreadable'::text, true, true)$$,
  'an escalated receipt sits in review, keeps its reject_reason and clears processed_at');

-- ------------------------------------------------------------ attribution
-- 10-11. 0035. An escalation is a tenth reason a receipt is in the queue and it
-- names itself, so the review-rate breakdown does not silently credit whatever
-- rejected the receipt originally. Two receipts now carry the reason: the
-- fixture that was already open, and the one test 8 escalated - which also
-- still carries parse_confidence_low, because both statements are true about
-- why a human is looking at it.
select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.esc_biz')::uuid, 30)
    where kind = 'reason' and key = 'consumer_escalation'),
  2::bigint,
  'consumer_escalation is counted as its own routing reason');

select is(
  (select tally from public.receipt_routing_breakdown(current_setting('test.esc_biz')::uuid, 30)
    where kind = 'reason' and key = 'parse_confidence_low'),
  1::bigint,
  'the reason that rejected it originally is still counted, and is not inflated by the escalation');

-- ------------------------------------------------------------ the cap
-- 12. The predicate the per-consumer cap counts, which is the one the partial
--     index in 0036 covers: this consumer's receipts that are escalated AND
--     still waiting on a merchant. It counts OPEN escalations rather than
--     lifetime ones deliberately - every merchant decision frees a slot, so the
--     cap bounds concurrent unpaid human work without ever telling an honest
--     customer they have used up their appeals.
select is(
  (select count(*)::bigint from public.receipts
    where user_id = 'e6222222-2222-4222-8222-222222222222'
      and status = 'review'
      and escalated_at is not null),
  2::bigint,
  'the open-escalation count sees exactly the escalations still awaiting a merchant');

select * from finish();

rollback;
