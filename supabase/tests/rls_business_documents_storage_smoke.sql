-- ============================================================================
-- rls_business_documents_storage_smoke.sql (pgTAP)
-- Smoke tests for 0079_business_documents_storage.sql: the private
-- `business-documents` bucket and the TENANT fence on storage.objects.
--
-- THE ASSERTION THIS SUITE EXISTS FOR is number 17, and it is worth reading
-- before the rest. The owner's session in this file deliberately carries NO
-- `app_metadata.biz` CLAIM - only a `sub`. That is not laziness, it is the
-- scenario: `register_business` creates the businesses row and the
-- business_staff owner row in one call, and the merchant's access token was
-- minted BEFORE that row existed. Documents are uploaded in that same wizard,
-- seconds later, on that same stale token.
--
-- So assertion 17 fails for the whole class of predicate that reads claims and
-- passes for the class that reads tables:
--
--   private.is_staff_of(bid, roles)     -> private.jwt_biz_role(bid)
--                                       -> auth.jwt()->'app_metadata'->'biz'
--                                          ... no claim, no access.
--   private.is_active_staff(bid, roles) -> SECURITY DEFINER read of
--                                          public.business_staff. Correct the
--                                          instant the row commits.
--
-- Assertions 9 and 10 pin that choice STRUCTURALLY as well, by reading the
-- deployed predicate text: every policy must name is_active_staff and none may
-- name is_staff_of. Both halves are needed - 17 proves the behaviour a merchant
-- experiences, 9/10 prove the deployed policy is the reason, and a future
-- "consistency" edit that swapped the helper to match 0067's table policy would
-- fail all three rather than silently locking new merchants out of uploading.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0079 applied. pgTAP
-- lives in the extensions schema.
--
-- THREE THINGS THAT WOULD OTHERWISE MAKE THIS SUITE LIE, all verified live
-- against zlfxfzlnklqhajacngxf before it was written:
--
--   1. `storage.objects` carries a statement-level BEFORE DELETE trigger,
--      `protect_objects_delete`, whose function raises 42501 unless the session
--      GUC `storage.allow_delete_query` is 'true'. It fires for EVERY role,
--      before RLS is consulted, and it fires even when RLS would have filtered
--      every row. A delete assertion written without that GUC passes whether or
--      not a DELETE policy exists at all - it would be measuring the trigger.
--      Assertion 28 pins the trigger explicitly, and only then does the GUC go
--      on, so 29-31 are measuring the policy.
--   2. `authenticated` and `anon` both hold table-level INSERT, SELECT, UPDATE
--      and DELETE on storage.objects by Supabase default, and this migration
--      does not revoke it (it cannot: the table is owned by
--      supabase_storage_admin). RLS is the ONLY fence. Assertions 12 and 13
--      state that, so a future reader cannot mistake a denial here for a
--      revoked grant.
--   3. `storage.buckets` carries `protect_buckets_delete`, so the bucket row
--      cannot be created and dropped by this suite. It asserts the row 0079
--      inserted and never writes to storage.buckets.
--
-- Fixture strategy follows the house rule: every fixture id is captured off the
-- RPC or the insert-returning CTE that created it, never looked up by name.
-- This database also holds the live demo tenant, and a bare count over
-- storage.objects or businesses would pick up real rows.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(35);

-- ---------------------------------------------------------------- fixtures
-- Three users: the owner of tenant 1, the owner of tenant 2 (the cross-tenant
-- actor, a real owner of a real business so a refusal reads as "this fence
-- held" rather than "this session could not do anything anyway"), and a
-- cashier-grade member of tenant 1 (the role-narrowing actor).
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('e1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-docs-owner1@example.com', '{"full_name": "Docs Owner One"}'::jsonb),
  ('e2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-docs-owner2@example.com', '{"full_name": "Docs Owner Two"}'::jsonb),
  ('e3333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated',
   'giya-docs-cashier@example.com', '{"full_name": "Docs Cashier"}'::jsonb);

-- Two tenants, ids captured straight off the RPC's return value. Both land on
-- status='draft', which is exactly the state a business uploading its
-- verification documents is in.
select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz1',
  (select public.register_business('Docs Suite Cafe', 'cafe', 'naga', '1 Permit Street')::text),
  true);
