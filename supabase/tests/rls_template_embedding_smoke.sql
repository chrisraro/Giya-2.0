-- ============================================================================
-- rls_template_embedding_smoke.sql (pgTAP)
-- Smoke tests for 0024_template_embeddings: the pgvector extension, the two new
-- receipt_templates columns and the exact dimension the vector column enforces,
-- the layout_text-beside-the-vector constraint, the distance and ordering
-- semantics the retrieval query depends on, the fact that identical layouts in
-- two different tenants are distance 0 from each other (which is WHY retrieval
-- is scoped by business_id and never used to establish merchant identity), that
-- 0017's P1 tenancy on receipt_templates still holds for the new columns, and
-- the privilege fence including the anon SELECT revoke 0024 adds. Also pins the
-- no-ANN-index decision so reintroducing ivfflat or hnsw fails here rather than
-- landing quietly. Runs entirely inside one transaction and rolls back. Execute
-- as a privileged role (postgres) against a database with migrations 0001-0024
-- applied. pgTAP lives in the extensions schema, and so does pgvector, which is
-- why search_path names both.
--
-- HARD RULE, inherited from rls_receipts_smoke.sql: every fixture id is captured
-- off its own "insert ... returning" CTE. Nothing is ever looked up by name or
-- by any other global predicate over a whole table; this database also holds
-- live E2E data. Every count assertion is scoped by a fixture id or by a
-- fixture-owned business_id, never left as a bare count over a table.
--
-- Fixture vectors are one-hot: element k is 1 and the other 383 are 0. That
-- makes every distance in this file exact and hand-checkable (cosine distance
-- is 0 between a one-hot and itself and exactly 1 between two different
-- one-hots) instead of a float nobody can verify by reading.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(32);

-- ---------------------------------------------------------------- fixtures
-- Four fixed test users: two business owners, plus the marketing and
-- counter-staff members of tenant 1 that 0017's owner/manager narrowing turns
-- on. Emails are distinct from every other suite in this directory.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('c1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-embed-owner1@example.com', '{"full_name": "Embed Owner One"}'::jsonb),
  ('c2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-embed-owner2@example.com', '{"full_name": "Embed Owner Two"}'::jsonb),
  ('c5555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated',
   'giya-embed-marketing@example.com', '{"full_name": "Embed Marketing"}'::jsonb),
  ('c6666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated',
   'giya-embed-staff@example.com', '{"full_name": "Embed Counter Staff"}'::jsonb);

-- owner1 registers tenant 1; register_business returns the new business uuid
-- (0003), so the id is captured straight from the call, never looked up.
select set_config('request.jwt.claims',
  '{"sub": "c1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz1',
  (select public.register_business('Embed Cafe', 'cafe', 'cebu', '1 Vector Street')::text),
  true);
reset role;

-- owner2 registers tenant 2 (the cross-tenant probe)
select set_config('request.jwt.claims',
  '{"sub": "c2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz2',
  (select public.register_business('Embed Rival', 'restaurant', 'manila', '2 Cosine Ave')::text),
  true);
reset role;

-- role-matrix members of tenant 1 (privileged fixture: staff membership writes
-- are service-role only until the staff module ships)
insert into public.business_staff (business_id, user_id, role, status)
values
  (current_setting('test.biz1')::uuid,
   'c5555555-5555-4555-8555-555555555555', 'marketing', 'active'),
  (current_setting('test.biz1')::uuid,
   'c6666666-6666-4666-8666-666666666666', 'staff', 'active');

-- The vector literals, built once and stashed as text. hot1 and hot7 are
-- one-hot at positions 1 and 7; flat is every element 0.01; wide is 385 wide
-- and exists only to prove the column enforces an exact width rather than a
-- minimum.
select set_config('test.vec_hot1',
  (select '[' || string_agg(case when g = 1 then '1' else '0' end, ',' order by g) || ']'
     from generate_series(1, 384) g), true);
select set_config('test.vec_hot7',
  (select '[' || string_agg(case when g = 7 then '1' else '0' end, ',' order by g) || ']'
     from generate_series(1, 384) g), true);
select set_config('test.vec_flat',
  (select '[' || string_agg('0.01', ',' order by g) || ']'
     from generate_series(1, 384) g), true);
select set_config('test.vec_wide',
  (select '[' || string_agg('0.5', ',' order by g) || ']'
     from generate_series(1, 385) g), true);

