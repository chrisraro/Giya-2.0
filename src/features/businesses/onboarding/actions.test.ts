import { describe, expect, it, vi, beforeEach } from "vitest";

// ===========================================================================
// The verification-document upload.
//
// Until 0079 there was nowhere to put these bytes: the `business-documents`
// bucket was named by 0002's column comment and four documents and had never
// been created. The wizard's file list was a client-side array with a
// `TODO(api): replace mock (no real upload; client-side list only)` over it.
//
// THE ORDERING RULE THIS FILE PINS. Object first, row second, and the object is
// REMOVED if the row write fails. The two harms are not symmetrical:
//
//   an orphaned OBJECT costs storage and nothing else;
//   an orphaned ROW costs a merchant their approval, because the row is what an
//   admin reviewer works from and a signed URL for a missing object is a queue
//   item nobody can action.
//
// So a `business_documents` row must never claim a document that is not there,
// and that is asserted in both directions below.
// ===========================================================================

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  resolveStaffContext: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  storageFrom: vi.fn(),
  insert: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: mocks.from,
    storage: { from: mocks.storageFrom },
  })),
}));

vi.mock("@/features/businesses/server/resolve-owner-business", () => ({
  resolveStaffContext: mocks.resolveStaffContext,
  BUSINESS_ROLES: ["owner", "manager", "marketing", "staff"],
}));

const { uploadVerificationDocument } = await import("./actions");
const { BUSINESS_DOCUMENTS_BUCKET } = await import("./documents");

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

const BUSINESS_ID = "9d1f0a4e-3b2c-4d5e-8f60-112233445566";
const OTHER_BUSINESS = "0000aaaa-1111-4111-8111-222233334444";

