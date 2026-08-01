-- ============================================================================
-- rls_merchant_aliases_smoke.sql (pgTAP)
--
-- Smoke tests for 0034_business_merchant_aliases: the table and its columns,
-- the generated normalization (which MUST agree character for character with
-- `normalizeForMatch` in src/features/receipts/matching.ts, or an alias a
-- merchant taught will never be found by the matcher that reads it), the
-- unique index that makes the review queue's one-tap idempotent and race-free,
-- the owner/manager narrowing, the cross-tenant deny, the FK cascade and
-- set-null semantics, and the three-layer privilege fence including the
-- service-role-only write posture.
--
-- Also pins the ONE structural fact this whole feature rests on: an alias can
-- exist for a business that has NO receipt_templates row at all. That is why
-- the aliases moved off `receipt_templates.parse_config` - the template
-- management UI does not exist, so a brand new merchant (the exact case the
-- merchant-name check exists for) had nowhere to store what the review queue
-- taught it.
--
-- HARD RULE, inherited from rls_receipts_smoke.sql and
-- rls_template_embedding_smoke.sql: every fixture id is captured off its own
-- "insert ... returning" CTE or off the RPC that created it. Nothing is ever
-- looked up by name or by any other global predicate over a whole table; this
-- database also holds live E2E data. Every count assertion is scoped by a
-- fixture id or by a fixture-owned business_id, never left as a bare count.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0034 applied.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(30);

-- ---------------------------------------------------------------- fixtures
-- Four users: two owners of two tenants, plus the marketing and counter-staff
-- members of tenant 1 that 0034's owner/manager narrowing turns on. Emails are
-- distinct from every other suite in this directory.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('d1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-alias-owner1@example.com', '{"full_name": "Alias Owner One"}'::jsonb),
  ('d2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-alias-owner2@example.com', '{"full_name": "Alias Owner Two"}'::jsonb),
  ('d5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-alias-marketing@example.com', '{"full_name": "Alias Marketing"}'::jsonb),
  ('d6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-alias-staff@example.com', '{"full_name": "Alias Counter Staff"}'::jsonb);

-- owner1 registers tenant 1. register_business (0003) returns the new uuid, so
-- the id is captured straight from the call and never looked up.
select set_config('request.jwt.claims',
  '{"sub": "d1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz1',
  (select public.register_business('Alias Kape Bicolandia', 'cafe', 'cebu', '1 Alias Street')::text),
  true);
reset role;

-- owner2 registers tenant 2 (the cross-tenant probe)
select set_config('request.jwt.claims',
  '{"sub": "d2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz2',
  (select public.register_business('Alias Jollibee Clone', 'restaurant', 'manila', '2 Alias Ave')::text),
  true);
reset role;

-- role-matrix members of tenant 1 (privileged fixture: staff membership writes
-- are service-role only until the staff module ships)
insert into public.business_staff (business_id, user_id, role, status)
values
  (current_setting('test.biz1')::uuid,
   'd5555555-5555-4555-8555-555555555555', 'marketing', 'active'),
  (current_setting('test.biz1')::uuid,
   'd6666666-6666-4666-8666-666666666666', 'staff', 'active');

-- A consumer and a receipt of tenant 1, so the `receipt_id` provenance column
-- and its ON DELETE SET NULL can be exercised on real rows.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values ('d9999999-9999-4999-8999-999999999999', 'authenticated', 'authenticated',
        'giya-alias-consumer@example.com', '{"full_name": "Alias Consumer"}'::jsonb);
insert into public.consumers (id) values ('d9999999-9999-4999-8999-999999999999')
on conflict do nothing;

with ins as (
  insert into public.receipts (business_id, user_id, image_path, image_hash, sha256, status)
  values (current_setting('test.biz1')::uuid,
          'd9999999-9999-4999-8999-999999999999',
          'd9999999-9999-4999-8999-999999999999/alias-fixture.jpg',
          '0f1e2d3c4b5a6978',
          repeat('a', 64),
          'review')
  returning id
)
select set_config('test.receipt1', (select id::text from ins), true);