-- Three templates, ids captured off their own returning CTE. tplA1 and tplB1
-- carry the SAME vector in DIFFERENT tenants: that is spec section 3's failure
-- mode made concrete (two cafes on the same POS software emit near-identical
-- layouts), and the ordering assertions below are what show that only the
-- business_id filter separates them.
with ins as (
  insert into public.receipt_templates
    (business_id, name, source_kind, sample_path, layout_text, embedding)
  values
    (current_setting('test.biz1')::uuid, 'Embed A1 POS', 'pos',
     'invoice-templates/embed-a1.jpg',
     'EMBED CAFE / OR# / VATABLE / VAT / TOTAL',
     current_setting('test.vec_hot1')::extensions.vector(384)),
    (current_setting('test.biz1')::uuid, 'Embed A2 Pad', 'handwritten',
     'invoice-templates/embed-a2.jpg',
     'EMBED CAFE HANDWRITTEN PAD / QTY / ITEM / AMOUNT',
     current_setting('test.vec_hot7')::extensions.vector(384)),
    (current_setting('test.biz2')::uuid, 'Embed B1 POS', 'pos',
     'invoice-templates/embed-b1.jpg',
     'EMBED RIVAL / OR# / VATABLE / VAT / TOTAL',
     current_setting('test.vec_hot1')::extensions.vector(384))
  returning id, sample_path
)
select
  set_config('test.tplA1',
    (select id::text from ins where sample_path = 'invoice-templates/embed-a1.jpg'), true),
  set_config('test.tplA2',
    (select id::text from ins where sample_path = 'invoice-templates/embed-a2.jpg'), true),
  set_config('test.tplB1',
    (select id::text from ins where sample_path = 'invoice-templates/embed-b1.jpg'), true);