reset role;

select set_config('request.jwt.claims',
  '{"sub": "e2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.biz2',
  (select public.register_business('Docs Suite Rival', 'restaurant', 'naga', '2 Permit Ave')::text),
  true);
reset role;

-- The cashier: an ACTIVE member of tenant 1, but role 'staff'. 0067's TABLE
-- select policy admits marketing and staff; 0079's OBJECT policies deliberately
-- do not, because these are government IDs and tax registrations.
insert into public.business_staff (business_id, user_id, role, status, created_by, updated_by)
values (
  current_setting('test.biz1')::uuid,
  'e3333333-3333-4333-8333-333333333333',
  'staff', 'active',
  'e1111111-1111-4111-8111-111111111111',
  'e1111111-1111-4111-8111-111111111111');

-- One document object per tenant, seeded privileged (rolbypassrls, which is
-- what the Storage API's own admin path amounts to here).
with ins as (
  insert into storage.objects (bucket_id, name, metadata)
  values
    ('business-documents',
     current_setting('test.biz1') || '/aaaaaaaa-1111-4111-8111-111111111111.pdf',
     '{"mimetype": "application/pdf", "size": 8192}'::jsonb),
    ('business-documents',
     current_setting('test.biz2') || '/bbbbbbbb-2222-4222-8222-222222222222.pdf',
     '{"mimetype": "application/pdf", "size": 8192}'::jsonb)
  returning id, name
)
select
  set_config('test.obj1',
    (select id::text from ins where name like current_setting('test.biz1') || '/%'), true),
  set_config('test.obj2',
    (select id::text from ins where name like current_setting('test.biz2') || '/%'), true);

-- ---------------------------------------------------------------- bucket row
--
-- READ BEFORE TRUSTING ASSERTIONS 2, 4 AND 5 AS COVERAGE. `public`,
-- `file_size_limit` and `allowed_mime_types` are enforced by the STORAGE API,
-- never by Postgres. Nothing in the database refuses an oversized or wrongly
-- typed object, and a `set local role authenticated` session can insert a
-- storage.objects row that violates all three - because the API is what reads
-- these columns, and pgTAP is not going through the API.
--
-- So these three are CATALOG assertions and cannot be anything else: they prove
-- the migration wrote the settings it claims, and they prove nothing about
-- behaviour. Widening any of them is caught here and is caught NOWHERE
-- behaviourally, which is exactly why they are worth stating. The byte-level
-- enforcement that does exist lives in the upload action's magic-byte sniff
-- (src/features/businesses/onboarding/server/document-format.ts), and the size
-- cap is additionally enforced by the column's own
-- business_documents_size_bytes_check, which assertion 3 ties this bucket to.
--
-- 1. the bucket 0079 creates exists at all. Before this migration it did not,
--    despite four documents and 0002's own column comment naming it.
select is(
  (select count(*)::int from storage.buckets where id = 'business-documents'),
  1,
  'the business-documents bucket row exists (0079 insert landed)');

-- 2. PRIVATE, and this is the single line that decides whether scans of
--    mayor's permits, DTI/SEC registrations and government IDs are readable by
--    anyone holding or guessing a URL. `avatars` is public and is NOT the model
--    here; `receipts` is. Flipping this boolean must never be a silent change.
select is(
  (select public from storage.buckets where id = 'business-documents'),
  false,
  'the business-documents bucket is PRIVATE (signed URLs only, doc 15)');

-- 3. THE AGREEMENT ASSERTION. The bucket's cap and the table's own check
--    constraint are read from two different catalogs and compared to EACH
--    OTHER, rather than both being restated as 20971520 here. A bucket that
--    accepted more than the column allows would let an object land that its row
--    could never be written for; a bucket that accepted less would refuse a
--    document the table says is fine. Either way the merchant gets a rejection
--    nobody can explain.
select is(
  (select file_size_limit from storage.buckets where id = 'business-documents'),
  (select (regexp_match(pg_get_constraintdef(oid), 'size_bytes <= \(?(\d+)'))[1]::bigint
     from pg_constraint where conname = 'business_documents_size_bytes_check'),
  'the bucket size cap EQUALS business_documents_size_bytes_check''s own bound');

-- 4. and the shared number stated once, so a failure of 3 names the value
--    instead of only reporting that two unknowns differ
select is(
  (select file_size_limit from storage.buckets where id = 'business-documents'),
  20971520::bigint,
  'that shared bound is 20MB (20971520), per doc 32 section 56');

-- 5. exactly the three formats a Philippine merchant can actually obtain a
--    permit in, and exactly what the wizard's copy promises ("PDF, JPG, or
--    PNG"). No image/svg+xml: an admin reviewer opens these in a browser tab.
--    No image/webp: nothing produces a WebP scan of a permit.
select is(
  (select allowed_mime_types from storage.buckets where id = 'business-documents'),
  array['application/pdf', 'image/jpeg', 'image/png'],
  'the bucket allows exactly pdf/jpeg/png (no svg, no webp, no heic)');

-- 6. id and name agree, so a path written against one resolves under the other
select is(
  (select name from storage.buckets where id = 'business-documents'),
  'business-documents',
  'the business-documents bucket id and name are the same string');

-- ---------------------------------------------------------------- policy set
-- 7. exactly three policies - insert, select, delete - and deliberately NO
--    UPDATE. Aggregated into a sorted string so a failure names what actually
--    exists rather than just reporting false. An UPDATE policy would let a
--    merchant swap the bytes under a document an admin had already approved,
--    leaving file_name, mime_type, size_bytes and the review decision all
--    describing a file that is no longer there.
select is(
  (select string_agg(policyname || ':' || cmd, ', ' order by policyname)
     from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like 'business_docs_%'),
  'business_docs_objects_staff_delete:DELETE, business_docs_objects_staff_insert:INSERT, '
  || 'business_docs_objects_staff_select:SELECT',
  '0079 creates exactly three policies: insert, select, delete - and no UPDATE');

-- 8. every one of them granted to `authenticated` only. A policy that also
--    listed `anon` would publish a bucket of government IDs to the internet.
select is(
  (select string_agg(distinct roles::text, ', ')
     from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like 'business_docs_%'),
  '{authenticated}',
  'every business-documents policy is granted to authenticated only, never anon');

-- 9. STRUCTURAL PIN ON THE HELPER, half one. All three predicates must resolve
--    membership from the TABLE. See this file's header: the merchant uploading
--    documents is holding a token minted before their own staff row existed.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'business_docs_%'
      and coalesce(qual, '') || coalesce(with_check, '') like '%is_active_staff%'),
  3,
  'all three policies resolve membership through private.is_active_staff (table truth)');

