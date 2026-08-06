-- ============================================================================
-- rls_avatars_storage_smoke.sql (pgTAP)
-- Smoke tests for 0064_avatars_storage.sql: the `avatars` bucket settings and
-- the owner-prefix fence on storage.objects, asserted for all four verbs in
-- BOTH directions (a consumer may do it inside their own uid segment, and may
-- not do it inside anybody else's), plus the malformed-path cases the fence has
-- to fail closed on.
--
-- Runs entirely inside one transaction and rolls back. Execute as a privileged
-- role (postgres) against a database with migrations 0001-0064 applied. pgTAP
-- lives in the extensions schema.
--
-- 0019_receipts_storage.sql - the file 0064 is modelled on - shipped with NO
-- pgTAP suite of its own; there is no storage.objects assertion anywhere under
-- supabase/tests/ before this file. The assertion list below is therefore
-- written from the T3.4a brief's enumeration ("a consumer cannot insert,
-- update, select or delete under another user's segment; a bare filename is
-- rejected") rather than ported line by line from an existing suite.
--
-- TWO THINGS THAT WOULD OTHERWISE MAKE THIS SUITE LIE, both verified live
-- against zlfxfzlnklqhajacngxf before it was written:
--
--   1. `storage.objects` carries a statement-level BEFORE DELETE trigger,
--      `protect_objects_delete`, whose function raises 42501 unless the session
--      GUC `storage.allow_delete_query` is 'true'. It fires for EVERY role,
--      before RLS is consulted, and it fires even when RLS would have filtered
--      every row. A delete assertion written without that GUC therefore passes
--      whether or not a DELETE policy exists at all - it would be measuring the
--      trigger. Assertion 22 pins the trigger's behaviour explicitly, and only
--      then does the GUC go on, so assertions 23-25 are measuring the policy.
--
--   2. `authenticated` and `anon` both hold table-level INSERT, SELECT, UPDATE
--      and DELETE on storage.objects by Supabase default. Unlike every public
--      table in this schema there is no privilege layer under the policies:
--      RLS is the ONLY fence. Assertions 8 and 9 state that, so a future reader
--      cannot mistake a denial here for a revoked grant.
--
-- Fixture strategy follows the house rule: every fixture id is a fixed literal
-- or captured off its own insert-returning CTE, and every count assertion is
-- scoped by a fixture id. This database also holds live E2E data, and a bare
-- count over storage.objects would pick up real avatars the moment anyone uses
-- the feature.
--
-- NOTE ON THE BUCKET: storage.buckets carries `protect_buckets_delete`, so the
-- bucket row cannot be created and dropped by this suite. It asserts the row
-- 0064 inserted, and never writes to storage.buckets.
-- ============================================================================

begin;

set local search_path = public, extensions;

select plan(31);

-- ---------------------------------------------------------------- fixtures
-- Two consumers. Real auth.users rows (the on_auth_user_created trigger builds
-- their profiles + consumers) so the uids in the object paths below are the
-- same kind of value the live fence sees.
insert into auth.users (id, aud, role, email, raw_user_meta_data)
values
  ('a1111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated',
   'giya-avatars-consumer1@example.com', '{"full_name": "Avatar Consumer One"}'::jsonb),
  ('a2222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated',
   'giya-avatars-consumer2@example.com', '{"full_name": "Avatar Consumer Two"}'::jsonb);

-- One avatar object each, seeded as the privileged role (rolbypassrls, which is
-- what the Storage API's own admin path amounts to here). Ids captured off the
-- returning CTE, never looked up by name.
with ins as (
  insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
  values
    ('avatars',
     'a1111111-1111-4111-8111-111111111111/aaaaaaaa-1111-4111-8111-111111111111.jpg',
     'a1111111-1111-4111-8111-111111111111',
     'a1111111-1111-4111-8111-111111111111',
     '{"mimetype": "image/jpeg", "size": 4096}'::jsonb),
    ('avatars',
     'a2222222-2222-4222-8222-222222222222/bbbbbbbb-2222-4222-8222-222222222222.jpg',
     'a2222222-2222-4222-8222-222222222222',
     'a2222222-2222-4222-8222-222222222222',
     '{"mimetype": "image/jpeg", "size": 4096}'::jsonb)
  returning id, owner
)
select
  set_config('test.obj1',
    (select id::text from ins where owner = 'a1111111-1111-4111-8111-111111111111'), true),
  set_config('test.obj2',
    (select id::text from ins where owner = 'a2222222-2222-4222-8222-222222222222'), true);

-- ---------------------------------------------------------------- bucket row
-- 1. the bucket 0064 creates exists at all
select is(
  (select count(*)::int from storage.buckets where id = 'avatars'),
  1,
  'the avatars bucket row exists (0064 insert landed)');

-- 2. PUBLIC, and deliberately so. 0064's header states the tradeoff: the bytes
--    are CDN-served to anyone holding the URL, in exchange for no signed-URL
--    round trip on every render of every surface that shows a face. This
--    assertion is here so flipping that boolean is never a silent change - it
--    is the single line that decides whether avatars are world-readable.
select is(
  (select public from storage.buckets where id = 'avatars'),
  true,
  'the avatars bucket is PUBLIC (deliberate: CDN-cacheable, no signed URL per render)');

-- 3. 2MB, not the receipts bucket's 10MB. This number bounds the DIRECT
--    Storage-API path every authenticated caller has into their own prefix,
--    which is the path that does not pass through our re-encode.
select is(
  (select file_size_limit from storage.buckets where id = 'avatars'),
  2097152::bigint,
  'the avatars bucket caps objects at 2MB (not the receipts 10MB)');

-- 4. exactly the three raster formats sharp on this project can decode. No
--    image/svg+xml: an SVG is a script-bearing document, and one served from a
--    PUBLIC bucket on the project's own storage origin is a stored-XSS
--    primitive.
select is(
  (select allowed_mime_types from storage.buckets where id = 'avatars'),
  array['image/jpeg', 'image/png', 'image/webp'],
  'the avatars bucket allows exactly jpeg/png/webp (no svg, no heic)');

-- 5. id and name agree, so a path written against one resolves under the other
select is(
  (select name from storage.buckets where id = 'avatars'),
  'avatars',
  'the avatars bucket id and name are the same string');

-- ---------------------------------------------------------------- policy set
-- 6. exactly four policies, one per verb, all scoped to this bucket. Aggregated
--    into a sorted string so a failure names what actually exists rather than
--    just reporting false.
select is(
  (select string_agg(policyname || ':' || cmd, ', ' order by policyname)
     from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like 'avatars_%'),
  'avatars_objects_owner_delete:DELETE, avatars_objects_owner_insert:INSERT, '
  || 'avatars_objects_owner_select:SELECT, avatars_objects_owner_update:UPDATE',
  '0064 creates exactly four avatars policies, one per verb');

-- 7. and every one of them is granted to `authenticated` only. A policy that
--    also listed `anon` would turn a public avatar bucket into an open file
--    host on the project's own storage origin.
select is(
  (select string_agg(distinct roles::text, ', ')
     from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname like 'avatars_%'),
  '{authenticated}',
  'every avatars policy is granted to authenticated only, never anon');

-- 7b/7c/7d. STRUCTURAL PINS ON THE PREDICATES THEMSELVES, and they are here
-- because of something measured live rather than assumed.
--
-- PostgreSQL applies the SELECT policy to the rows an UPDATE or DELETE reads
-- through its WHERE clause. Probed on this project: with the own-only SELECT
-- policy in place and a deliberately WIDE update/delete policy
-- (`using (bucket_id = 'avatars')`), a consumer's attempt to update or delete
-- another consumer's object still affected ZERO rows - the SELECT policy alone
-- had already made the row unreachable. So the behavioural assertions below
-- (21 and 23) genuinely prove the row cannot be touched, which is what a
-- consumer cares about, but they do NOT prove the UPDATE and DELETE policies
-- carry an owner predicate: they pass with those predicates deleted.
--
-- These three assertions are what closes that gap. They read the deployed
-- predicate text out of pg_policies, so removing the owner check from the
-- UPDATE or DELETE policy - leaving the fence resting on one policy instead of
-- two - fails here even though every behavioural assertion still passes.
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('avatars_objects_owner_select',
                         'avatars_objects_owner_update',
                         'avatars_objects_owner_delete')
      and qual like '%(storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text%'),
  3,
  'select, update and delete all fence their USING on the owner path segment');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('avatars_objects_owner_insert', 'avatars_objects_owner_update')
      and with_check like '%(storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text%'),
  2,
  'insert and update both fence their WITH CHECK on the owner path segment');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('avatars_objects_owner_insert', 'avatars_objects_owner_update')
      and with_check like '%array_length(storage.foldername(name), 1) = 1%'),
  2,
  'both WRITE policies pin the one-level folder depth in their WITH CHECK');

