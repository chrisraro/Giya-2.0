-- ============================================================================
-- rls_receipts_smoke.sql (pgTAP)
-- Smoke tests for the 0017 receipts domain: the receipts client-write fence,
-- the column-level read fence on receipts, consumer/staff read isolation across
-- receipts, receipt_line_items, ocr_results, fraud_signals, ai_usage_events,
-- receipt_templates and settings, the owner/manager role narrowing (marketing
-- and counter staff are denied everywhere in this domain), the three unique
-- amendments, the evidence delete/immutability triggers, the privilege fence on
-- all seven tables for anon / authenticated / service_role, and the
-- points_transactions.receipt_id foreign key closed by 0017. Runs entirely
-- inside one transaction and rolls back. Execute as a privileged role
-- (postgres) against a database with migrations 0001-0017 applied. pgTAP lives
-- in the extensions schema.
--
-- Fixture strategy: mirror rpc_claim_smoke.sql. Insert directly into auth.users
-- (the on_auth_user_created trigger creates profiles + consumers), create two
-- tenants via register_business under set-local-role authenticated capturing
-- the returned business id, add marketing/staff members to tenant 1 for the
-- role matrix, then seed receipts and their evidence rows as the privileged
-- role (which stands in for the service-role pipeline, the only writer of these
-- tables).
--
-- HARD RULE, learned the hard way: every fixture id is captured off its own
-- "insert ... returning" CTE. Nothing is ever looked up by name or by any other
-- global predicate over a whole table - this database also holds live E2E data,
-- and a live row sharing a fixture's name or receipt number would silently be
-- picked up instead of the fixture's own row. Every count assertion below is
-- likewise scoped by a fixture id, never left as a bare count over a table.
--
-- Note on the privilege-fence block: each assertion aggregates the privileges a
-- role actually still holds into a sorted string, so a failure names the exact
-- privilege that leaked instead of just reporting false.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(74);

-- ---------------------------------------------------------------- fixtures
-- Six fixed test users: two business owners, two consumers, and the marketing
-- and counter-staff members of tenant 1 that the role narrowing turns on.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('b1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-receipts-owner1@example.com', '{"full_name": "Receipts Owner One"}'::jsonb),
  ('b2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-receipts-owner2@example.com', '{"full_name": "Receipts Owner Two"}'::jsonb),
  ('b3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-receipts-consumer1@example.com', '{"full_name": "Scanning Consumer"}'::jsonb),
  ('b4444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
   'giya-receipts-consumer2@example.com', '{"full_name": "Other Consumer"}'::jsonb),
  ('b5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-receipts-marketing@example.com', '{"full_name": "Marketing Member"}'::jsonb),
  ('b6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-receipts-staff@example.com', '{"full_name": "Counter Staff"}'::jsonb);

-- owner1 registers tenant 1; register_business returns the new business uuid
-- (0003), so the id is captured straight from the call, never looked up.
select set_config('request.jwt.claims',
  '{"sub": "b1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz1',
  (select public.register_business('Receipt Cafe', 'cafe', 'cebu', '1 Scan Street')::text),
  true);
reset role;

-- owner2 registers tenant 2 (the cross-tenant probe)
select set_config('request.jwt.claims',
  '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz2',
  (select public.register_business('Receipt Rival', 'restaurant', 'manila', '2 Other Ave')::text),
  true);
reset role;

-- role-matrix members of tenant 1 (privileged fixture: staff membership writes
-- are service-role only until the staff module ships). doc 01's receipt rows
-- give marketing and staff no receipt permission at all, and every policy in
-- 0017 narrows to owner/manager on the strength of that; these two members are
-- what turns that narrowing into something testable.
insert into public.business_staff (business_id, user_id, role, status)
values
  (current_setting('test.biz1')::uuid,
   'b5555555-5555-4555-8555-555555555555', 'marketing', 'active'),
  (current_setting('test.biz1')::uuid,
   'b6666666-6666-4666-8666-666666666666', 'staff', 'active');