-- 10. STRUCTURAL PIN, half two, and this is the one that catches the tidy-up.
--     `business_docs_staff_insert` on the TABLE (0067) uses is_staff_of, so
--     "make these consistent" is a natural-looking edit. Made in this direction
--     it locks every newly registered merchant out of uploading their own
--     permits, on a path where the failure looks like a permissions bug.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'business_docs_%'
      and coalesce(qual, '') || coalesce(with_check, '') like '%is_staff_of%'),
  0,
  'NO business-documents policy uses the claims-based private.is_staff_of');

-- 11. the depth pin, on the WRITE policy only - where the name is being chosen.
--     Read and delete must be able to see and remove anything that ever landed.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'business_docs_objects_staff_insert'
      and with_check like '%array_length(storage.foldername(name), 1) = 1%'),
  1,
  'the INSERT policy pins the one-level {business_id}/ folder depth');

-- ---------------------------------------------------------------- privilege layer
-- 12/13. THE CONTEXT FOR EVERY DENIAL BELOW. Both client roles hold full DML on
--        storage.objects by Supabase default and this migration does not revoke
--        it. So RLS is the only fence, and every 42501 below is a policy
--        refusing a row rather than a missing grant. Stated as assertions so
--        that if a future migration ever does revoke one, the denials below stop
--        meaning what their names claim and these lines say so first.
select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','SELECT','UPDATE','DELETE']) as p
    where has_table_privilege('authenticated', 'storage.objects', p)),
  'DELETE,INSERT,SELECT,UPDATE',
  'authenticated holds full DML on storage.objects: RLS is the only fence here');

