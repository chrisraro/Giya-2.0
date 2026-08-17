-- ============================================================================
-- 0079_business_documents_storage.sql
-- The private `business-documents` bucket and its tenant fence on
-- storage.objects. Companion to 0002_identity.sql, which created
-- public.business_documents and named this bucket in a column comment
-- (`business-documents/{business_id}/{uuid}.pdf`) that nothing ever honoured.
--
-- WHY THIS FILE EXISTS AT ALL, WHICH IS THE FIRST THING TO READ.
--
-- The bucket has been referenced by four documents and one column comment since
-- 0002 and HAS NEVER EXISTED. Verified live on 2026-08-17 against
-- zlfxfzlnklqhajacngxf before a line of this was written:
--
--   select id from storage.buckets;                     -- avatars, receipts. That is all.
--   select count(*) from storage.objects
--    where bucket_id = 'business-documents';            -- 0
--   select count(*) from public.business_documents;     -- 0
--   select policyname from pg_policies
--    where schemaname='storage' and tablename='objects';
--     -- avatars_objects_owner_{insert,select,update,delete}
--     -- receipts_objects_consumer_{insert,select}
--
-- `grep -rn "storage.buckets" supabase/` returns exactly two inserts:
-- 0019_receipts_storage.sql and 0064_avatars_storage.sql. Nothing has ever
-- created this one. The verification feature has been "nearly done" against a
-- bucket that is not there.
--
-- SEPARATELY, AND DO NOT CONFUSE THE TWO: 0067_business_documents.sql is a dead
-- file. Its `create table if not exists` hit the table 0002 had already made and
-- did nothing, so `file_path`, `status` and `revision_note` do not exist and its
-- doc_type list (`dti_permit`, `mayor_permit`, `bir_2303`) is not the live
-- constraint. THIS FILE IS WRITTEN AGAINST 0002's SCHEMA, which is what is
-- deployed: `storage_path`, `file_name`, `mime_type`, `size_bytes`. See
-- supabase/README.md. 0067's ungated grant/policy statements DID land, and this
-- migration does not touch them.
--
-- Source docs:
--   * docs/10-architecture/15-security.md "Storage": `business-documents` is
--     private, access via signed URLs, TTL 5 min, and URL generation is
--     AUDIT-LOGGED (`document.url_signed`) - the only bucket with that last
--     requirement, because the objects are government IDs and permits.
--   * docs/30-modules/32-business-portal.md section 56: uploads land in
--     `business_documents`, private bucket, <= 20MB per doc, magic-byte sniffed.
--   * docs/20-data/21-schema-identity.md: the path convention this file fences.
--   * docs/30-modules/41-pwa-offline.md: `business-documents` is NetworkOnly /
--     never-cache. Nothing here enforces that - it is a service-worker rule -
--     but a future cache matcher must not quietly include this bucket.
--
-- Environment notes, all verified live before writing:
--   * storage.objects already has RLS enabled (owner supabase_storage_admin),
--     so this file does NOT run `alter table ... enable row level security`:
--     that would need ownership we do not have.
--   * storage.buckets carries `protect_buckets_delete` (BEFORE DELETE, FOR EACH
--     STATEMENT, storage.protect_delete) so a bucket row cannot be removed by
--     SQL once inserted. The insert is therefore idempotent
--     (`on conflict do nothing`) rather than delete-and-recreate, matching 0019
--     and 0064: replaying must never try to drop a live bucket and must never
--     clobber a limit tuned in the dashboard.
--   * storage.objects carries `protect_objects_delete`, the same statement
--     trigger, which refuses direct SQL deletes for EVERY role unless the
--     session GUC `storage.allow_delete_query` is 'true'. It fires above RLS.
--     The pgTAP suite pins that before it asserts anything about the DELETE
--     policy, or it would be measuring the trigger.
--   * file_size_limit and allowed_mime_types are enforced by the Storage API,
--     not by Postgres, and allowed_mime_types checks the DECLARED Content-Type,
--     never the bytes. They are a second fence. The server action magic-byte
--     sniffs, because a bucket setting cannot describe bytes that a lying
--     Content-Type header already got past.
-- ============================================================================