-- ---------------------------------------------------------------- structure
-- 1. the table exists
select has_table('public', 'business_merchant_aliases',
  'business_merchant_aliases exists (0034)');

-- 2/3. the two columns the matcher reads
select has_column('public', 'business_merchant_aliases', 'alias',
  'business_merchant_aliases.alias exists (the header verbatim)');

select has_column('public', 'business_merchant_aliases', 'alias_normalized',
  'business_merchant_aliases.alias_normalized exists (the comparison form)');

-- 4. THE NORMALIZATION IS GENERATED, not written by the application. If it
--    were an ordinary column, an admin tool or a support script could store a
--    pair that disagrees, and the matcher would never find an alias a merchant
--    believes they taught it.
select is(
  (select a.attgenerated
     from pg_attribute a
    where a.attrelid = 'public.business_merchant_aliases'::regclass
      and a.attname = 'alias_normalized'),
  's',
  'alias_normalized is a STORED GENERATED column, so the two forms cannot disagree');

-- ------------------------------------------------- normalization, character for character
-- These are the assertions that keep SQL and TypeScript in step.
-- normalizeForMatch(value) = value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim()

with ins as (
  insert into public.business_merchant_aliases (business_id, alias, source, receipt_id, created_by)
  values (current_setting('test.biz1')::uuid, '  Kape  Bicolandia! ', 'learned',
          current_setting('test.receipt1')::uuid,
          'd1111111-1111-4111-8111-111111111111')
  returning id, alias_normalized
)
select set_config('test.alias1', (select id::text from ins), true);

-- 5. uppercase, punctuation collapsed to one space, trimmed
select is(
  (select alias_normalized from public.business_merchant_aliases
    where id = current_setting('test.alias1')::uuid),
  'KAPE BICOLANDIA',
  'alias_normalized matches normalizeForMatch: uppercase, punctuation to space, collapsed, trimmed');

-- 6. and the VERBATIM form is kept untouched beside it, because that is what a
--    reviewer is shown and what a future normalization would be recomputed from
select is(
  (select alias from public.business_merchant_aliases
    where id = current_setting('test.alias1')::uuid),
  '  Kape  Bicolandia! ',
  'the verbatim alias is stored unchanged beside its normalization');

-- 7. digits survive normalization (a trading name like "7 ELEVEN" must not lose them)
with ins as (
  insert into public.business_merchant_aliases (business_id, alias)
  values (current_setting('test.biz1')::uuid, '7-Eleven #123')
  returning id, alias_normalized
)
select is((select alias_normalized from ins), '7 ELEVEN 123',
  'digits are preserved by the normalization (trading names carry them)');

-- 8. an all-punctuation alias is REFUSED. This is the case that matters most:
--    an unreadable header normalizes to the empty string, which would match
--    every unreadable receipt on the platform and auto-approve all of them.
select throws_ok(
  $$insert into public.business_merchant_aliases (business_id, alias)
    values (current_setting('test.biz1')::uuid, '~~~~')$$,
  '23514',
  null,
  'an alias that normalizes to nothing is refused (it would match every unread header)');

-- 9. a one-character alias is refused by the length check
select throws_ok(
  $$insert into public.business_merchant_aliases (business_id, alias)
    values (current_setting('test.biz1')::uuid, 'K')$$,
  '23514',
  null,
  'a single-character alias is refused');

-- 10. and an over-long one, so a pasted page of OCR cannot become an alias
select throws_ok(
  $$insert into public.business_merchant_aliases (business_id, alias)
    values (current_setting('test.biz1')::uuid, repeat('A', 201))$$,
  '23514',
  null,
  'an alias longer than 200 characters is refused');

-- 11. `source` is a closed set: a learned alias is only ever as good as the OCR
--     that produced it, and an audit of what widened a merchant's acceptance
--     has to be able to separate the two kinds
select throws_ok(
  $$insert into public.business_merchant_aliases (business_id, alias, source)
    values (current_setting('test.biz1')::uuid, 'Whatever Cafe', 'guessed')$$,
  '23514',
  null,
  'source is constrained to learned|configured');