-- ---------------------------------------------------------------- structure
-- 1. the extension is installed, and in `extensions` rather than `public`: that
--    is what puts the type, the <=> operator and the vector I/O functions on
--    PostgREST's db_extra_search_path without qualification, and it keeps
--    extension-owned objects out of the exposed schema.
select is(
  (select n.nspname from pg_extension e
     join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector'),
  'extensions',
  'the vector extension is installed, in the extensions schema (0001 convention)');

-- 2/3. the two columns exist
select has_column('public', 'receipt_templates', 'layout_text',
  'receipt_templates.layout_text exists (the VLM master transcription)');

select has_column('public', 'receipt_templates', 'embedding',
  'receipt_templates.embedding exists');

-- 4. layout_text is plain text
select is(
  (select format_type(a.atttypid, a.atttypmod)
     from pg_attribute a
    where a.attrelid = 'public.receipt_templates'::regclass
      and a.attname = 'layout_text'),
  'text',
  'receipt_templates.layout_text is text');

-- 5. THE pinned dimension. 384 is the width of HF_EMBED_MODEL
--    (sentence-transformers/all-MiniLM-L6-v2). Asserted as the exact rendered
--    type so a widening to bare `vector` (no typmod) or to another model's width
--    fails here rather than in production retrieval.
select is(
  (select format_type(a.atttypid, a.atttypmod)
     from pg_attribute a
    where a.attrelid = 'public.receipt_templates'::regclass
      and a.attname = 'embedding'),
  'vector(384)',
  'receipt_templates.embedding is vector(384), pinned to HF_EMBED_MODEL all-MiniLM-L6-v2');

-- ---------------------------------------------------------------- distance math
-- These run privileged, before any further row is inserted, so every count and
-- ordering below is over exactly the three fixture templates.

-- 6. cosine distance between a vector and itself is 0
select is(
  (select t.embedding <=> t.embedding
     from public.receipt_templates t
    where t.id = current_setting('test.tplA1')::uuid),
  0::float8,
  'cosine distance between a stored vector and itself is 0');

-- 7. and between two different one-hots it is exactly 1, which is what makes the
--    ordering assertions below hand-checkable rather than a float to be trusted
select is(
  (select t.embedding <=> current_setting('test.vec_hot7')::extensions.vector(384)
     from public.receipt_templates t
    where t.id = current_setting('test.tplA1')::uuid),
  1::float8,
  'cosine distance between two different one-hot vectors is exactly 1');

-- 8. the retrieval query of spec section 7: nearest template WITHIN the
--    identified business. The probe equals tplA1's vector, so tplA1 wins.
select is(
  (select t.id
     from public.receipt_templates t
    where t.business_id = current_setting('test.biz1')::uuid
      and t.embedding is not null
    order by t.embedding <=> current_setting('test.vec_hot1')::extensions.vector(384)
    limit 1),
  current_setting('test.tplA1')::uuid,
  'order by <=> within a business returns the matching template first');

-- 9. and the other template of the same business ranks behind it, so the
--    ordering is a real ranking and not a single-row accident
select is(
  (select t.id
     from public.receipt_templates t
    where t.business_id = current_setting('test.biz1')::uuid
      and t.embedding is not null
    order by t.embedding <=> current_setting('test.vec_hot1')::extensions.vector(384)
    offset 1 limit 1),
  current_setting('test.tplA2')::uuid,
  'the second-ranked template of the same business is the more distant one');

-- 10. probe with the OTHER layout and the ranking flips, which proves the order
--     tracks the vector rather than insertion order or the primary key
select is(
  (select t.id
     from public.receipt_templates t
    where t.business_id = current_setting('test.biz1')::uuid
      and t.embedding is not null
    order by t.embedding <=> current_setting('test.vec_hot7')::extensions.vector(384)
    limit 1),
  current_setting('test.tplA2')::uuid,
  'probing with the handwritten-pad vector ranks the handwritten pad first');

-- 11. SPEC SECTION 3, made concrete. tplA1 and tplB1 are byte-identical vectors
--     in two different tenants, exactly what two cafes running the same POS
--     software produce. An unscoped nearest-neighbour is therefore a coin flip
--     between two businesses, which is why the vector never establishes merchant
--     identity and why the business_id filter above is not optional.
select is(
  (select count(distinct t.business_id)::int
     from public.receipt_templates t
    where t.id in (current_setting('test.tplA1')::uuid, current_setting('test.tplB1')::uuid)
      and (t.embedding <=> current_setting('test.vec_hot1')::extensions.vector(384)) = 0),
  2,
  'identical layouts in two tenants are both distance 0 (why retrieval is business-scoped)');

-- ---------------------------------------------------------------- dimension enforced
-- These add rows, so they target tenant 2 and run after every ordering
-- assertion above. Privileged role throughout: the dimension is a type
-- constraint, not a policy, and must hold for the pipeline's own writer too.

-- 12. a correctly sized vector is accepted
select lives_ok(
  $$insert into public.receipt_templates
      (business_id, name, source_kind, sample_path, layout_text, embedding)
    values (current_setting('test.biz2')::uuid, 'Embed B2 Wellformed', 'pos',
            'invoice-templates/embed-b2.jpg', 'RIVAL SECOND BRANCH / TOTAL',
            current_setting('test.vec_flat')::extensions.vector(384))$$,
  'a 384-dimension vector inserts cleanly');

-- 13. a 3-dimension vector RAISES. This is the assertion that proves the width
--     is enforced by the type rather than being decorative documentation: a
--     truncated or mis-shaped embedding response from the HF client cannot be
--     stored and then silently compared against real vectors.
select throws_ok(
  $$insert into public.receipt_templates
      (business_id, name, source_kind, sample_path, layout_text, embedding)
    values (current_setting('test.biz2')::uuid, 'Embed B3 TooShort', 'pos',
            'invoice-templates/embed-b3.jpg', 'RIVAL / TOTAL',
            '[1,2,3]'::extensions.vector(384))$$,
  '22000',
  null,
  'a 3-dimension vector is rejected (the 384 is enforced, not decorative)');

-- 14. and it is the dimension check specifically that fired
select throws_like(
  $$insert into public.receipt_templates
      (business_id, name, source_kind, sample_path, layout_text, embedding)
    values (current_setting('test.biz2')::uuid, 'Embed B3 TooShort', 'pos',
            'invoice-templates/embed-b3.jpg', 'RIVAL / TOTAL',
            '[1,2,3]'::extensions.vector(384))$$,
  '%expected 384 dimensions, not 3%',
  'the rejection above names the expected dimension');

-- 15. 384 is an EXACT width, not a floor: one element too many is refused too
select throws_ok(
  $$insert into public.receipt_templates
      (business_id, name, source_kind, sample_path, layout_text, embedding)
    values (current_setting('test.biz2')::uuid, 'Embed B4 TooLong', 'pos',
            'invoice-templates/embed-b4.jpg', 'RIVAL / TOTAL',
            current_setting('test.vec_wide')::extensions.vector(384))$$,
  '22000',
  null,
  'a 385-dimension vector is rejected too (exact width, not a minimum)');

-- 16. the 0024 constraint: a vector with no source text cannot be re-embedded
--     when HF_EMBED_MODEL changes, and cannot be explained to a reviewer asking
--     why a template matched
select throws_ok(
  $$insert into public.receipt_templates
      (business_id, name, source_kind, sample_path, embedding)
    values (current_setting('test.biz2')::uuid, 'Embed B5 Orphan', 'pos',
            'invoice-templates/embed-b5.jpg',
            current_setting('test.vec_flat')::extensions.vector(384))$$,
  '23514',
  null,
  'an embedding without layout_text is refused (nothing to re-embed from)');

-- 17. the converse IS the normal intermediate state: T7 transcribes first and
--     embeds second, and a template with text but no vector is simply not
--     retrievable yet
select lives_ok(
  $$insert into public.receipt_templates
      (business_id, name, source_kind, sample_path, layout_text)
    values (current_setting('test.biz2')::uuid, 'Embed B6 NotYetEmbedded', 'pos',
            'invoice-templates/embed-b6.jpg', 'RIVAL THIRD BRANCH / TOTAL')$$,
  'layout_text without an embedding is allowed (the transcribe-then-embed window)');

-- ---------------------------------------------------------------- tenancy: owner 1
-- 0017's P1 policies are unchanged by 0024, and a column is not a row. These
-- assert that the new columns inherit that tenancy rather than sidestepping it.
select set_config('request.jwt.claims',
  '{"sub": "c1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 18. owner reads own templates (P1 select), both of them
select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  2,
  'owner reads own-tenant receipt_templates (P1 select, 2 fixture rows)');

-- 19. and reads the two NEW columns on them. receipt_templates carries no column
--     allowlist (unlike receipts in 0017 and audit_logs in 0022), so a column
--     added by 0024 is covered by the existing table-level grant. Asserted so
--     that stays a decision rather than an assumption.
select lives_ok(
  $$select id, layout_text, embedding from public.receipt_templates
     where business_id = current_setting('test.biz1')::uuid$$,
  'owner selects layout_text and embedding on own templates (no column fence on this table)');

-- 20. the vector query still runs under RLS and still sees only own tenant: the
--     unscoped ORDER BY returns 2 rows, not the 3 that exist
select is(
  (select count(*)::int from (
     select t.id from public.receipt_templates t
      where t.embedding is not null
      order by t.embedding <=> current_setting('test.vec_hot1')::extensions.vector(384)
      limit 10) s),
  2,
  'an UNSCOPED order-by-<=> still returns only own-tenant rows (RLS applies to vector queries)');

-- 21. tenant 2's identical-layout template is invisible even though it is
--     distance 0 from the probe. Policy, not distance, is what fences tenancy.
select is(
  (select count(*)::int from public.receipt_templates
    where id = current_setting('test.tplB1')::uuid),
  0,
  'owner of A cannot read the identical-layout template of B (P1 cross-tenant deny)');

-- 22. P1 update: the owner writes layout_text and embedding on their own
--     template, which is the T7 template UI write path
select lives_ok(
  $$update public.receipt_templates
       set layout_text = 'EMBED CAFE / OR# / VATABLE / VAT / TOTAL / SALAMAT PO',
           embedding = current_setting('test.vec_flat')::extensions.vector(384)
     where id = current_setting('test.tplA1')::uuid$$,
  'owner updates layout_text and embedding on own template (P1 update)');

-- and cannot touch tenant 2's template. The statement raises nothing (RLS
-- filters rather than errors on UPDATE), it simply matches no row, so the
-- assertion has to be made on the DATA afterwards rather than on the statement.
-- It is run bare here and verified privileged below, because a data-modifying
-- CTE is not allowed inside the subquery an is() would need.
update public.receipt_templates
   set layout_text = 'HIJACKED LAYOUT'
 where id = current_setting('test.tplB1')::uuid;