-- ============================================================ bucket
-- PRIVATE, and this is the one boolean that decides whether scans of Philippine
-- mayor's permits, DTI/SEC registrations, BIR 2303 forms and government IDs are
-- world-readable to anyone holding or guessing a URL. doc 15 puts this bucket on
-- the private list with a 5-minute signed-URL TTL and an audit-log requirement
-- on every URL minted. `avatars` (0064) is public and is NOT the model here;
-- 0019's `receipts` is.
--
-- file_size_limit 20971520 = 20 * 1024 * 1024, and it is NOT a number chosen
-- here. public.business_documents already carries
--   business_documents_size_bytes_check: (size_bytes > 0 and size_bytes <= 20971520)
-- from 0002, and doc 32 section 56 says the same. The bucket is set to agree
-- with the column rather than to a second opinion: a bucket that accepted 25MB
-- would let an object land that the row describing it could never be written
-- for, and a bucket that stopped at 10MB would reject a document the table says
-- is fine. Either way the merchant gets a refusal nobody can explain to them.
-- The pgTAP suite asserts the two against EACH OTHER, reading the bound out of
-- the live check constraint rather than restating 20971520 a third time.
--
-- allowed_mime_types is exactly what the wizard's own copy promises the
-- merchant ("PDF, JPG, or PNG") and what the upload action accepts. PDF is here
-- and is not here by accident: a permit is a scanned document and PDF is the
-- format a Philippine LGU or the BIR actually hands over.
--
-- image/svg+xml is ABSENT. Same reasoning as 0064, minus the part that does not
-- apply: this bucket is PRIVATE, so the stored-XSS-on-our-own-origin primitive
-- is already much weaker than it is for avatars. It stays out anyway, because a
-- signed URL is still an URL on the project's storage origin and an admin
-- reviewer opens these documents in a browser tab by design.
--
-- image/webp is ABSENT, unlike both other buckets: nothing produces a WebP scan
-- of a permit, and every format a merchant can actually obtain one in is here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'business-documents',
  'business-documents',
  false,
  20971520,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do nothing;

-- ============================================================ storage.objects
-- Object path convention (0002's column comment, doc 21):
--   business-documents/{business_id}/{uuid}.pdf
-- Inside the bucket the object `name` is therefore `{business_id}/{uuid}.{ext}`,
-- so the FIRST path segment is the owning TENANT and is the whole basis of
-- every policy below. This is the same shape as 0019 and 0064 with one
-- difference that changes everything about the predicate: those two fence on
-- `auth.uid()`, a value the policy already holds. This one fences on a
-- BUSINESS id, and whether the caller is staff of that business is a fact that
-- lives in a table.
--
-- ---------------------------------------------------------------------------
-- WHY `private.is_active_staff` AND NOT `private.is_staff_of`. READ THIS BEFORE
-- CHANGING EITHER NAME. The two are not synonyms and the difference is the
-- difference between a merchant being able to upload their permits and not.
--
--   private.is_staff_of(bid, roles)    -> private.jwt_biz_role(bid) = any(roles)
--                                      -> auth.jwt()->'app_metadata'->'biz'->>bid
--
-- is_staff_of reads the CALLER'S JWT CLAIMS. It is not SECURITY DEFINER and it
-- touches no table on its main path (only the `biz_overflow` fallback does, and
-- that read is itself un-elevated and therefore subject to business_staff's own
-- RLS). Doc 12's rule is "claims are hints, tables are truth", and this is
-- exactly the surface where that bites:
--
--   `register_business` creates the businesses row AND the business_staff owner
--   row in one call. The merchant's access token was minted at sign-up or
--   sign-in - BEFORE that staff row existed - so it carries no `biz` claim for
--   the business they registered four seconds ago. Documents are uploaded in
--   that same wizard. Under is_staff_of the owner of a brand new business is
--   refused access to their own tenant's folder, and the failure looks like a
--   permissions bug rather than a stale token.
--
--   private.is_active_staff(bid, roles) is SECURITY DEFINER with search_path
--   pinned to '', and reads public.business_staff directly for
--   (business_id, auth.uid(), status='active', role = any(roles)). It is the
--   table-truth form, and it is correct the instant the staff row is committed -
--   before any refresh, and whether or not the custom access token hook is
--   enabled at all.
--
-- src/app/(business)/business/(portal)/layout.tsx already made this exact
-- choice for the same reason, and says so: membership is resolved from
-- business_staff "so it is correct even before the custom access token hook
-- stamps biz claims into a user's JWT (or if the hook isn't enabled at all)".
-- This file agrees with the layout rather than with 0067's row policy.
--
-- CONSEQUENCE WORTH KNOWING: 0067's `business_docs_staff_insert` on the TABLE
-- uses is_staff_of, so the object write below and the row write above it do NOT
-- have the same admission rule. That asymmetry is real, it is not introduced
-- here, and this migration deliberately does not "fix" 0067's policy from
-- underneath a task that was told not to. The upload path handles it by
-- refreshing the session before it writes anything, and the orphan rule (object
-- first, row second, object removed if the row fails) is what makes a
-- claims-lag failure safe rather than corrupting. Aligning that policy onto
-- is_active_staff is an owed follow-up, recorded in supabase/README.md.
-- ---------------------------------------------------------------------------
--
-- THE CASE EXPRESSION IS NOT DECORATION. `is_active_staff` takes a uuid and the
-- path segment is attacker-influenced text, so it has to be cast, and
-- `'not-a-uuid'::uuid` RAISES 22P02 rather than evaluating false. In a SELECT
-- policy that is considerably worse than it sounds: one malformed object name
-- anywhere in the bucket would make every listing query error out for everyone,
-- and a policy that throws instead of denying is a policy whose failure mode
-- nobody has thought about.
--
-- Guarding with `and` would NOT be enough. Postgres does not promise
-- left-to-right evaluation of AND operands - the planner may reorder them by
-- cost - so a regex test sitting to the left of the cast is not a guarantee.
-- CASE is the one construct whose evaluation order the manual does guarantee,
-- so the cast is only ever reached for a segment already known to be a uuid.
-- Everything else yields NULL, is_active_staff(NULL, ...) finds no row, and the
-- fence FAILS CLOSED. `storage.foldername('bare.pdf')` is `{}`, so `[1]` is
-- NULL and a bare filename at the bucket root takes the same closed path.
--
-- The comparison is on the uuid VALUE, not a text prefix, so a folder named
-- `{business_id}-evil` is a different tenant and is refused - the same equality
-- property 0019 and 0064 spell out for their uid segment.