-- receipts, seeded as the privileged role (stands in for the service-role
-- submit + pipeline path, the ONLY writer of this table). One insert, one
-- returning CTE; every set_config below matches on sha256 against "ins" only,
-- i.e. against the three rows this very statement just inserted.
--   rc1 - consumer1 @ biz1, approved, number R-001 (the live-number probe)
--   rc2 - consumer2 @ biz2, approved (the cross-consumer / cross-tenant probe)
--   rc3 - consumer1 @ biz1, rejected, number R-900 (the resubmission probe and,
--         having no ledger row, the receipt the RESTRICT foreign key can never
--         see - the delete case 0017's trigger exists for)
with ins as (
  insert into public.receipts
    (business_id, user_id, status, image_path, image_hash, sha256,
     receipt_number, receipt_date, total_centavos, reject_reason, reject_note,
     parse_meta, parse_confidence, match_confidence)
  values
    (current_setting('test.biz1')::uuid, 'b3333333-3333-4333-8333-333333333333',
     'approved', 'b3333333-3333-4333-8333-333333333333/rc1.jpg',
     'ffeeddccbbaa9988', 'sha-fixture-rc1', 'R-001', now() - interval '1 day', 124500,
     null, null, '{"total": {"tier": "template", "conf": 0.97}}'::jsonb, 0.910, 0.960),
    (current_setting('test.biz2')::uuid, 'b4444444-4444-4444-8444-444444444444',
     'approved', 'b4444444-4444-4444-8444-444444444444/rc2.jpg',
     '1122334455667788', 'sha-fixture-rc2', 'R-777', now() - interval '1 day', 50000,
     null, null, '{"total": {"tier": "heuristic", "conf": 0.71}}'::jsonb, 0.800, 0.880),
    (current_setting('test.biz1')::uuid, 'b3333333-3333-4333-8333-333333333333',
     'rejected', 'b3333333-3333-4333-8333-333333333333/rc3.jpg',
     'aabbccddeeff0011', 'sha-fixture-rc3', 'R-900', now() - interval '2 days', 33300,
     'fraud_suspected', 'matched the image submitted by giya-receipts-consumer2',
     '{"total": {"tier": "llm", "conf": 0.42}}'::jsonb, 0.410, 0.520)
  returning id, sha256
)
select
  set_config('test.rc1', (select id::text from ins where sha256 = 'sha-fixture-rc1'), true),
  set_config('test.rc2', (select id::text from ins where sha256 = 'sha-fixture-rc2'), true),
  set_config('test.rc3', (select id::text from ins where sha256 = 'sha-fixture-rc3'), true);

-- evidence rows for rc1 and rc2: one fraud signal, one OCR attempt, one line
-- item each. Written privileged, exactly as the pipeline would.
insert into public.fraud_signals
  (business_id, receipt_id, consumer_id, signal, severity, score, evidence)
values
  (current_setting('test.biz1')::uuid, current_setting('test.rc1')::uuid,
   'b3333333-3333-4333-8333-333333333333', 'velocity', 'warn', 0.500,
   '{"window": "pair_10min", "count": 3, "cap": 2}'::jsonb),
  (current_setting('test.biz2')::uuid, current_setting('test.rc2')::uuid,
   'b4444444-4444-4444-8444-444444444444', 'amount_anomaly', 'info', 0.200,
   '{"pattern": "round_numbers", "streak": 6}'::jsonb);

insert into public.ocr_results
  (receipt_id, attempt, engine, engine_version, raw_text, mean_confidence, duration_ms)
values
  (current_setting('test.rc1')::uuid, 1, 'stub', '0.0.1',
   'RECEIPT CAFE / TOTAL 1245.00', 0.910, 42),
  (current_setting('test.rc2')::uuid, 1, 'stub', '0.0.1',
   'RIVAL / TOTAL 500.00', 0.880, 39);

insert into public.receipt_line_items
  (business_id, receipt_id, raw_text, qty, unit_price_centavos, line_total_centavos, sort)
values
  (current_setting('test.biz1')::uuid, current_setting('test.rc1')::uuid,
   'MANGO SHAKE 1 124500', 1, 124500, 124500, 0),
  (current_setting('test.biz2')::uuid, current_setting('test.rc2')::uuid,
   'RIVAL BREW 1 50000', 1, 50000, 50000, 0);

-- one metered OCR call per tenant, so "owner sees their own spend" and
-- "marketing/staff see nothing" are both counted against real rows
insert into public.ai_usage_events (business_id, kind, model, units, cost_micros, ref_id)
values
  (current_setting('test.biz1')::uuid, 'ocr', 'paddleocr', 1, 1200,
   current_setting('test.rc1')::uuid),
  (current_setting('test.biz2')::uuid, 'ocr', 'paddleocr', 1, 1100,
   current_setting('test.rc2')::uuid);

-- one template for tenant 1, id captured off its own returning CTE
with ins as (
  insert into public.receipt_templates (business_id, name, source_kind, sample_path)
  values (current_setting('test.biz1')::uuid, 'Seeded POS', 'pos',
          'invoice-templates/seeded.jpg')
  returning id
)
select set_config('test.tpl1', (select id::text from ins), true);

-- a business-scope settings override for tenant 1 (doc 36 allows business
-- override of receipts.max_age_days)
insert into public.settings (scope, business_id, key, value)
values ('business', current_setting('test.biz1')::uuid, 'receipts.max_age_days', '7'::jsonb);

-- ---------------------------------------------------------------- consumer view
select set_config('request.jwt.claims',
  '{"sub": "b3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

-- 1. the write fence: a consumer cannot insert a receipt for themselves. With
--    no client insert policy AND the 0017 privilege revoke, this is a hard
--    42501 rather than a silent zero-row result.
select throws_ok(
  $$insert into public.receipts (business_id, user_id, image_path, image_hash, sha256)
    values (current_setting('test.biz1')::uuid,
            'b3333333-3333-4333-8333-333333333333',
            'b3333333-3333-4333-8333-333333333333/forged.jpg', 'deadbeefdeadbeef',
            'sha-forged-by-consumer')$$,
  '42501',
  null,
  'consumer insert into receipts is blocked (service-role write fence)');

-- 2. and cannot update their OWN receipt: self-approval with an invented total
--    is exactly what the fence exists to stop
select throws_ok(
  $$update public.receipts
       set status = 'approved', total_centavos = 9999900
     where id = current_setting('test.rc1')::uuid$$,
  '42501',
  null,
  'consumer update of own receipt is blocked (service-role write fence)');

-- 3. consumer1 sees exactly their own two receipts (P3 consumer select). The
--    predicate is pinned to consumer1's own user_id rather than left as a bare
--    count over the table, so live E2E receipts cannot inflate it.
select is(
  (select count(*)::int from public.receipts
    where user_id = 'b3333333-3333-4333-8333-333333333333'),
  2,
  'consumer sees only own receipts (P3 consumer select, 2 fixture rows)');

-- 4. and specifically not the other consumer's receipt
select is(
  (select count(*)::int from public.receipts
    where id = current_setting('test.rc2')::uuid),
  0,
  'consumer cannot see another consumer receipt (P3 cross-consumer deny)');

-- 5. fraud internals are never consumer-readable (doc 33 / doc 37): not even
--    the signals on the consumer's own receipt
select is(
  (select count(*)::int from public.fraud_signals
    where receipt_id = current_setting('test.rc1')::uuid),
  0,
  'consumer cannot read fraud_signals on own receipt (no consumer policy)');

-- 6. raw OCR evidence is staff-only for the same reason
select is(
  (select count(*)::int from public.ocr_results
    where receipt_id = current_setting('test.rc1')::uuid),
  0,
  'consumer cannot read ocr_results on own receipt (no consumer policy)');

-- 7. line items of the consumer's own receipt ARE readable (parent EXISTS)
select is(
  (select count(*)::int from public.receipt_line_items
    where receipt_id = current_setting('test.rc1')::uuid),
  1,
  'consumer reads line items of own receipt via the parent receipt');

-- 8. but not another consumer's
select is(
  (select count(*)::int from public.receipt_line_items
    where receipt_id = current_setting('test.rc2')::uuid),
  0,
  'consumer cannot read another consumer line items (parent EXISTS denies)');

-- 9. the platform settings scope is the fraud rulebook (velocity caps, the
--    pHash block distance, the composite review threshold, the cooldown ladder)
--    and 0017 gives it NO client select policy at all. A consumer who could
--    read this row would know the exact score to stay under.
select is(
  (select count(*)::int from public.settings
    where scope = 'platform' and key = 'fraud.review_threshold'),
  0,
  'consumer cannot read a platform-scope settings row (no client policy: fraud rulebook)');

-- 10. business-scope settings are not readable either (P1: owner/manager of
--     that business only)
select is(
  (select count(*)::int from public.settings
    where scope = 'business' and business_id = current_setting('test.biz1')::uuid),
  0,
  'consumer cannot read a business-scope settings row (P1 owner/manager only)');

-- 11. billing data is staff-only
select is(
  (select count(*)::int from public.ai_usage_events
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'consumer cannot read ai_usage_events (no consumer policy)');

-- 12. the column fence: reject_note is free-text reviewer commentary that can
--     name the matched receipt or another consumer, and rc3 carries exactly
--     such a note. The row is the consumer's own; the column still raises.
select throws_ok(
  $$select reject_note from public.receipts
     where id = current_setting('test.rc3')::uuid$$,
  '42501',
  null,
  'consumer cannot select receipts.reject_note even on own row (column grant fence)');

-- 13. parse_meta is per-field extraction provenance - which fields came from a
--     template, a heuristic or the LLM tier, with per-field confidence. That is
--     a gradient a forger iterates a fake against, so it is off the allowlist.
select throws_ok(
  $$select parse_meta from public.receipts
     where id = current_setting('test.rc1')::uuid$$,
  '42501',
  null,
  'consumer cannot select receipts.parse_meta even on own row (column grant fence)');

-- 14. while the whole /scan status + wallet history allowlist reads cleanly
select lives_ok(
  $$select id, user_id, business_id, status, reject_reason,
           merchant_name, receipt_number, receipt_date, total_centavos,
           image_path, source, created_at, processed_at
      from public.receipts
     where user_id = 'b3333333-3333-4333-8333-333333333333'$$,
  'consumer reads every allowlisted receipts column (status screen + history list)');

reset role;

-- ---------------------------------------------------------------- staff view
select set_config('request.jwt.claims',
  '{"sub": "b1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 15. owner of tenant 1 sees their tenant's receipts in every status
select is(
  (select count(*)::int from public.receipts
    where business_id = current_setting('test.biz1')::uuid),
  2,
  'owner sees own-tenant receipts in any status (P3 staff select)');

-- 16. and none of tenant 2's
select is(
  (select count(*)::int from public.receipts
    where business_id = current_setting('test.biz2')::uuid),
  0,
  'staff of tenant 1 cannot see tenant 2 receipts (P3 cross-tenant deny)');

-- 17. own-tenant fraud signals ARE readable (doc 37 business review queue)
select is(
  (select count(*)::int from public.fraud_signals
    where receipt_id = current_setting('test.rc1')::uuid),
  1,
  'owner reads own-tenant fraud_signals (P3 staff half, review queue)');

-- 18. cross-tenant fraud signals are not
select is(
  (select count(*)::int from public.fraud_signals
    where receipt_id = current_setting('test.rc2')::uuid),
  0,
  'owner cannot read another tenant fraud_signals (cross-tenant deny)');

-- 19. own-tenant OCR evidence is readable through the parent receipt
select is(
  (select count(*)::int from public.ocr_results
    where receipt_id = current_setting('test.rc1')::uuid),
  1,
  'owner reads own-tenant ocr_results via the parent receipt');

-- 20. cross-tenant OCR evidence is not
select is(
  (select count(*)::int from public.ocr_results
    where receipt_id = current_setting('test.rc2')::uuid),
  0,
  'owner cannot read another tenant ocr_results (parent EXISTS denies)');

-- 21. own business-scope settings row is readable
select is(
  (select count(*)::int from public.settings
    where scope = 'business' and business_id = current_setting('test.biz1')::uuid),
  1,
  'owner reads own business-scope settings row (P1)');

-- 22. but the platform scope stays closed to the owner too: there is no client
--     policy on it for ANY audience, only the service role
select is(
  (select count(*)::int from public.settings
    where scope = 'platform' and key = 'fraud.review_threshold'),
  0,
  'owner cannot read a platform-scope settings row either (service-role only)');

-- 23. own-tenant AI/OCR spend is readable (P1 read half)
select is(
  (select count(*)::int from public.ai_usage_events
    where business_id = current_setting('test.biz1')::uuid),
  1,
  'owner reads own-tenant ai_usage_events (P1 billing read)');

-- 24. own-tenant templates are readable
select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  1,
  'owner reads own-tenant receipt_templates (P1 select)');

-- 25. the documented cost of the column allowlist: column privileges are
--     ROLE-wide, not policy-wide, and staff share the "authenticated" role with
--     consumers, so the review UI does NOT get parse_meta from this grant. It
--     reads through the service role in the next slice. Asserted so a later
--     widening of the grant cannot happen silently.
select throws_ok(
  $$select parse_meta from public.receipts
     where business_id = current_setting('test.biz1')::uuid$$,
  '42501',
  null,
  'owner cannot select receipts.parse_meta either (column grants are role-wide)');

-- 26. P1 write: owner creates a receipt template in own tenant
select lives_ok(
  $$insert into public.receipt_templates (business_id, name, source_kind, sample_path)
    values (current_setting('test.biz1')::uuid, 'Main branch POS', 'pos',
            'invoice-templates/main.jpg')$$,
  'owner inserts a receipt_template into own tenant (P1 insert)');

reset role;

-- ---------------------------------------------------------------- cross-tenant staff
select set_config('request.jwt.claims',
  '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

-- 27. tenant-2 owner cannot plant a template in tenant 1
select throws_ok(
  $$insert into public.receipt_templates (business_id, name, source_kind, sample_path)
    values (current_setting('test.biz1')::uuid, 'Hijack Template', 'pos',
            'invoice-templates/hijack.jpg')$$,
  '42501',
  null,
  'cross-tenant receipt_template insert is blocked (P1 with check)');

-- 28. nor read tenant 1's templates (parse_config is anti-fraud configuration)
select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'cross-tenant owner cannot read tenant 1 receipt_templates (P1 select)');

-- 29. nor tenant 1's AI spend
select is(
  (select count(*)::int from public.ai_usage_events
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'cross-tenant owner cannot read tenant 1 ai_usage_events (P1 select)');

reset role;

-- ---------------------------------------------------------------- role narrowing: marketing
-- doc 01's receipt rows give marketing no receipt permission at all ("Manage
-- receipt templates" and "Review flagged receipts" are both owner/manager), and
-- every 0017 policy narrows to array['owner','manager'] on that basis. These
-- are active members of tenant 1, so only the role list denies them.
select set_config('request.jwt.claims',
  '{"sub": "b5555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
set local role authenticated;

-- 30. receipts carry submitted GPS and device linkage
select is(
  (select count(*)::int from public.receipts
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'marketing member of the tenant cannot read receipts (owner/manager narrowing)');

-- 31. fraud internals
select is(
  (select count(*)::int from public.fraud_signals
    where receipt_id = current_setting('test.rc1')::uuid),
  0,
  'marketing member cannot read fraud_signals (owner/manager narrowing)');

-- 32. raw OCR evidence
select is(
  (select count(*)::int from public.ocr_results
    where receipt_id = current_setting('test.rc1')::uuid),
  0,
  'marketing member cannot read ocr_results (owner/manager narrowing)');

-- 33. billing data
select is(
  (select count(*)::int from public.ai_usage_events
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'marketing member cannot read ai_usage_events (owner/manager narrowing)');

-- 34. parse_config (merchant aliases, TIN, receipt-number regexes)
select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'marketing member cannot read receipt_templates (owner/manager narrowing)');

-- 35. and cannot create one either
select throws_ok(
  $$insert into public.receipt_templates (business_id, name, source_kind, sample_path)
    values (current_setting('test.biz1')::uuid, 'Marketing Template', 'pos',
            'invoice-templates/mkt.jpg')$$,
  '42501',
  null,
  'marketing member cannot insert a receipt_template (P1 with check narrowing)');

reset role;

-- ---------------------------------------------------------------- role narrowing: staff
select set_config('request.jwt.claims',
  '{"sub": "b6666666-6666-4666-8666-666666666666", "role": "authenticated"}', true);
set local role authenticated;

-- 36-40. counter staff may validate redemptions (0013) but have no receipt
--        permission anywhere in doc 01's matrix
select is(
  (select count(*)::int from public.receipts
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'counter staff member cannot read receipts (owner/manager narrowing)');

select is(
  (select count(*)::int from public.fraud_signals
    where receipt_id = current_setting('test.rc1')::uuid),
  0,
  'counter staff member cannot read fraud_signals (owner/manager narrowing)');

select is(
  (select count(*)::int from public.ocr_results
    where receipt_id = current_setting('test.rc1')::uuid),
  0,
  'counter staff member cannot read ocr_results (owner/manager narrowing)');

select is(
  (select count(*)::int from public.ai_usage_events
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'counter staff member cannot read ai_usage_events (owner/manager narrowing)');

select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'counter staff member cannot read receipt_templates (owner/manager narrowing)');

-- 41. and cannot create one
select throws_ok(
  $$insert into public.receipt_templates (business_id, name, source_kind, sample_path)
    values (current_setting('test.biz1')::uuid, 'Staff Template', 'pos',
            'invoice-templates/staff.jpg')$$,
  '42501',
  null,
  'counter staff member cannot insert a receipt_template (P1 with check narrowing)');

reset role;

-- ---------------------------------------------------------------- unique amendments
-- 42. receipts_sha_unique: a byte-identical resubmission is rejected even for
--     the privileged writer. receipt_number is null here so sha256 is the only
--     constraint in play.
select throws_ok(
  $$insert into public.receipts
      (business_id, user_id, status, image_path, image_hash, sha256)
    values (current_setting('test.biz1')::uuid,
            'b3333333-3333-4333-8333-333333333333', 'queued',
            'b3333333-3333-4333-8333-333333333333/again.jpg',
            'ffeeddccbbaa9988', 'sha-fixture-rc1')$$,
  '23505',
  null,
  'receipts_sha_unique rejects a byte-identical second submission');

-- 43. receipts_number_unique: rc1 is approved with number R-001 at biz1, so a
--     second LIVE row (status review) claiming the same number is blocked
select throws_ok(
  $$insert into public.receipts
      (business_id, user_id, status, image_path, image_hash, sha256, receipt_number)
    values (current_setting('test.biz1')::uuid,
            'b4444444-4444-4444-8444-444444444444', 'review',
            'b4444444-4444-4444-8444-444444444444/dup.jpg',
            '0011223344556677', 'sha-fixture-dupnum', 'R-001')$$,
  '23505',
  null,
  'receipts_number_unique blocks a second LIVE claim of one receipt number');

-- 44. and it is receipts_number_unique specifically that fired, not some other
--     unique index on the table (sha256 and the primary key are both distinct
--     in the row above, but pinning the index is what stops this assertion
--     passing for the wrong reason if the partial predicate is ever broken)
select throws_like(
  $$insert into public.receipts
      (business_id, user_id, status, image_path, image_hash, sha256, receipt_number)
    values (current_setting('test.biz1')::uuid,
            'b4444444-4444-4444-8444-444444444444', 'review',
            'b4444444-4444-4444-8444-444444444444/dup.jpg',
            '0011223344556677', 'sha-fixture-dupnum', 'R-001')$$,
  '%receipts_number_unique%',
  'the 23505 above came from receipts_number_unique specifically');

-- 45. but rc3 is REJECTED with number R-900, and rejected rows are excluded
--     from the partial index, so honest resubmission of that number works
select lives_ok(
  $$insert into public.receipts
      (business_id, user_id, status, image_path, image_hash, sha256, receipt_number)
    values (current_setting('test.biz1')::uuid,
            'b3333333-3333-4333-8333-333333333333', 'approved',
            'b3333333-3333-4333-8333-333333333333/rc3-again.jpg',
            'aabbccddeeff0012', 'sha-fixture-rc3b', 'R-900')$$,
  'receipts_number_unique allows reuse of a number whose prior row is rejected');

-- 46. settings_platform_key_uniq: doc 25's unique (scope, business_id, key)
--     cannot deduplicate the platform scope, because business_id is null there
--     and nulls are distinct inside a unique constraint. The partial index is
--     what makes the 0017 seed's "on conflict do nothing" genuinely idempotent,
--     and fraud.review_threshold is a seeded platform key.
select throws_ok(
  $$insert into public.settings (scope, key, value)
    values ('platform', 'fraud.review_threshold', '0.9'::jsonb)$$,
  '23505',
  null,
  'a second platform row for one key is rejected (seed idempotency)');

-- 47. pinned to the partial index, since the doc's own constraint would have
--     let this row through
select throws_like(
  $$insert into public.settings (scope, key, value)
    values ('platform', 'fraud.review_threshold', '0.9'::jsonb)$$,
  '%settings_platform_key_uniq%',
  'the 23505 above came from settings_platform_key_uniq specifically');

-- 48. ocr_results_receipt_idx is UNIQUE: the table's contract is one row per
--     processing attempt, so a worker that crashes after inserting and retries
--     the same attempt collides instead of double-writing the evidence history
select throws_ok(
  $$insert into public.ocr_results
      (receipt_id, attempt, engine, engine_version, raw_text)
    values (current_setting('test.rc1')::uuid, 1, 'stub', '0.0.1', 'REPLAY')$$,
  '23505',
  null,
  'ocr_results (receipt_id, attempt) is unique: one row per processing attempt');

-- ---------------------------------------------------------------- deferred FK closed
-- 49. points_transactions.receipt_id is now a real foreign key: an id that
--     matches no receipt is refused
select throws_ok(
  $$insert into public.points_transactions
      (business_id, consumer_id, type, points, balance_after, receipt_id)
    values (current_setting('test.biz1')::uuid,
            'b3333333-3333-4333-8333-333333333333', 'earn', 12, 12,
            '00000000-0000-4000-8000-000000000000'::uuid)$$,
  '23503',
  null,
  'ledger row with an unknown receipt_id raises foreign_key_violation (0017 closed the deferred FK)');

-- 50. while a real receipt id is accepted. This row is also what gives rc1 a
--     ledger row for the delete assertions below.
select lives_ok(
  $$insert into public.points_transactions
      (business_id, consumer_id, type, points, balance_after, receipt_id)
    values (current_setting('test.biz1')::uuid,
            'b3333333-3333-4333-8333-333333333333', 'earn', 12, 12,
            current_setting('test.rc1')::uuid)$$,
  'ledger row referencing a real receipt is accepted');

-- ---------------------------------------------------------------- evidence fences
-- These run as the privileged role, which is the point: the revokes strip
-- delete/truncate from anon, authenticated AND service_role, so the triggers
-- are the layer that catches whoever still holds the privilege (the table
-- owner, any future misgrant). Nothing below can be reached by a client role.

-- 51. THE case the RESTRICT foreign key can never see. rc3 is rejected and has
--     no ledger row, so before this trigger it was freely deletable - and doc
--     37's cooldown ladder counts fraud-family rejections from exactly these
--     rows, so deleting them resets a repeat abuser's strike counter to zero.
select throws_ok(
  $$delete from public.receipts where id = current_setting('test.rc3')::uuid$$,
  'P0001',
  null,
  'a REJECTED receipt (no ledger row) cannot be deleted (fraud strike history)');

-- 52. and an awarded receipt is refused by the same trigger, before the
--     RESTRICT foreign key on points_transactions.receipt_id is ever consulted
select throws_ok(
  $$delete from public.receipts where id = current_setting('test.rc1')::uuid$$,
  'P0001',
  null,
  'an AWARDED receipt (with a ledger row) cannot be deleted either');

-- 53. ocr_results is immutable evidence: the raw text is what a review would be
--     re-litigated against, so no role edits an existing attempt
select throws_ok(
  $$update public.ocr_results set raw_text = 'TAMPERED'
     where receipt_id = current_setting('test.rc1')::uuid$$,
  'P0001',
  null,
  'ocr_results rows cannot be updated (immutable evidence trigger)');

-- 54. fraud_signals likewise: this table IS the strike history, so a role that
--     could delete rows here could retroactively clear an abuser's record
select throws_ok(
  $$delete from public.fraud_signals
     where receipt_id = current_setting('test.rc1')::uuid$$,
  'P0001',
  null,
  'fraud_signals rows cannot be deleted (immutable evidence trigger)');

-- 55. and the row triggers above do NOT fire on TRUNCATE, so the statement-level
--     trigger is the guard for the bulk wipe. ocr_results is the table used
--     here because nothing references it: a truncate of public.receipts is
--     refused earlier by the foreign keys pointing at it (0A000), which would
--     mask the trigger, so the receipts truncate fence is asserted at the
--     privilege layer instead (below).
select throws_ok(
  $$truncate public.ocr_results$$,
  'P0001',
  null,
  'ocr_results cannot be truncated (statement-level evidence trigger)');

-- ---------------------------------------------------------------- privilege fence
-- RLS gates row DML only. It never sees TRUNCATE and it never applies to
-- service_role, so the privilege layer is the only fence for both. Each
-- assertion aggregates what the role still holds, so a failure names the
-- leaked privilege instead of just reporting false. doc 12 requires the anon
-- row of the matrix to be stated explicitly, not inferred from "no policy".

-- 56/57. settings: no client writes at all. A tenant that could edit
--        fraud.review_threshold could switch fraud detection off for itself.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.settings', p)),
  null::text,
  'anon holds no write privilege on settings');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.settings', p)),
  null::text,
  'authenticated holds no write privilege on settings');

-- 58/59. receipt_templates is the one table in this file with a client write
--        path, so authenticated keeps exactly INSERT and UPDATE (the three P1
--        policies) and nothing else. Delete is soft (deleted_at); truncate
--        would have erased every tenant's parse configuration in one statement.
--        anon is not an audience at any layer and keeps nothing.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.receipt_templates', p)),
  null::text,
  'anon holds no write privilege on receipt_templates');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.receipt_templates', p)),
  'INSERT,UPDATE',
  'authenticated keeps exactly INSERT+UPDATE on receipt_templates (no delete, no truncate)');

-- 60/61. receipts: every write is service-role
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.receipts', p)),
  null::text,
  'anon holds no write privilege on receipts');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.receipts', p)),
  null::text,
  'authenticated holds no write privilege on receipts');

-- 62/63. receipt_line_items: parser output, written by the pipeline
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.receipt_line_items', p)),
  null::text,
  'anon holds no write privilege on receipt_line_items');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.receipt_line_items', p)),
  null::text,
  'authenticated holds no write privilege on receipt_line_items');

