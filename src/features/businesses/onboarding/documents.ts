// ===========================================================================
// The verification-document upload contract: the bucket, its limits, the
// tenant-scoped object path, and what the bytes actually are.
//
// Pure. No server, DB or React imports - same rule as ./wizard-hours.ts and
// ../settings/hours.ts - so the wizard can import the accept list and the size
// cap without dragging a Supabase client into a jsdom render.
//
// WRITTEN AGAINST 0002_identity.sql AND 0079_business_documents_storage.sql.
// NOT against 0067_business_documents.sql, which is a dead file: its
// `create table if not exists` hit the table 0002 had already created and
// contributed nothing, so `file_path`, `status` and `revision_note` do not
// exist and its doc_type list (`dti_permit`, `mayor_permit`, `bir_2303`) has
// never been accepted by `business_documents_doc_type_check`. It is the newest
// file with the obvious name and therefore the one most likely to be copied.
// documents.test.ts parses both real migrations and asserts these constants
// against them, so the agreement is checked rather than remembered.
// ===========================================================================

/** Created by 0079. Private: reads go through short-lived signed URLs (doc 15). */
export const BUSINESS_DOCUMENTS_BUCKET = "business-documents";

/**
 * 20MB. This number is NOT chosen here. It is
 * `business_documents_size_bytes_check` from 0002 (`size_bytes <= 20971520`)
 * and 0079's `file_size_limit`, and doc 32 section 56 states it too. Three
 * places, one value; the test asserts all three agree, because a bucket that
 * accepted more than the column allows would let an object land that its row
 * could never be written for, and a merchant would get a rejection nobody could
 * explain to them.
 */
export const BUSINESS_DOCUMENT_MAX_BYTES = 20971520;

/**
 * Exactly 0079's `allowed_mime_types`, and exactly what the wizard's copy
 * promises ("PDF, JPG, or PNG").
 *
 * PDF leads because it is what a Philippine LGU or the BIR actually hands over.
 * `image/webp` is absent even though the avatars and receipts buckets accept it
 * (nothing produces a WebP scan of a permit) and `image/svg+xml` is absent
 * because an admin reviewer opens these in a browser tab.
 */
export const BUSINESS_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

export type BusinessDocumentMimeType = (typeof BUSINESS_DOCUMENT_MIME_TYPES)[number];

/**
 * Exactly `business_documents_doc_type_check` as 0002 wrote it and as the live
 * database enforces it. Order matches the constraint so the test can compare
 * the two lists directly.
 */
export const BUSINESS_DOCUMENT_TYPES = [
  "business_permit",
  "mayors_permit",
  "tin",
  "dti",
  "sec",
  "sample_receipt",
  "other",
] as const;

export type BusinessDocumentType = (typeof BUSINESS_DOCUMENT_TYPES)[number];

/**
 * Labels for the picker, so a merchant chooses "Mayor's Permit" rather than
 * `mayors_permit`. Doc 32 section 56 asks for PH-specific guidance on this
 * picker; these are the names on the documents themselves.
 */
export const BUSINESS_DOCUMENT_TYPE_LABELS: Record<BusinessDocumentType, string> = {
  business_permit: "Business permit",
  mayors_permit: "Mayor's permit",
  tin: "TIN or BIR 2303",
  dti: "DTI registration",
  sec: "SEC registration",
  sample_receipt: "Sample receipt",
  other: "Other document",
};

/** Folder levels in an object name, i.e. `array_length(foldername(name), 1)`. */
export const BUSINESS_DOCUMENT_FOLDER_DEPTH = 1;

/** Runtime check, because a doc_type can arrive from a form and TypeScript is not a fence. */
export function isBusinessDocumentType(value: string): value is BusinessDocumentType {
  return (BUSINESS_DOCUMENT_TYPES as readonly string[]).includes(value);
}

const EXTENSIONS: Record<BusinessDocumentMimeType, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function extensionForDocumentMimeType(mimeType: BusinessDocumentMimeType): string {
  return EXTENSIONS[mimeType];
}

/**
 * A fresh object name for one upload: `{business_id}/{uuid}.{ext}`, which is
 * the convention 0002's column comment states and 0079's policies fence on.
 *
 * The uuid is minted HERE and the filename is never derived from anything the
 * merchant supplied. A client-supplied name is a path-traversal and overwrite
 * primitive: it would decide which object a write lands on, which is the whole
 * authorization decision the storage policy makes. Doc 15: "filename
 * regenerated to UUID, never user-controlled paths". The original name is kept,
 * but as DATA in `business_documents.file_name`, where an admin reviewer can
 * read it and no path resolves against it.
 */
export function newBusinessDocumentPath(
  businessId: string,
  mimeType: BusinessDocumentMimeType,
): string {
  return `${businessId}/${crypto.randomUUID()}.${extensionForDocumentMimeType(mimeType)}`;
}
