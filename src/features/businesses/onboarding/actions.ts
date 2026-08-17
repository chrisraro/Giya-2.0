"use server";

import { toErrorMessage } from "@/lib/auth/error-message";
import { createClient } from "@/lib/supabase/server";

import { resolveStaffContext } from "../server/resolve-owner-business";
import {
  BUSINESS_DOCUMENTS_BUCKET,
  BUSINESS_DOCUMENT_MAX_BYTES,
  isBusinessDocumentType,
  newBusinessDocumentPath,
} from "./documents";
import { sniffDocumentFormat } from "./server/document-format";

// ===========================================================================
// Verification-document upload, for the registration wizard's third step.
//
// This could not be built before 0079_business_documents_storage.sql. The
// `business_documents` TABLE has existed since 0002, but the private
// `business-documents` BUCKET its `storage_path` column points into had never
// been created - named in a column comment and in four documents, deployed
// nowhere. The wizard's file list was a client-side array with
// `TODO(api): replace mock (no real upload; client-side list only)` over it.
//
// WRITTEN AGAINST 0002's SCHEMA. `storage_path`, `file_name`, `mime_type`,
// `size_bytes`. NOT 0067's `file_path` / `status` / `revision_note`, which do
// not exist: 0067's `create table if not exists` hit 0002's table and
// contributed nothing. It is the newest file with the obvious name, so the test
// asserts the absence of those three keys as well as the presence of these four.
// ===========================================================================

/** Owner and manager only, matching 0079's storage policies. */
const UPLOAD_ROLES = ["owner", "manager"] as const;

const NOT_ALLOWED = "Only an owner or manager can upload verification documents.";
const UPLOAD_FAILED = "We could not save that document. Try again in a moment.";

export type DocumentUploadResult =
  | { ok: true; documentId: string; storagePath: string }
  | { ok: false; message: string };

/**
 * Log the infrastructure failure, return the merchant's sentence.
 *
 * The database's own message is never the return value, matching
 * src/features/identity/actions.ts. A Postgres or Storage error reads
 * `new row violates row-level security policy for table "objects"`; that is
 * schema leakage and it is not something a merchant can act on. The detail goes
 * where the person who can act on it is looking.
 */
function infrastructureFailure(scope: string, error: unknown): string {
  console.error(`[business-documents] ${scope}`, toErrorMessage(error), error);
  return UPLOAD_FAILED;
}

/**
 * The merchant's own filename, kept as DATA so an admin reviewer sees what they
 * sent. Never used to build a path - `newBusinessDocumentPath` mints a uuid -
 * so this is about keeping a column tidy rather than about traversal: slashes
 * are stripped because a name containing one reads like a path and would
 * eventually be treated as one, and the length is bounded because nothing
 * downstream should have to.
 */
function safeFileName(name: string): string {
  const flattened = name.replaceAll(/[/\\]/g, "-").trim();
  return (flattened === "" ? "document" : flattened).slice(0, 200);
}

/**
 * Uploads one verification document and records it.
 *
 * Takes FormData because the payload is a file: React serializes a File across
 * the action boundary inside FormData and nowhere else.
 *
 * THE BUSINESS ID IS NEVER READ FROM THE FORM. It comes from
 * `resolveStaffContext`, which resolves the caller's own membership from
 * `business_staff`. A server action is a public endpoint, and a client-supplied
 * tenant id would make this a cross-tenant write primitive: 0079's storage
 * policy and 0067's row policy would both refuse it, but the fence a caller can
 * name must not be the only one.
 *
 * THE UPLOAD RUNS ON THE SESSION CLIENT, not the service role, deliberately and
 * for the same reason `saveConsumerAvatar` does: `upload` needs `insert` on
 * storage.objects, so 0079's tenant-prefix policy is evaluated against the
 * caller. Even if the path construction were wrong, Postgres would refuse to
 * write into another merchant's folder. The service role would bypass exactly
 * the fence that makes this safe.
 *
 * ORDERING, AND THE ORPHAN RULE. Object first, row second, object removed if
 * the row fails. The two failures are not symmetrical: an orphaned OBJECT costs
 * storage, while an orphaned ROW costs a merchant their approval, because the
 * row is what an admin reviewer works from and a signed URL for a missing
 * object is a queue item nobody can action. So a `business_documents` row must
 * never claim a document that is not there, and the compensating delete is what
 * guarantees it. That delete runs on the SESSION client too, against 0079's
 * DELETE policy - which is why that policy exists at all, and why this path
 * needs no elevated privilege anywhere.
 */