select is(
  (select string_agg(p, ',' order by p)
     from unnest(array['INSERT','SELECT','UPDATE','DELETE']) as p
    where has_table_privilege('anon', 'storage.objects', p)),
  'DELETE,INSERT,SELECT,UPDATE',
  'anon holds full DML on storage.objects too, so its denials below are RLS');

-- ------------------------------------------------- is_active_staff grant matrix
-- 14/15/16. Every policy above delegates to private.is_active_staff, so its
--           grants are part of this fence and are pinned per role rather than
--           as one "has some assertion" check.
select ok(
  not has_function_privilege('anon', 'private.is_active_staff(uuid, text[])', 'execute'),
  'anon cannot execute private.is_active_staff');

select ok(
  has_function_privilege('authenticated', 'private.is_active_staff(uuid, text[])', 'execute'),
  'authenticated CAN execute private.is_active_staff (the policies need it)');

-- 16. service_role does NOT hold execute on this one, and the assertion says so
--     rather than asserting the habit. READ THIS BEFORE "FIXING" IT EITHER WAY.
--
--     The rule this project has carried since 0052 - that Supabase grants
--     EXECUTE to service_role via project-level DEFAULT PRIVILEGES at CREATE
--     time, regardless of what a migration revokes - is about the PUBLIC schema.
--     These three helpers live in `private`, where there is no such default and
--     every grant is authored. Verified live 2026-08-17:
--
--       private.is_active_staff  secdef=t  {postgres=X, authenticated=X}
--       private.is_staff_of      secdef=f  {postgres=X, authenticated=X, service_role=X}
--       private.jwt_biz_role     secdef=f  {postgres=X, authenticated=X, service_role=X}
--
--     The divergence is not a Supabase behaviour at all, it is two migrations
--     written six files apart:
--       0001_foundations.sql:118-119  grant execute ... to authenticated, service_role;
--       0010_catalog_table_staff_policies.sql:31-32
--                                     revoke ... from public, anon;
--                                     grant execute ... to authenticated;
--     0010 never named service_role, and nothing since has.
--
--     It has NO practical effect: service_role is BYPASSRLS, so it never
--     evaluates the policies that call this function and never needs to call it.
--     The grant is therefore left exactly as it is - 0079 neither creates nor
--     touches this function, and widening a SECURITY DEFINER helper's audience
--     to make a test pass would be the wrong direction entirely. What is pinned
--     here is the deployed reality, so that a future migration handing
--     service_role execute on it is a visible change rather than a silent one.
select ok(
  not has_function_privilege('service_role', 'private.is_active_staff(uuid, text[])', 'execute'),
  'service_role does NOT hold execute on private.is_active_staff (0010 granted only authenticated)');

-- ------------------------------------------------- owner of tenant 1, NO biz claim
-- The claim deliberately carries only `sub`. This is the wizard's real session:
-- the token predates the business_staff row register_business just wrote.
select set_config('request.jwt.claims',
  '{"sub": "e1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 17. THE ASSERTION THIS SUITE EXISTS FOR. Passes on table truth; fails for
--     every claims-reading predicate. Without it the seven denials that follow
--     would all pass against a bucket nobody can write to at all.
select lives_ok(
  format($$insert into storage.objects (bucket_id, name)
           values ('business-documents', '%s/cccccccc-1111-4111-8111-111111111111.pdf')$$,
         current_setting('test.biz1')),
  'AN OWNER UPLOADS UNDER THEIR OWN TENANT WITH NO app_metadata.biz CLAIM (table truth)');

-- 18. THE FENCE. Writing into another tenant's folder is what would let the
--     staff of business X plant a permit that business Y is then reviewed
--     against.
select throws_ok(
  format($$insert into storage.objects (bucket_id, name)
           values ('business-documents', '%s/planted.pdf')$$,
         current_setting('test.biz2')),
  '42501',
  null,
  'an owner cannot INSERT under another tenant business_id segment');

-- 19. a bare filename has NO folder segment: storage.foldername('bare.pdf') is
--     {}, so [1] is NULL, the CASE yields NULL, is_active_staff(NULL, ...) finds
--     no row. The fence fails closed on a malformed path rather than open.
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('business-documents', 'bare.pdf')$$,
  '42501',
  null,
  'an object at the bucket ROOT (no tenant segment) is refused: the fence fails closed');