-- P1 (tenant, write half): an owner or manager may create objects ONLY under
-- their own business's segment. This is what stops the staff of business X
-- planting a document in business Y's folder that Y's verification round would
-- then be reviewed against.
--
-- The `array_length(...) = 1` depth pin matches 0019 and 0064 and is on the
-- WRITE policy, where the name is being chosen. A deeper path leaks nothing
-- (it is still inside the caller's own tenant prefix) but it lets the object
-- namespace drift away from the one convention 0002's column comment, the path
-- builder and the signed-URL generation all assume.
create policy business_docs_objects_staff_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'business-documents'
    and array_length(storage.foldername(name), 1) = 1
    and private.is_active_staff(
      case
        when (storage.foldername(name))[1] ~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(name))[1])::uuid
      end,
      array['owner', 'manager']
    )
  );

-- P1 (tenant, read half): owner/manager of that tenant only.
--
-- The BYTES are reached through short-lived signed URLs (doc 15: 5 minute TTL,
-- every generation audit-logged). This policy is what decides who may mint one
-- and who may enumerate the folder at all. `marketing` and `staff` are
-- deliberately excluded even though 0067's TABLE select policy admits them:
-- these are government IDs and tax registrations, the narrowest audience that
-- can do the job is the right one, and a shop-floor cashier has no reason to
-- read the owner's BIR 2303.
--
-- Platform admins do not appear here and do not need to: the admin verification
-- queue (doc 31) mints its signed URLs server-side through the service role,
-- which bypasses RLS, so its access is permission-checked and audit-logged in
-- application code rather than granted to a client session here.
create policy business_docs_objects_staff_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'business-documents'
    and private.is_active_staff(
      case
        when (storage.foldername(name))[1] ~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(name))[1])::uuid
      end,
      array['owner', 'manager']
    )
  );

-- P1 (tenant, remove half). THIS IS WHERE THIS FILE DEPARTS FROM 0019, AND WHY.
--
-- 0019 gives `receipts` no DELETE policy at all, permanently, because a receipt
-- image is EVIDENCE: its sha256 and pHash were computed at ingest and feed the
-- duplicate and fraud machinery, and a consumer must not be able to destroy the
-- image behind an approved award. None of that applies to a document a merchant
-- is still assembling:
--
--   1. Removal is a designed capability on this surface. The registration
--      wizard renders a "Remove {file}" button against every document in the
--      list. A fence that made that button a lie would be worse than no button.
--   2. The compensating delete in the upload path needs it. The orphan rule is
--      object first, row second, object removed if the row write fails - so
--      that a business_documents row never claims a document that is not there.
--      An orphaned OBJECT costs storage; an orphaned ROW costs a merchant their
--      approval, because it is the row an admin reviewer acts on and a signed
--      URL for a missing object is a queue item nobody can work.
--   3. Keeping this on the SESSION client is the point. With a DELETE policy
--      the cleanup runs as the merchant, fenced by this very predicate, and the
--      service role never touches a merchant-facing path. Without one the
--      cleanup would need to bypass RLS to delete an object it just created -
--      trading a narrow, checkable policy for a broad, unchecked capability.
--
-- There is deliberately NO UPDATE policy, and that half of 0019's reasoning
-- DOES carry over. Removal is visible: the object and its row go away together
-- and a reviewer sees a document that is missing. Replacement is not: an UPDATE
-- policy would let a merchant swap the bytes under a document an admin had
-- already read and approved, leaving `file_name`, `mime_type`, `size_bytes` and
-- the review decision all describing a file that is no longer there. Nothing in
-- this product needs to overwrite a document in place - re-uploading writes a
-- new object with a new uuid - so no policy is written for one.
create policy business_docs_objects_staff_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'business-documents'
    and private.is_active_staff(
      case
        when (storage.foldername(name))[1] ~
             '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(name))[1])::uuid
      end,
      array['owner', 'manager']
    )
  );

-- No policy of any kind is created for `anon`. There is no signed-out audience
-- for a bucket of government IDs, and the absence is the fence: `anon` holds
-- table-level DML on storage.objects by Supabase default (the pgTAP suite
-- asserts that explicitly), so RLS is the only thing refusing it and every
-- denial in the suite is a policy refusing an audience rather than a missing
-- grant.