-- ---------------------------------------------------------------- privilege layer
-- 8/9. THE CONTEXT FOR EVERY DENIAL BELOW. Supabase grants both client roles
--      full DML on storage.objects and this migration does not revoke it (it
--      cannot: the table is owned by supabase_storage_admin). So RLS is the
--      only fence, and every 42501 below is a policy refusing a row rather than
--      a missing grant. Stated as an assertion so that if a future migration
--      ever does revoke one of these, the denial assertions stop meaning what
--      their names claim and this line says so first.
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

-- ---------------------------------------------------------------- consumer 1
select set_config('request.jwt.claims',
  '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

-- 10. the write half, positive: own uid prefix, one level deep. Without this
--     the four denials below would all pass on a bucket nobody can write to.
select lives_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars',
            'a1111111-1111-4111-8111-111111111111/cccccccc-1111-4111-8111-111111111111.jpg')$$,
  'a consumer uploads an avatar under their OWN uid segment');

-- 11. THE FENCE. Writing into another consumer's folder is what would let user
--     X plant an image that user Y's profile row is later made to point at.
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars',
            'a2222222-2222-4222-8222-222222222222/planted.jpg')$$,
  '42501',
  null,
  'a consumer cannot INSERT under another consumer uid segment');

-- 12. a bare filename has NO folder segment: storage.foldername('bare.jpg') is
--     {}, so [1] is NULL, `NULL = uid` is NULL, and a NULL predicate is not
--     true. The fence fails closed on a malformed path rather than open.
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', 'bare.jpg')$$,
  '42501',
  null,
  'an object at the bucket ROOT (no uid segment) is refused: the fence fails closed');

