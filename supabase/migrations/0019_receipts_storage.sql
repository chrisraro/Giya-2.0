-- ============================================================================
-- 0019_receipts_storage.sql
-- Private storage bucket `receipts` plus the owner-prefix RLS fence on
-- storage.objects. Companion to 0017 (the receipts domain tables): 0017 stores
-- receipts.image_path, this file is what makes that path safe to hand out.
-- Source docs:
--   * docs/superpowers/specs/2026-07-25-receipts-award-design.md section 3.3
--     (private bucket, consumer INSERT limited to own auth.uid() prefix,
--     SELECT owner + service role, NO client UPDATE/DELETE, review surfaces
--     read via 5 minute signed URLs)
--   * docs/10-architecture/15-security.md "Input & upload safety" (receipts
--     cap 10MB, sharp re-encode strips EXIF/GPS, filename regenerated to UUID
--     and never user-controlled) and "Storage" (buckets private by default;
--     `receipts` is explicitly on the private list, signed URL TTL 5 min)
--   * docs/30-modules/36-receipt-ocr-pipeline.md Stage 1 (path convention
--     `receipts/{user_id}/{uuid}.jpg`; accepted input formats JPEG, PNG, WebP,
--     with HEIC converted client side)
--   * docs/10-architecture/12-multi-tenancy-rls.md (P3 own-row pattern)
-- Environment notes:
--   * storage.objects already has RLS enabled on this project
--     (relrowsecurity = true, owner supabase_storage_admin), so this file does
--     NOT run `alter table storage.objects enable row level security`. Verified
--     before writing; the ALTER would need table ownership we do not have and
--     would be a no-op even if it succeeded.
--   * storage.buckets carries a `protect_delete` trigger on this project, so
--     the bucket row cannot be removed by SQL once inserted. The insert below
--     is therefore written idempotently (`on conflict do nothing`) rather than
--     as a delete-and-recreate: replaying this migration must never try to
--     drop the live bucket, and must never clobber a limit tuned in the
--     dashboard.
--   * file_size_limit and allowed_mime_types are enforced by the Storage API,
--     not by Postgres. They are a second fence, not the only one: the submit
--     path (T10) re-checks the 10MB cap and magic-byte sniffs the content type
--     server side, because a bucket setting cannot be trusted to describe
--     bytes that a lying Content-Type header already got past.
-- ============================================================================

-- ============================================================ bucket
-- PRIVATE. doc 15 lists `receipts` among the buckets that are private with
-- access via signed URLs only (TTL 5 min). A public bucket would publish every
-- consumer's receipt images, which carry merchant, date, line items and total,
-- to anyone who can guess or leak a path, and would defeat the entire
-- storage.objects fence below in one boolean.
--
-- file_size_limit 10485760 = 10 * 1024 * 1024, the hard cap doc 15 states for
-- receipts ("receipts <= 10MB"). doc 36 Stage 1 has the client reject anything
-- larger before upload; this is the server-side backstop for a client that
-- does not.
--
-- allowed_mime_types is exactly doc 36 Stage 1's "Accepted input formats:
-- JPEG, PNG, WebP". image/heic and image/heif are deliberately ABSENT: the
-- same sentence says "HEIC converted client-side", so a HEIC that reaches the
-- bucket means the client conversion step was skipped or bypassed, and the
-- sharp canonicalization in the submit path is not built to decode it. Failing
-- that upload at the bucket is the correct, loud outcome.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- ============================================================ storage.objects
-- Object path convention (doc 36 Stage 1): `receipts/{user_id}/{uuid}.jpg`.
-- Inside the bucket the object `name` is therefore `{user_id}/{uuid}.jpg`, so
-- the FIRST path segment is the owning consumer's auth uid and is the whole
-- basis of the fence below.
--
-- storage.foldername(name) returns text[] of the directory segments (the
-- filename itself is excluded). Verified live on this project before relying
-- on it:
--   storage.foldername('<uuid>/abc.jpg')   -> {<uuid>}   ([1] = the uid)
--   storage.foldername('nested/deep/f.jpg')-> {nested,deep}
--   storage.foldername('bare.jpg')         -> {} , so [1] is NULL
-- That last row matters: an object written at the bucket root yields NULL for
-- segment 1, `NULL = uid` evaluates to NULL, and a NULL predicate is not true,
-- so the policy denies it. The fence fails closed on a malformed path.
--
-- `(select auth.uid())` is the initplan form used throughout 0002-0017: it
-- makes Postgres evaluate the uid once per statement instead of once per row.
-- The cast to text is on the uid side, not the path side, so the comparison
-- can never be widened by a path that merely looks uuid-ish.

-- P3 (own-row, write half): a consumer may create objects ONLY under their own
-- uid prefix. This is what stops user X from writing into user Y's folder and
-- planting an image that Y's receipt row would later be made to point at.
--
-- amendment: the segment-count check is not in the spec text. It pins the
-- documented one-level convention `{user_id}/{uuid}.jpg` so that
-- `(storage.foldername(name))[1]` is unambiguously "the owner segment" rather
-- than "the first of an arbitrary tree". Without it a caller could write
-- `{uid}/a/b/c.jpg`; that is still inside their own prefix so it leaks nothing,
-- but it lets the object namespace drift away from the path convention that
-- doc 36 Stage 1, the signed-upload endpoint and receipts.image_path all
-- assume. If a later slice genuinely needs a deeper path (date sharding, say),
-- this check fails loudly and visibly at upload rather than silently accepting
-- a shape nothing downstream expects.
create policy receipts_objects_consumer_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and array_length(storage.foldername(name), 1) = 1
  );

-- P3 (own-row, read half): a consumer reads only their own objects, same
-- prefix check. Everything else reads through the service role, which bypasses
-- RLS entirely: the OCR pipeline (doc 36 Stages 3-4) fetches a fresh signed
-- URL for the stored image, and the business/admin review UI deferred to the
-- next slice will do the same behind a 5 minute TTL (doc 15). Note there is
-- deliberately NO staff policy here: a business owner has no direct-client
-- path to receipt images at all, only server-mediated signed URLs whose
-- generation can be permission-checked and audited per doc 15.
create policy receipts_objects_consumer_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- NO client UPDATE policy and NO client DELETE policy for the `receipts`
-- bucket, deliberately and permanently.
--
-- Receipt images are evidence. Once a receipt is submitted, a consumer must
-- not be able to swap the bytes out from under a receipt row whose sha256 and
-- pHash were computed from the original, nor delete the image behind an
-- approved award.
--
-- Concretely, an UPDATE policy would break the duplicate and fraud machinery
-- that 0017 exists to support: receipts_sha_unique and the pHash neighbour
-- check (doc 37 S1) both key off hashes taken at ingest, so replacing the
-- object afterwards leaves an approved, awarded receipt row pointing at
-- entirely different pixels while the stored hashes still describe the ones
-- that were checked. A DELETE policy would let a consumer destroy the image
-- behind an approved award, or the image behind a fraud rejection whose
-- fraud_signals rows feed doc 37's cooldown ladder, while the receipts row
-- itself is protected against deletion by the receipts_no_delete trigger in
-- 0017 and can only ever point at a hole.
--
-- The one legitimate mutation of a receipt object is the sharp canonicalization
-- overwrite in the submit path (doc 36 Stage 1 step 2, which strips EXIF/GPS).
-- That runs with the SERVICE ROLE, which bypasses RLS, so it needs no policy
-- here and gains nothing from one. There is no client-side caller that ever
-- needs to modify or remove a receipt object, so no policy is written for one.
