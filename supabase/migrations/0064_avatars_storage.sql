-- ============================================================================
-- 0064_avatars_storage.sql
-- Public storage bucket `avatars` plus the owner-prefix RLS fence on
-- storage.objects. Companion to T3.4a (the consumer profile edit surface):
-- `profiles.avatar_url` has existed since 0002_identity.sql and has had ZERO
-- writers and no bucket to write into, so the profile header has always
-- rendered initials. This file is what makes that column writable safely.
--
-- Modelled directly on 0019_receipts_storage.sql, which solved the same
-- storage-fence problem for receipts and has already been through review. The
-- object-path convention, the `storage.foldername(name)[1]` reasoning, the
-- initplan `(select auth.uid())` form and the idempotent bucket insert are all
-- taken from that file deliberately rather than re-derived.
--
-- Source docs:
--   * docs/20-data/21-schema-identity.md (`profiles.avatar_url`)
--   * docs/10-architecture/15-security.md "Input & upload safety" (uploads are
--     re-encoded server side, EXIF/GPS stripped, filename regenerated to a UUID
--     and never user-controlled) and "Storage" (buckets private by default;
--     a public bucket is a deliberate, justified exception - see below)
--   * docs/10-architecture/12-multi-tenancy-rls.md (P2/P3 own-row pattern)
--
-- Environment notes (verified live on zlfxfzlnklqhajacngxf before writing, and
-- restating what 0019's header already recorded):
--   * storage.objects already has RLS enabled on this project
--     (owner supabase_storage_admin), so this file does NOT run
--     `alter table storage.objects enable row level security`. The ALTER needs
--     table ownership we do not have.
--   * storage.buckets carries a `protect_buckets_delete` statement trigger, so
--     a bucket row cannot be removed by SQL once inserted. The insert below is
--     therefore idempotent (`on conflict do nothing`) rather than
--     delete-and-recreate: replaying must never try to drop the live bucket and
--     must never clobber a limit tuned in the dashboard.
--   * storage.objects carries the matching `protect_objects_delete` statement
--     trigger, whose function raises 42501 unless the session GUC
--     `storage.allow_delete_query` is 'true' (the Storage API sets it). That
--     trigger sits ABOVE RLS: it fires for every role, including the owner and
--     service_role. It is therefore NOT the delete policy below, and a test
--     that merely observes "a delete raised" proves nothing about the fence -
--     the pgTAP suite sets that GUC so the DELETE policy is what is actually
--     being measured.
--   * `authenticated` holds table-level INSERT/SELECT/UPDATE/DELETE on
--     storage.objects by Supabase default (verified in
--     information_schema.role_table_grants). RLS is the ONLY fence here; there
--     is no privilege layer underneath it the way there is on public tables.
--   * file_size_limit and allowed_mime_types are enforced by the Storage API,
--     not by Postgres. They are a second fence, not the only one: the server
--     action re-checks the size and magic-byte sniffs the content type before
--     it re-encodes, because a bucket setting cannot be trusted to describe
--     bytes a lying Content-Type header already got past.
-- ============================================================================

-- ============================================================ bucket
-- PUBLIC, deliberately, and this is the one decision in this file that differs
-- from 0019. The tradeoff, stated plainly because a reviewer will ask:
--
--   * PUBLIC means the object bytes are served by the storage CDN to anyone who
--     has the URL, with no session and no signature. `profiles.avatar_url`
--     stores that URL, an <img src> renders it directly, and the CDN caches it.
--   * PRIVATE would mean a `createSignedUrl` round trip on EVERY render of
--     every surface that shows a face, a TTL that expires inside an open tab,
--     and a URL no CDN can cache. /profile is already `force-dynamic`, so that
--     is one more sequential call on a screen that has none today, and every
--     future surface showing an avatar inherits the same cost.
--
-- What PUBLIC actually costs here, precisely:
--   * The bytes at a KNOWN path are world-readable. The path's filename is a
--     v4 UUID minted server side, so "known" means "was shared", not "was
--     guessed".
--   * It does NOT make avatars enumerable. Listing goes through
--     `storage.objects` and is still gated by the SELECT policy below, so no
--     client can walk the bucket to collect paths. The brief's
--     "guessable-by-listing" worry is closed by that policy, not by the bucket
--     flag.
--
-- What makes PUBLIC defensible rather than merely convenient: THE BYTES *WE*
-- PUBLISH are not the bytes the consumer picked. The server action re-encodes
-- every upload through sharp before it reaches this bucket
-- (src/features/identity/server/avatar-image.ts), which is what strips EXIF and
-- therefore the GPS tag a phone camera writes into a photo. Publishing a raw
-- camera file would publish the consumer's home coordinates; publishing decoded
-- pixels publishes a face the consumer chose to show. An avatar is a
-- self-chosen public-facing display image - semantically the opposite of a
-- receipt, which carries merchant, date, line items and total and is private in
-- 0019 for exactly that reason.
--
-- Be exact about the scope of that claim, because it is a claim about the APP's
-- path and not about the BUCKET. The insert policy below authorizes any
-- authenticated session to PUT an object into its own uid prefix directly
-- against the Storage API, bypassing the re-encode entirely, and 0021 lets that
-- same session point its own profiles.avatar_url at the result. So a determined
-- consumer CAN publish their own raw camera JPEG with its GPS tag intact. What
-- the fence guarantees is that they can only do it to THEMSELVES: no session can
-- write into anybody else's prefix, and nothing here lets one consumer publish
-- another's location. Self-inflicted EXIF is an accepted residual risk of a
-- client-writable bucket; cross-user planting is not, and that is what the
-- policies are for.
--
-- file_size_limit 2097152 = 2 * 1024 * 1024. Receipts are capped at 10MB
-- because an unreadable receipt is a failed award; an avatar is rendered at 64
-- CSS pixels and its canonical form is a 512px JPEG that lands in the tens of
-- kilobytes, so 10MB here would be two orders of magnitude of headroom for
-- nothing. 2MB is not the limit the consumer meets - the action accepts a
-- larger original and re-encodes it down - it is the ceiling on the direct
-- Storage-API path that any authenticated caller has into their own prefix
-- whether or not they go through our action. That path is the one this number
-- exists to bound.
--
-- allowed_mime_types is the brief's list: image/jpeg, image/png, image/webp.
-- image/heic and image/heif are deliberately ABSENT, matching 0019: sharp on
-- this project is not built to decode HEIC, so a HEIC that reached the bucket
-- would be an object nothing downstream can re-encode.
--
-- image/svg+xml is absent, and here is precisely what that does and does not
-- buy, because the loose version of this sentence is wrong. This setting checks
-- the DECLARED Content-Type, exactly as the note four paragraphs above says - it
-- does not look at bytes. A direct caller can therefore upload SVG BYTES while
-- declaring image/png, and this list will not stop them. What the list does
-- guarantee is the half that matters: the stored content type is always one of
-- these three, so the object is SERVED as image/png or image/jpeg or image/webp
-- and a browser will not parse or execute it as a document. The stored-XSS
-- primitive is "a public origin serving attacker-controlled markup as
-- image/svg+xml", and that is what is closed here - not "no SVG bytes exist in
-- the bucket", which nothing in this file enforces. The byte-level half is the
-- action's magic-byte sniff, which is also the only layer that sees bytes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- ============================================================ storage.objects
-- Object path convention: `avatars/{user_id}/{uuid}.{ext}`. Inside the bucket
-- the object `name` is therefore `{user_id}/{uuid}.{ext}`, so the FIRST path
-- segment is the owning consumer's auth uid and is the whole basis of every
-- policy below. src/features/identity/avatar.ts builds exactly that path, and
-- avatar.test.ts parses the predicates OUT OF THIS FILE and asserts the builder
-- agrees with them - the two sides are checked against each other rather than
-- each against a remembered convention.
--
-- storage.foldername(name) returns text[] of the directory segments (the
-- filename itself is excluded). Its live definition on this project:
--   string_to_array(name, '/') then [1 : array_length(...) - 1]
-- so:
--   storage.foldername('<uuid>/abc.jpg')    -> {<uuid>}    ([1] = the uid)
--   storage.foldername('nested/deep/f.jpg') -> {nested,deep}
--   storage.foldername('bare.jpg')          -> {} , so [1] is NULL
-- That last row matters: an object written at the bucket root yields NULL for
-- segment 1, `NULL = uid` evaluates to NULL, and a NULL predicate is not true,
-- so every policy denies it. The fence fails closed on a malformed path.
--
-- `(select auth.uid())` is the initplan form used throughout 0002-0019: it makes
-- Postgres evaluate the uid once per statement instead of once per row. The cast
-- to text is on the uid side, not the path side, so the comparison can never be
-- widened by a path that merely looks uuid-ish.
--
-- The `array_length(...) = 1` check pins the documented one-level convention so
-- `(storage.foldername(name))[1]` is unambiguously "the owner segment" rather
-- than "the first of an arbitrary tree". `{uid}/a/b/c.jpg` leaks nothing (it is
-- still inside the caller's own prefix) but it lets the object namespace drift
-- away from the convention the path builder, the public-URL derivation and the
-- replace-and-delete cleanup all assume. It is on the two WRITE policies, where
-- the name is being chosen, and deliberately not on the read/delete policies,
-- which must be able to see and remove anything that ever landed.

-- P3 (own-row, write half): a consumer may create objects ONLY under their own
-- uid prefix. This is what stops user X from writing into user Y's folder and
-- planting an image that Y's profile row would then be made to point at.
create policy avatars_objects_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 1
  );

-- P3 (own-row, read half). Note what this does and does not do on a PUBLIC
-- bucket: it gates reads of the storage.objects ROW - which is what `list`
-- returns - not the bytes, which the CDN serves to anyone holding the URL. That
-- is precisely the distinction that makes the public flag survivable: nobody can
-- enumerate the bucket to collect other people's paths, so the only avatars a
-- stranger can fetch are the ones whose URL they were given.
create policy avatars_objects_owner_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- P3 (own-row, replace half). 0019 has no UPDATE policy at all because a receipt
-- image is EVIDENCE and must never be swapped out from under the hashes taken at
-- ingest. An avatar is the opposite: "replace my photo" is a requirement of this
-- slice, and nothing downstream keys off the bytes.
--
-- The happy path does not actually use this policy - a replace uploads a NEW
-- uuid and deletes the old object, so the public URL changes and no CDN edge can
-- serve the previous face from cache. It exists because `upsert: true` on the
-- storage client issues an UPDATE, and because a fence that only covers the
-- paths our own code happens to take is not a fence. USING pins which row may be
-- touched; WITH CHECK pins where it may be moved TO, which is the half that
-- stops a caller renaming their own object into somebody else's prefix.
create policy avatars_objects_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 1
  );

-- P3 (own-row, remove half). Again the opposite of 0019: "remove my photo" is a
-- requirement, and a replace that could not delete the previous object would
-- orphan a public, permanently-fetchable copy of a face the consumer just chose
-- to take down. The consumer's own delete is the only thing that makes "remove"
-- mean removed rather than unlinked.
--
-- Reminder from the header: storage's own `protect_objects_delete` trigger sits
-- above this policy and refuses direct SQL deletes for every role unless
-- `storage.allow_delete_query` is set. Deletes from the app go through the
-- Storage API, which sets it; this policy is what the API's delete is then
-- measured against.
create policy avatars_objects_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- NO anon policy of any kind, for any verb. An avatar bucket that anon could
-- write to is an open file host on the project's own storage origin.
-- NO staff or admin policy either: nothing in the business or admin surfaces
-- reads an avatar through a direct client, and the bytes are public anyway, so
-- a policy would widen the row-listing fence for no reader that exists.