-- 64/65. ocr_results
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.ocr_results', p)),
  null::text,
  'anon holds no write privilege on ocr_results');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.ocr_results', p)),
  null::text,
  'authenticated holds no write privilege on ocr_results');

-- 66/67. fraud_signals
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.fraud_signals', p)),
  null::text,
  'anon holds no write privilege on fraud_signals');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.fraud_signals', p)),
  null::text,
  'authenticated holds no write privilege on fraud_signals');

-- 68/69. ai_usage_events: a client-writable meter is a client-editable bill,
--        and a client-truncatable meter is a deleted one
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.ai_usage_events', p)),
  null::text,
  'anon holds no write privilege on ai_usage_events');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.ai_usage_events', p)),
  null::text,
  'authenticated holds no write privilege on ai_usage_events');

-- 70. the column fence at the privilege layer: the table-level SELECT grant is
--     gone, so anon (which gets no column allowlist at all) can read nothing,
--     and "select *" as authenticated raises rather than returning parse_meta.
select ok(
  not has_table_privilege('anon', 'public.receipts', 'SELECT'),
  'anon holds no SELECT privilege on receipts (table grant revoked, no column allowlist)');

-- 71-73. the fences that reach service_role. RLS never applies to it, so these
--        revokes are the only thing between the pipeline's own role and the
--        evidence it just wrote.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.receipts', p)),
  null::text,
  'service_role cannot delete or truncate receipts (insert/update stay: the pipeline writes them)');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.ocr_results', p)),
  null::text,
  'service_role cannot update, delete or truncate ocr_results (immutable evidence)');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.fraud_signals', p)),
  null::text,
  'service_role cannot update, delete or truncate fraud_signals (strike history)');

-- 74. receipt_line_items is the deliberate exception: line items are DERIVED
--     data, not evidence, so a reprocess must be able to replace the previous
--     split and service_role keeps insert/update/delete. It does NOT keep
--     truncate - a reprocess deletes the rows of ONE receipt, never every
--     tenant's line items at once.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('service_role', 'public.receipt_line_items', p)),
  'DELETE,INSERT,UPDATE',
  'service_role keeps insert/update/delete on receipt_line_items (derived data) but not truncate');

select * from finish();

rollback;