-- 13. the depth pin. `{uid}/a/b.jpg` leaks nothing - it is still inside the
--     caller's own prefix - but it lets the namespace drift away from the one
--     convention the path builder, the public-URL derivation and the
--     replace-and-delete cleanup all assume.
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars',
            'a1111111-1111-4111-8111-111111111111/nested/deeper.jpg')$$,
  '42501',
  null,
  'a nested path under the consumer own prefix is refused (one level, pinned)');

-- 14. the comparison is EQUALITY, not a prefix match. A segment that merely
--     starts with the caller's uid is a different folder and must be refused;
--     if this ever passes, the predicate has been rewritten as a `like`.
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars',
            'a1111111-1111-4111-8111-111111111111-evil/f.jpg')$$,
  '42501',
  null,
  'a segment that merely STARTS WITH the uid is refused (equality, not prefix)');

-- 15. the read half, positive
select is(
  (select count(*)::int from storage.objects where id = current_setting('test.obj1')::uuid),
  1,
  'a consumer reads their own avatar object row');

-- 16. THE FENCE. On a public bucket this is what stops the bucket being
--     ENUMERABLE: the bytes are CDN-served to whoever holds a URL, but no
--     client can walk storage.objects to collect other people's paths.
select is(
  (select count(*)::int from storage.objects where id = current_setting('test.obj2')::uuid),
  0,
  'a consumer cannot SELECT another consumer avatar object row (no listing across users)');

-- 17. and the pair together: of the two fixture objects, exactly one is visible
select is(
  (select count(*)::int from storage.objects
    where id in (current_setting('test.obj1')::uuid, current_setting('test.obj2')::uuid)),
  1,
  'exactly one of the two fixture objects is visible to consumer 1');