const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3,
]);
const SVG_BYTES = new Uint8Array([...Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")]);

/**
 * One picked document, the way the wizard submits it.
 *
 * The declared type defaults to a LIE in the SVG cases below on purpose: the
 * bucket's `allowed_mime_types` checks exactly this header and never the bytes,
 * so an assertion that could not tell "we sniffed" from "we echoed the browser"
 * would not be testing the fence that matters.
 */
function documentForm({
  bytes = PDF_BYTES,
  type = "application/pdf",
  name = "mayors-permit.pdf",
  docType = "mayors_permit",
  businessId,
}: {
  bytes?: Uint8Array;
  type?: string;
  name?: string;
  docType?: string;
  businessId?: string;
} = {}): FormData {
  const form = new FormData();
  form.set("document", new File([bytes as unknown as BlobPart], name, { type }));
  form.set("docType", docType);
  if (businessId !== undefined) form.set("businessId", businessId);
  return form;
}

/** The object path the action asked storage to write. */
function uploadedPath(): string {
  return mocks.upload.mock.calls[0]?.[0] as string;
}

/** The row the action asked Postgres to insert. */
function insertedRow(): Record<string, unknown> {
  return mocks.insert.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.resolveStaffContext.mockResolvedValue({
    userId: "user-1",
    businessId: BUSINESS_ID,
    businessName: "Kape Diaria",
    businessSlug: "kape-diaria",
    businessStatus: "draft",
    role: "owner",
  });

  mocks.upload.mockResolvedValue({ data: { path: "x" }, error: null });
  mocks.remove.mockResolvedValue({ data: [], error: null });
  mocks.storageFrom.mockReturnValue({ upload: mocks.upload, remove: mocks.remove });

  mocks.insert.mockReturnValue({
    select: () => ({
      single: async () => ({ data: { id: "doc-1" }, error: null }),
    }),
  });
  mocks.from.mockImplementation((table: string) => {
    if (table === "business_documents") return { insert: mocks.insert };
    throw new Error(`unexpected table: ${table}`);
  });
});

describe("who may upload", () => {
  it("CRITICAL: refuses a caller who is not an owner or manager, before touching storage", async () => {
    mocks.resolveStaffContext.mockResolvedValue(null);

    const result = await uploadVerificationDocument(documentForm());

    expect(result.ok).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("asks for owner/manager specifically, not merely for membership", async () => {
    await uploadVerificationDocument(documentForm());

    expect(mocks.resolveStaffContext).toHaveBeenCalledWith(["owner", "manager"]);
  });

  it("CRITICAL: takes the business id from the SERVER context, never from the form", async () => {
    // The form field below names somebody else's tenant. If it were trusted,
    // this action would be a cross-tenant write primitive: 0079's storage
    // policy and 0067's row policy would both refuse it, but a server action is
    // a public endpoint and must not be the thing relying on that.
    await uploadVerificationDocument(documentForm({ businessId: OTHER_BUSINESS }));

    expect(uploadedPath().startsWith(`${BUSINESS_ID}/`)).toBe(true);
    expect(uploadedPath()).not.toContain(OTHER_BUSINESS);
    expect(insertedRow().business_id).toBe(BUSINESS_ID);
  });
});

describe("what reaches the bucket", () => {
  it("uploads into the business-documents bucket under {business_id}/{uuid}.{ext}", async () => {
    await uploadVerificationDocument(documentForm());

    expect(mocks.storageFrom).toHaveBeenCalledWith(BUSINESS_DOCUMENTS_BUCKET);
    expect(uploadedPath()).toMatch(
      new RegExp(`^${BUSINESS_ID}/[0-9a-f-]{36}\\.pdf$`),
    );
  });

  it("CRITICAL: tags the object with the SNIFFED type, not the declared one", async () => {
    // A PDF announced as image/png. The bucket's allowed_mime_types trusts the
    // declared header, so echoing `file.type` would store a document whose
    // stored content type is a lie an admin's browser then acts on.
    await uploadVerificationDocument(documentForm({ type: "image/png" }));

    expect(mocks.upload.mock.calls[0]?.[2]).toMatchObject({
      contentType: "application/pdf",
      upsert: false,
    });
  });

  it("CRITICAL: never overwrites an existing object", async () => {
    await uploadVerificationDocument(documentForm());

    expect(mocks.upload.mock.calls[0]?.[2]).toMatchObject({ upsert: false });
  });

  it("CRITICAL: refuses SVG bytes wearing an accepted content type, with no upload at all", async () => {
    const result = await uploadVerificationDocument(
      documentForm({ bytes: SVG_BYTES, type: "image/png", name: "permit.png" }),
    );

    expect(result.ok).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("refuses an oversize file before uploading it", async () => {
    const huge = new File([PDF_BYTES as unknown as BlobPart], "big.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(huge, "size", { value: 20971521 });
    const form = new FormData();
    form.set("document", huge);
    form.set("docType", "mayors_permit");

    const result = await uploadVerificationDocument(form);

    expect(result.ok).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("refuses an empty pick", async () => {
    const form = new FormData();
    form.set("docType", "mayors_permit");

    expect((await uploadVerificationDocument(form)).ok).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

describe("the row it writes", () => {
  it("CRITICAL: writes 0002's columns, and none of dead 0067's", async () => {
    await uploadVerificationDocument(documentForm());

    const row = insertedRow();
    expect(row).toMatchObject({
      business_id: BUSINESS_ID,
      doc_type: "mayors_permit",
      file_name: "mayors-permit.pdf",
      mime_type: "application/pdf",
      size_bytes: PDF_BYTES.length,
    });
    expect(row.storage_path).toBe(uploadedPath());

    // 0067 is a dead file whose `create table if not exists` did nothing. These
    // columns do not exist, and naming any of them makes the insert fail live
    // while every mock-based test still passes.
    expect(row).not.toHaveProperty("file_path");
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("revision_note");
  });

  it("CRITICAL: refuses a doc_type the live check constraint forbids", async () => {
    // `dti_permit` is 0067's spelling. The live constraint allows `dti`.
    const result = await uploadVerificationDocument(documentForm({ docType: "dti_permit" }));

    expect(result.ok).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("records the size from the bytes it actually read", async () => {
    await uploadVerificationDocument(documentForm());

    expect(insertedRow().size_bytes).toBe(PDF_BYTES.length);
  });
});

describe("the orphan rule", () => {
  it("CRITICAL: removes the uploaded object when the row write fails", async () => {
    mocks.insert.mockReturnValue({
      select: () => ({
        single: async () => ({
          data: null,
          error: { message: 'new row violates row-level security policy' },
        }),
      }),
    });

    const result = await uploadVerificationDocument(documentForm());

    expect(result.ok).toBe(false);
    // The object must not survive the row that was supposed to describe it.
    expect(mocks.remove).toHaveBeenCalledWith([uploadedPath()]);
  });

  it("CRITICAL: does not remove the object when the row landed", async () => {
    // The negative half. Without it, an implementation that removed the object
    // unconditionally would satisfy the assertion above and delete every
    // document it ever stored.
    const result = await uploadVerificationDocument(documentForm());

    expect(result.ok).toBe(true);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("still reports failure when the cleanup itself fails", async () => {
    mocks.insert.mockReturnValue({
      select: () => ({ single: async () => ({ data: null, error: { message: "denied" } }) }),
    });
    mocks.remove.mockResolvedValue({ data: null, error: { message: "storage unreachable" } });

    const result = await uploadVerificationDocument(documentForm());

    expect(result.ok).toBe(false);
    // Best effort, and the leftover object is logged rather than surfaced: the
    // merchant can act on "the document did not save", not on an orphan.
    expect(consoleError).toHaveBeenCalled();
  });

  it("does not leak the database's own message to the merchant", async () => {
    mocks.insert.mockReturnValue({
      select: () => ({
        single: async () => ({
          data: null,
          error: { message: 'new row violates row-level security policy for table "objects"' },
        }),
      }),
    });

    const result = await uploadVerificationDocument(documentForm());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("row-level security");
    expect(consoleError).toHaveBeenCalled();
  });
});