reset role;

-- 23. tenant B's master layout is exactly as it was seeded
select is(
  (select layout_text from public.receipt_templates
    where id = current_setting('test.tplB1')::uuid),
  'EMBED RIVAL / OR# / VATABLE / VAT / TOTAL',
  'owner of A cannot update the layout_text of B (P1 using clause matched nothing)');

-- ---------------------------------------------------------------- tenancy: owner 2
select set_config('request.jwt.claims',
  '{"sub": "c2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

-- 24. the mirror image: tenant 2's owner cannot read tenant 1's templates
select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'cross-tenant owner cannot read tenant 1 receipt_templates (P1 select)');

-- 25. and specifically not the master layout, which is a merchant's anti-fraud
--     configuration in the same family as parse_config
select is(
  (select count(*)::int from public.receipt_templates
    where layout_text is not null
      and business_id = current_setting('test.biz1')::uuid),
  0,
  'cross-tenant owner cannot read tenant 1 layout_text (merchant layout is not shared)');

reset role;

-- ---------------------------------------------------------------- role narrowing
-- 0017 narrowed this table to owner/manager because parse_config is anti-fraud
-- configuration counter staff never need. layout_text is the same family (it is
-- the document a forger reproduces to defeat tier 1 parsing), so the narrowing
-- must still hold after 0024.
select set_config('request.jwt.claims',
  '{"sub": "c5555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
set local role authenticated;

-- 26. marketing member of the tenant sees no templates at all
select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'marketing member cannot read receipt_templates after 0024 (owner/manager narrowing)');