-- ------------------------------------------------- the idempotent one-tap
-- 12. THE UNIQUE INDEX EXISTS, on the NORMALIZED form. This is what the review
--     action's `on conflict do nothing` targets, and it is the whole reason
--     0034 is a table rather than a `businesses.merchant_aliases text[]`:
--     appending to an array is a read-modify-write, so two reviewers tapping
--     "always accept" in the same second silently lose one of the two aliases.
select is(
  (select count(*)::int
     from pg_index x
     join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'public.business_merchant_aliases'::regclass
      and i.relname = 'business_merchant_aliases_biz_alias_uniq'
      and x.indisunique),
  1,
  'business_merchant_aliases_biz_alias_uniq exists and is unique');

-- 13. two aliases that normalize alike are the SAME alias, whatever their
--     punctuation and case: "KAPE BICOLANDIA!" is not a second header
select throws_ok(
  $$insert into public.business_merchant_aliases (business_id, alias)
    values (current_setting('test.biz1')::uuid, 'kape bicolandia')$$,
  '23505',
  null,
  'a differently-punctuated spelling of a known alias collides on the normalized form');

-- 14. and the conflict target the application names actually resolves, so the
--     one-tap is genuinely a no-op on the second press rather than a 23505 in
--     front of a merchant
select lives_ok(
  $$insert into public.business_merchant_aliases (business_id, alias)
    values (current_setting('test.biz1')::uuid, 'KAPE  BICOLANDIA')
    on conflict (business_id, alias_normalized) do nothing$$,
  'the same header taught twice is a no-op (on conflict do nothing resolves)');

-- 15. and nothing was added by that second tap
select is(
  (select count(*)::int from public.business_merchant_aliases
    where business_id = current_setting('test.biz1')::uuid
      and alias_normalized = 'KAPE BICOLANDIA'),
  1,
  'the duplicate tap left exactly one row');

-- 16. THE INDEX IS PER BUSINESS. The same header at two shops is two aliases -
--     which is the ordinary case for a franchise, and would be a cross-tenant
--     collision if the index were global.
select lives_ok(
  $$insert into public.business_merchant_aliases (business_id, alias)
    values (current_setting('test.biz2')::uuid, 'Kape Bicolandia')$$,
  'the same normalized alias in another tenant is a separate row (the index is per business)');

-- ------------------------------------------------- the case this table exists for
-- 17. AN ALIAS EXISTS FOR A BUSINESS WITH NO TEMPLATE AT ALL. The whole reason
--     the aliases moved off `receipt_templates.parse_config`: the template
--     management UI does not exist, so a brand new merchant - the exact case
--     the merchant-name check is aimed at - had nowhere to put what the review
--     queue taught it.
select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'the fixture tenant has no receipt_templates row at all');

select cmp_ok(
  (select count(*)::int from public.business_merchant_aliases
    where business_id = current_setting('test.biz1')::uuid),
  '>', 0,
  'and it still has merchant aliases (which parse_config could never have held)');

-- ------------------------------------------------- provenance
-- 19. the receipt that taught the alias is recorded
select is(
  (select receipt_id from public.business_merchant_aliases
    where id = current_setting('test.alias1')::uuid),
  current_setting('test.receipt1')::uuid,
  'the alias records the receipt it was taught from');

-- 20. and losing that receipt must never silently narrow what a merchant
--     already accepts, so the FK is ON DELETE SET NULL and not CASCADE.
--
--     Asserted from the catalog rather than by deleting the receipt, because
--     0017's `private.receipts_no_delete` trigger forbids that outright
--     ("receipts cannot be deleted (financial and fraud evidence)"). The
--     action still matters: a future retention job, or a hard delete run as
--     the table owner with the trigger disabled, must not take a merchant's
--     accepted headers with it. `n` is SET NULL in pg_constraint.confdeltype.
select is(
  (select confdeltype from pg_constraint
    where conname = 'business_merchant_aliases_receipt_id_fkey'),
  'n'::"char",
  'the receipt_id FK is ON DELETE SET NULL: losing the receipt never narrows what a shop accepts');