-- 18. the replace half, positive: rename inside own prefix. 0019 has no UPDATE
--     policy at all because a receipt image is evidence; an avatar is meant to
--     be replaced, so the positive case has to hold or "replace" is broken.
-- Postgres refuses a data-modifying CTE inside a subquery ("WITH clause
-- containing a data-modifying statement must be at the top level"), so each
-- row-count probe below runs as its own top-level statement and parks the count
-- in a local setting for the assertion that follows. The count is the point: a
-- policy that let the write through would raise nothing at all, so "it did not
-- error" is not an assertion about the fence.
with upd as (
  update storage.objects
     set name = 'a1111111-1111-4111-8111-111111111111/renamed.jpg'
   where id = current_setting('test.obj1')::uuid
  returning 1)
select set_config('test.own_update_rows', (select count(*)::text from upd), true);

select is(
  current_setting('test.own_update_rows')::int,
  1,
  'a consumer may UPDATE their own avatar object within their own segment');

-- 19. THE WITH CHECK HALF. USING decides which row may be touched; WITH CHECK
--     decides where it may be moved TO. Without the second, a consumer could
--     rename their own object into somebody else's folder - the same planting
--     attack as 11, through a different verb.
select throws_ok(
  $$update storage.objects
       set name = 'a2222222-2222-4222-8222-222222222222/stolen.jpg'
     where id = current_setting('test.obj1')::uuid$$,
  '42501',
  null,
  'a consumer cannot UPDATE their own object INTO another consumer segment (with check)');

-- 20. and cannot move it to the bucket root either
select throws_ok(
  $$update storage.objects
       set name = 'escaped.jpg'
     where id = current_setting('test.obj1')::uuid$$,
  '42501',
  null,
  'a consumer cannot UPDATE their own object to a bare root filename');

-- 21. THE FENCE, read half of a write: another consumer's row is not REACHABLE
--     by an UPDATE at all, so the statement is a silent no-op rather than an
--     error. Asserted on the ROW COUNT, because "it did not raise" would pass
--     for a policy that let the write through.
--
--     Be precise about what this proves. Probed live: with the own-only SELECT
--     policy in place, this stays at zero even if the UPDATE policy's USING is
--     widened to `bucket_id = 'avatars'`, because the WHERE clause reads the row
--     through the SELECT policy first. So this assertion proves the row cannot
--     be touched - the thing a consumer cares about - and assertion 7b proves
--     the UPDATE policy carries its own owner predicate rather than leaning on
--     the SELECT one. Both are needed; neither substitutes for the other.
with upd as (
  update storage.objects
     set name = 'a2222222-2222-4222-8222-222222222222/hijacked.jpg'
   where id = current_setting('test.obj2')::uuid
  returning 1)
select set_config('test.cross_update_rows', (select count(*)::text from upd), true);

select is(
  current_setting('test.cross_update_rows')::int,
  0,
  'a consumer UPDATE of another consumer object affects zero rows (using denies)');

-- 22. BEFORE ANY DELETE ASSERTION MEANS ANYTHING: storage's own
--     protect_objects_delete statement trigger refuses direct SQL deletes for
--     every role unless `storage.allow_delete_query` is set. It fires above
--     RLS. This is the assertion that proves 23-25 below are measuring the
--     DELETE POLICY and not this trigger - delete the policy and 23-25 change;
--     delete this GUC and they all pass for the wrong reason.
select throws_ok(
  $$delete from storage.objects where id = current_setting('test.obj1')::uuid$$,
  '42501',
  null,
  'a direct SQL delete is refused by storage protect_objects_delete before RLS is consulted');

-- The Storage API sets this GUC on its own delete path; setting it here is what
-- makes the next three assertions test the policy rather than the trigger.
select set_config('storage.allow_delete_query', 'true', true);

-- 23. THE FENCE. Another consumer's object is unreachable by DELETE, so the
--     statement removes nothing. Row count again, not "did not raise". Same
--     caveat as assertion 21, measured the same way: this stays at zero even
--     with a widened DELETE policy because the WHERE reads through the SELECT
--     policy, so assertion 7b is what pins the DELETE policy's own predicate.
--     Assertion 25b then proves the row genuinely survived, read back
--     privileged - "the delete reported zero rows" and "the row is still there"
--     are different claims and a suite should make both.
with del as (
  delete from storage.objects
   where id = current_setting('test.obj2')::uuid
  returning 1)
select set_config('test.cross_delete_rows', (select count(*)::text from del), true);

select is(
  current_setting('test.cross_delete_rows')::int,
  0,
  'a consumer DELETE of another consumer avatar affects zero rows (using denies)');

-- 24. the remove half, positive. "Remove my photo" has to actually remove the
--     object: a replace that could not delete the previous one would orphan a
--     public, permanently-fetchable copy of a face the consumer just took down.
with del as (
  delete from storage.objects
   where id = current_setting('test.obj1')::uuid
  returning 1)
select set_config('test.own_delete_rows', (select count(*)::text from del), true);

select is(
  current_setting('test.own_delete_rows')::int,
  1,
  'a consumer may DELETE their own avatar object');

-- 25. and the other consumer's object survived all of it
select is(
  (select count(*)::int from storage.objects
    where id = current_setting('test.obj2')::uuid),
  0,
  'consumer 2 object is still invisible to consumer 1 after the delete pass');

reset role;

-- 25b. asserted privileged, since consumer 1 cannot see it: the row consumer 1
--      tried to delete is genuinely still there.
select is(
  (select count(*)::int from storage.objects
    where id = current_setting('test.obj2')::uuid),
  1,
  'consumer 2 avatar object still EXISTS after consumer 1 tried to delete it');

-- ---------------------------------------------------------------- anon
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;

-- 26. no anon policy exists for any verb, and anon holds the table grant, so
--     this is RLS refusing an audience rather than a missing privilege
select throws_ok(
  $$insert into storage.objects (bucket_id, name)
    values ('avatars', 'a1111111-1111-4111-8111-111111111111/anon.jpg')$$,
  '42501',
  null,
  'anon cannot INSERT into the avatars bucket (no anon policy at all)');

-- 27. and cannot enumerate the bucket. The BYTES are public by design; the
--     object rows are not, which is the distinction the whole public-bucket
--     decision rests on.
select is(
  (select count(*)::int from storage.objects
    where id = current_setting('test.obj2')::uuid),
  0,
  'anon cannot SELECT an avatars object row (public bytes, private listing)');

reset role;

select * from finish();

rollback;