reset role;

select set_config('request.jwt.claims',
  '{"sub": "c6666666-6666-4666-8666-666666666666", "role": "authenticated"}', true);
set local role authenticated;

-- 27. and neither does counter staff
select is(
  (select count(*)::int from public.receipt_templates
    where business_id = current_setting('test.biz1')::uuid),
  0,
  'counter staff member cannot read receipt_templates after 0024 (owner/manager narrowing)');

reset role;

-- ---------------------------------------------------------------- privilege fence
-- RLS gates row DML only. It never sees TRUNCATE and never applies to
-- service_role, so the privilege layer is asserted separately. Each assertion
-- aggregates what the role still holds, so a failure names the leaked privilege
-- instead of just reporting false.

-- 28. THE 0024 REVOKE. 0017 stripped anon's writes on this table and argued anon
--     is not an audience of it at any privilege level, but left table-level
--     SELECT behind, so the anon row of doc 12's matrix was RLS-only for reads.
--     0024 closes it, because 0024 is what puts a merchant's verbatim receipt
--     layout on this table.
select ok(
  not has_table_privilege('anon', 'public.receipt_templates', 'SELECT'),
  'anon holds no SELECT privilege on receipt_templates (0024 revoke: layout_text lives here now)');

-- 29. anon still holds no write privilege either (0017, unchanged)
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('anon', 'public.receipt_templates', p)),
  null::text,
  'anon holds no write privilege on receipt_templates');

-- 30. authenticated keeps exactly INSERT and UPDATE, the three P1 policies being
--     the client write path the T7 template UI uses. Delete is soft
--     (deleted_at); truncate would erase every tenant's parse configuration and
--     every stored layout in one statement.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) as p
    where has_table_privilege('authenticated', 'public.receipt_templates', p)),
  'INSERT,UPDATE',
  'authenticated keeps exactly INSERT+UPDATE on receipt_templates (0024 changed no write privilege)');

-- ---------------------------------------------------------------- index decision
-- 31. 0024 deliberately adds NO ivfflat and NO hnsw index: retrieval is always
--     filtered by business_id first and a business holds 1 to 5 templates, so
--     an ANN index would apply the tenant filter after candidate selection
--     (losing the right template), ivfflat cannot train lists on an empty
--     column, and both need tuning with no eval set to tune from. Pinned here so
--     reintroducing one is a deliberate edit to a failing test rather than a
--     quiet commit. The reasoning, and the conditions that would reverse it, are
--     in the migration.
select is(
  (select string_agg(am.amname, ',' order by am.amname)
     from pg_index x
     join pg_class i on i.oid = x.indexrelid
     join pg_am am on am.oid = i.relam
    where x.indrelid = 'public.receipt_templates'::regclass
      and am.amname in ('ivfflat', 'hnsw')),
  null::text,
  'no ANN index on receipt_templates: the tenant-scoped scan is the deliberate choice');

-- 32. and the index that decision leans on is still there. receipt_templates_biz_idx
--     (0017, non-partial, business_id leading) is what reduces the vector scan to
--     one merchant's handful of templates; without it the no-ANN-index argument
--     collapses into a sequential scan of every tenant's rows.
select is(
  (select count(*)::int
     from pg_index x
     join pg_class i on i.oid = x.indexrelid
    where x.indrelid = 'public.receipt_templates'::regclass
      and i.relname = 'receipt_templates_biz_idx'),
  1,
  'receipt_templates_biz_idx still exists (the index the no-ANN-index decision depends on)');

select * from finish();

rollback;