-- 20. the depth pin behaviourally
select throws_ok(
  format($$insert into storage.objects (bucket_id, name)
           values ('business-documents', '%s/nested/deeper.pdf')$$,
         current_setting('test.biz1')),
  '42501',
  null,
  'a nested path under the tenant own prefix is refused (one level, pinned)');

-- 21. the comparison is on the uuid VALUE, not a text prefix. A folder named
--     `{business_id}-evil` is a different tenant; if this ever passes, the
--     predicate has been rewritten as a `like`.
select throws_ok(
  format($$insert into storage.objects (bucket_id, name)
           values ('business-documents', '%s-evil/f.pdf')$$,
         current_setting('test.biz1')),
  '42501',
  null,
  'a segment that merely STARTS WITH the business id is refused (equality, not prefix)');

-- 22. THE CASE GUARD, and note the error code being asserted. is_active_staff
--     takes a uuid, the segment is attacker-influenced text, and
--     'not-a-uuid'::uuid RAISES 22P02 rather than evaluating false. Without the
--     CASE this line throws 22P02 and this assertion FAILS - which is the
--     point, because a policy that throws instead of denying would also make
--     every listing query in the bucket error out for everyone the moment one
--     malformed name existed. Guarding with `and` instead of `case` would not
--     be enough either: Postgres does not promise left-to-right evaluation of
--     AND operands.
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('business-documents', 'not-a-uuid/permit.pdf')$$,
  '42501',
  null,
  'a NON-UUID tenant segment is DENIED (42501), not a cast error (22P02)');

-- 23. the read half, positive
select is(
  (select count(*)::int from storage.objects where id = current_setting('test.obj1')::uuid),
  1,
  'an owner reads their own tenant document object row');

-- 24. THE FENCE. This is what stops the bucket being enumerable across tenants:
--     no client can walk storage.objects to collect another merchant's document
--     paths and then ask for signed URLs against them.
select is(
  (select count(*)::int from storage.objects where id = current_setting('test.obj2')::uuid),
  0,
  'an owner cannot SELECT another tenant document object row (no cross-tenant listing)');

-- 25. and the pair together: of the two fixture objects, exactly one is visible
select is(
  (select count(*)::int from storage.objects
    where id in (current_setting('test.obj1')::uuid, current_setting('test.obj2')::uuid)),
  1,
  'exactly one of the two fixture objects is visible to tenant 1');

-- 26. NO UPDATE POLICY, behaviourally. A document is not editable in place:
--     re-uploading writes a new object with a new uuid. Swapping bytes under a
--     document an admin already approved is the one mutation this bucket must
--     never allow, and unlike a delete it leaves no trace.
--
--     ASSERTED ON THE ROW COUNT, NOT WITH throws_ok, and the distinction is the
--     whole mechanism. With no applicable UPDATE policy, RLS FILTERS the row out
--     of the statement's scope; it does not raise. 42501 arises only when a row
--     passes USING and then fails WITH CHECK - there is no USING here to pass.
--     An earlier version of this assertion expected 42501 and failed against a
--     fence that was working perfectly. Verified live: the update affects zero
--     rows, `name` is byte-identical afterwards, and the only UPDATE policy on
--     storage.objects is avatars_objects_owner_update, gated on
--     bucket_id = 'avatars'.
--
--     PAIRED WITH ASSERTION 23, which is what makes this mean something: 23
--     proves this owner CAN see obj1, so zero rows here is the update being
--     filtered rather than the row being absent or invisible. Assertion 27 then
--     pins the absence of the policy structurally, which is the load-bearing
--     half - a row count alone cannot tell "no UPDATE policy" from "an UPDATE
--     policy that happens not to match".
with upd as (
  update storage.objects
     set name = current_setting('test.biz1') || '/renamed.pdf'
   where id = current_setting('test.obj1')::uuid
  returning 1)
select set_config('test.own_update_rows', (select count(*)::text from upd), true);

select is(
  current_setting('test.own_update_rows')::int,
  0,
  'an owner UPDATE of their own document object affects zero rows: no UPDATE policy exists');

-- 27. and structurally, so the absence is a decision rather than an oversight
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'business_docs_%' and cmd = 'UPDATE'),
  0,
  'no UPDATE policy exists for business-documents at all');