export async function uploadVerificationDocument(
  formData: FormData,
): Promise<DocumentUploadResult> {
  const context = await resolveStaffContext([...UPLOAD_ROLES]);
  if (context === null) return { ok: false, message: NOT_ALLOWED };

  const docType = formData.get("docType");
  if (typeof docType !== "string" || !isBusinessDocumentType(docType)) {
    // Checked at runtime, not only in the type: `business_documents_doc_type_check`
    // is the real fence and this is the one in front of it, so 0067's spellings
    // (`dti_permit`, `mayor_permit`, `bir_2303`) are refused here with a sentence
    // rather than as a constraint violation with a Postgres message attached.
    return { ok: false, message: "Choose what kind of document this is, then upload it." };
  }

  const file = formData.get("document");
  if (file === null || typeof file === "string" || file.size === 0) {
    return { ok: false, message: "Pick a document first." };
  }

  if (file.size > BUSINESS_DOCUMENT_MAX_BYTES) {
    return {
      ok: false,
      message: `Documents here can be up to ${Math.floor(BUSINESS_DOCUMENT_MAX_BYTES / (1024 * 1024))}MB.`,
    };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // THE FENCE THAT SEES BYTES. The bucket's `allowed_mime_types` checks the
  // declared Content-Type, which is whatever the browser put on the multipart
  // part, so it is a second fence and not the truth. `file.type` is never used
  // below for anything.
  const mimeType = sniffDocumentFormat(bytes);
  if (mimeType === null) {
    return { ok: false, message: "Upload a PDF, JPG, or PNG." };
  }

  const storagePath = newBusinessDocumentPath(context.businessId, mimeType);

  const supabase = await createClient();

  const { error: uploadError } = await supabase.storage
    .from(BUSINESS_DOCUMENTS_BUCKET)
    .upload(storagePath, bytes, {
      // The SNIFFED type, so the stored content type describes the bytes rather
      // than repeating the browser's claim about them. An admin reviewer opens
      // these in a browser tab, and the tab acts on this header.
      contentType: mimeType,
      // A fresh uuid per upload means there is nothing to overwrite; `false`
      // makes a collision an error rather than a silent replacement of a
      // document somebody may already have reviewed.
      upsert: false,
    });

  if (uploadError) {
    return { ok: false, message: infrastructureFailure("upload failed", uploadError) };
  }

  const { data: inserted, error: rowError } = await supabase
    .from("business_documents")
    .insert({
      business_id: context.businessId,
      doc_type: docType,
      storage_path: storagePath,
      file_name: safeFileName(file.name),
      mime_type: mimeType,
      // From the bytes actually read, not from `file.size`, so the column and
      // the object cannot disagree about the same upload.
      size_bytes: bytes.length,
      created_by: context.userId,
      updated_by: context.userId,
    })
    .select("id")
    .single();

  if (rowError || inserted === null) {
    // The object landed and nothing points at it. Remove it rather than leave a
    // reviewer a document with no record, or - worse, once a retry succeeds - a
    // duplicate of a document that IS recorded.
    const { error: cleanupError } = await supabase.storage
      .from(BUSINESS_DOCUMENTS_BUCKET)
      .remove([storagePath]);

    if (cleanupError) {
      // Best effort. Logged, never surfaced: the merchant can act on "the
      // document did not save", and an orphaned object is an operational
      // problem for us rather than a second sentence for them.
      console.error(
        "[business-documents] could not remove an object after a failed row write",
        storagePath,
        cleanupError,
      );
    }

    return { ok: false, message: infrastructureFailure("row write failed", rowError) };
  }

  return { ok: true, documentId: inserted.id, storagePath };
}