-- ------------------------------------------------- tenancy: owner 1
select set_config('request.jwt.claims',
  '{"sub": "d1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 21. the owner reads their own aliases
select cmp_ok(
  (select count(*)::int from public.business_merchant_aliases
    where business_id = current_setting('test.biz1')::uuid),
  '>', 0,
  'owner reads own-tenant merchant aliases (P1 select)');

-- 22. and not tenant 2's. An alias list is the set of headers that will
--     auto-approve at a shop, so a competitor who could read it would know
--     exactly which receipt to scan.
select is(
  (select count(*)::int from public.business_merchant_aliases
    where business_id = current_setting('test.biz2')::uuid),
  0,
  'owner of A cannot read the alias list of B (cross-tenant deny)');

-- 23. NO CLIENT WRITE PATH. Every write goes through the review surface's
--     server action, which re-reads the header from parse_meta and audits the
--     widening; a direct client insert would be an unaudited one, and a
--     client-supplied string would let a compromised session widen acceptance
--     to an arbitrary header.
select throws_ok(
  $$insert into public.business_merchant_aliases (business_id, alias)
    values (current_setting('test.biz1')::uuid, 'Owner Typed This')$$,
  '42501',
  null,
  'an owner cannot insert an alias directly (writes are service-role and audited)');

-- 24. and cannot delete one either
select throws_ok(
  $$delete from public.business_merchant_aliases
     where id = current_setting('test.alias1')::uuid$$,
  '42501',
  null,
  'an owner cannot delete an alias directly');

reset role;

-- ------------------------------------------------- role narrowing
-- 0017 narrowed receipt_templates to owner/manager because parse_config is
-- anti-fraud configuration counter staff never need. An alias list is the same
-- family, so the narrowing holds here too.
select set_config('request.jwt.claims',
  '{"sub": "d5555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
set local role authenticated;

-- 25. marketing member of the tenant sees nothing
select is(
  (select count(*)::int from public.business_merchant_aliases
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'marketing member cannot read merchant aliases (owner/manager narrowing)');

reset role;

select set_config('request.jwt.claims',
  '{"sub": "d6666666-6666-4666-8666-666666666666", "role": "authenticated"}', true);
set local role authenticated;

-- 26. and neither does counter staff
select is(
  (select count(*)::int from public.business_merchant_aliases
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'counter staff member cannot read merchant aliases (owner/manager narrowing)');

reset role;

-- ------------------------------------------------- privilege fence
-- RLS gates row DML only. It never sees TRUNCATE and never applies to
-- service_role, so the privilege layer is asserted separately. Each assertion
-- aggregates what the role still holds, so a failure names the leaked
-- privilege instead of just reporting false.

-- 27. anon holds nothing at all on this table, reads included: every policy
--     here is `to authenticated`, so leaving the default SELECT grant behind
--     would have made the anon row of doc 12's matrix RLS-only for reads.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.business_merchant_aliases', p)),
  null::text,
  'anon holds no privilege of any kind on business_merchant_aliases');

-- 28. authenticated keeps SELECT and nothing else. TRUNCATE is the one that
--     matters most: RLS never sees it, so without the revoke any authenticated
--     user could have erased every tenant's accepted headers in one statement
--     despite there being no delete policy anywhere on this table.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.business_merchant_aliases', p)),
  'SELECT',
  'authenticated holds exactly SELECT on business_merchant_aliases (no client write path)');

-- 29. RLS is on. Without it the SELECT grant above would expose every tenant's
--     accepted headers to every signed-in user.
select is(
  (select relrowsecurity from pg_class
    where oid = 'public.business_merchant_aliases'::regclass),
  true,
  'row level security is enabled on business_merchant_aliases');

-- 30. a tenant hard-delete takes its aliases with it. The list is tenant data
--     and must not outlive the tenant as orphaned rows naming a dead business.
select lives_ok(
  $$delete from public.businesses where id = current_setting('test.biz2')::uuid$$,
  'deleting a business cascades its merchant aliases away (no orphaned acceptance list)');

select * from finish();

rollback;