-- 28. BEFORE ANY DELETE ASSERTION MEANS ANYTHING: storage's own
--     protect_objects_delete statement trigger refuses direct SQL deletes for
--     every role unless `storage.allow_delete_query` is set, and it fires above
--     RLS. This assertion proves 29-31 are measuring the DELETE POLICY and not
--     this trigger.
select throws_ok(
  $$delete from storage.objects where id = current_setting('test.obj1')::uuid$$,
  '42501',
  null,
  'a direct SQL delete is refused by storage protect_objects_delete before RLS is consulted');

-- The Storage API sets this GUC on its own delete path; setting it here is what
-- makes the next three assertions test the policy rather than the trigger.
select set_config('storage.allow_delete_query', 'true', true);

-- 29. THE FENCE. Another tenant's object is unreachable by DELETE, so the
--     statement removes nothing. Asserted on the ROW COUNT: "it did not raise"
--     would pass for a policy that let the delete through. Postgres refuses a
--     data-modifying CTE inside a subquery, so the probe runs as its own
--     top-level statement and parks the count for the assertion after it.
with del as (
  delete from storage.objects
   where id = current_setting('test.obj2')::uuid
  returning 1)
select set_config('test.cross_delete_rows', (select count(*)::text from del), true);

select is(
  current_setting('test.cross_delete_rows')::int,
  0,
  'an owner DELETE of another tenant document affects zero rows (using denies)');

-- 30. the remove half, positive, and it is load-bearing twice over: the wizard
--     renders a "Remove" button against every document, and the upload path's
--     orphan rule (object first, row second, object removed if the row write
--     fails) runs this delete on the MERCHANT's own session rather than
--     bypassing RLS with the service role.
with del as (
  delete from storage.objects
   where id = current_setting('test.obj1')::uuid
  returning 1)
select set_config('test.own_delete_rows', (select count(*)::text from del), true);

select is(
  current_setting('test.own_delete_rows')::int,
  1,
  'an owner may DELETE their own tenant document object (the orphan cleanup path)');

reset role;

-- 31. asserted privileged, since tenant 1 cannot see it: the row tenant 1 tried
--     to delete is genuinely still there. "The delete reported zero rows" and
--     "the row survived" are different claims and a suite should make both.
select is(
  (select count(*)::int from storage.objects
    where id = current_setting('test.obj2')::uuid),
  1,
  'tenant 2 document object still EXISTS after tenant 1 tried to delete it');

-- ------------------------------------------------- role narrowing (staff of tenant 1)
-- An ACTIVE member of the very same business, with a role the object policies
-- do not admit. 0067's TABLE select policy lets marketing and staff read
-- business_documents rows; the OBJECTS are narrower on purpose, because a
-- shop-floor cashier has no reason to read the owner's BIR 2303 or government
-- ID. The refusals below are therefore about the ROLE, not about membership.
select set_config('request.jwt.claims',
  '{"sub": "e3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

-- 32.
select throws_ok(
  format($$insert into storage.objects (bucket_id, name)
           values ('business-documents', '%s/cashier.pdf')$$,
         current_setting('test.biz1')),
  '42501',
  null,
  'an active staff-role member of the SAME tenant cannot INSERT a document object');

-- 33.
select is(
  (select count(*)::int from storage.objects
    where name like current_setting('test.biz1') || '/%'),
  0,
  'an active staff-role member of the same tenant sees NO document objects (owner/manager only)');

reset role;

-- ---------------------------------------------------------------- anon
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

-- 34. no anon policy exists for any verb, and anon holds the table grant, so
--     this is RLS refusing an audience rather than a missing privilege
select throws_ok(
  format($$insert into storage.objects (bucket_id, name)
           values ('business-documents', '%s/anon.pdf')$$,
         current_setting('test.biz1')),
  '42501',
  null,
  'anon cannot INSERT into the business-documents bucket (no anon policy at all)');

-- 35. and cannot enumerate it. Unlike avatars there is no "public bytes,
--     private listing" nuance here: the bucket is private, so this closes the
--     listing half of a surface whose bytes were never reachable either.
select is(
  (select count(*)::int from storage.objects
    where id = current_setting('test.obj2')::uuid),
  0,
  'anon cannot SELECT a business-documents object row');

reset role;

select * from finish();

rollback;
