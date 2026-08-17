import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// The sniffer reaches @/features/receipts/server/image, which is `server-only`.
// That import is the fence keeping byte inspection off the client; here it just
// needs to be inert, same as every other server-module suite in this repo.
vi.mock("server-only", () => ({}));

import {
  BUSINESS_DOCUMENTS_BUCKET,
  BUSINESS_DOCUMENT_FOLDER_DEPTH,
  BUSINESS_DOCUMENT_MAX_BYTES,
  BUSINESS_DOCUMENT_MIME_TYPES,
  BUSINESS_DOCUMENT_TYPES,
  extensionForDocumentMimeType,
  isBusinessDocumentType,
  newBusinessDocumentPath,
} from "./documents";
import { sniffDocumentFormat } from "./server/document-format";

// ===========================================================================
// These constants describe a bucket and a table that live in SQL, so the
// assertions below read the SQL and compare against it rather than restating
// the same literals in a second place where they can quietly drift. Same
// technique as src/features/identity/avatar.test.ts, which parses 0064's
// predicates and asserts the path builder agrees with them.
//
// This matters more here than it usually would. `business-documents` did not
// exist until 0079, and the reason the feature was never built is that four
// documents and one column comment described a bucket nobody had created. A
// constant that merely LOOKS right is exactly what that failure was made of.
// ===========================================================================

const STORAGE_MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0079_business_documents_storage.sql"),
  "utf8",
);

const IDENTITY_MIGRATION = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0002_identity.sql"),
  "utf8",
);

/**
 * The migration with every `--` comment stripped.
 *
 * Necessary, not tidy: 0079's header EXPLAINS the is_staff_of / is_active_staff
 * choice at length, so it names both helpers in prose. An assertion run over the
 * raw file would be reading the explanation rather than the policy - it would
 * fail for a migration that is correct, and pass for one whose comment someone
 * had deleted. Only executable SQL is examined.
 */
function storageMigrationSql(): string {
  return STORAGE_MIGRATION.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** The `insert into storage.buckets (...) values (...)` tuple 0079 writes. */
function bucketInsertTuple(): string {
  const match = STORAGE_MIGRATION.match(/insert into storage\.buckets[\s\S]*?values\s*\(([\s\S]*?)\)\s*on conflict/);
  if (match?.[1] === undefined) throw new Error("0079 has no storage.buckets insert");
  return match[1];
}

describe("the constants agree with 0079_business_documents_storage.sql", () => {
  it("CRITICAL: names the bucket the migration actually creates", () => {
    expect(STORAGE_MIGRATION).toContain(`'${BUSINESS_DOCUMENTS_BUCKET}'`);
    expect(bucketInsertTuple()).toContain(`'${BUSINESS_DOCUMENTS_BUCKET}'`);
  });

  it("CRITICAL: the byte cap equals the bucket's file_size_limit", () => {
    const limit = bucketInsertTuple().match(/\bfalse,\s*(\d+)/)?.[1];
    expect(limit).toBeDefined();
    expect(Number(limit)).toBe(BUSINESS_DOCUMENT_MAX_BYTES);
  });

  it("CRITICAL: the byte cap also equals 0002's size_bytes check constraint", () => {
    // The third party to the same number. A bucket that accepted more than the
    // column allows would let an object land that its row could never be
    // written for; the pgTAP suite asserts these two against each other in the
    // database, and this asserts the application agrees with both.
    const bound = IDENTITY_MIGRATION.match(/size_bytes\s*>\s*0\s+and\s+size_bytes\s*<=\s*(\d+)/)?.[1];
    expect(bound).toBeDefined();
    expect(Number(bound)).toBe(BUSINESS_DOCUMENT_MAX_BYTES);
  });

  it("CRITICAL: the accepted mime types are exactly the bucket's allowed_mime_types", () => {
    const declared = bucketInsertTuple()
      .match(/array\[([^\]]*)\]/)?.[1]
      ?.split(",")
      .map((entry) => entry.trim().replace(/^'|'$/g, ""));

    expect(declared).toEqual([...BUSINESS_DOCUMENT_MIME_TYPES]);
  });

  it("CRITICAL: the folder depth matches the migration's own array_length pin", () => {
    expect(storageMigrationSql()).toContain(
      `array_length(storage.foldername(name), 1) = ${BUSINESS_DOCUMENT_FOLDER_DEPTH}`,
    );
  });

  it("resolves membership through the table-truth helper, not the claims one", () => {
    // Pinned from the application side as well as in pgTAP, because this is the
    // property that decides whether a merchant can upload documents in the
    // wizard that just created their business_staff row.
    expect(storageMigrationSql()).toContain("is_active_staff");
    expect(storageMigrationSql()).not.toMatch(/is_staff_of\s*\(/);
  });
});

describe("the doc types agree with the LIVE check constraint (0002, not dead 0067)", () => {
  it("CRITICAL: is exactly 0002's doc_type list", () => {
    const declared = IDENTITY_MIGRATION.match(
      /doc_type\s+text not null check \(doc_type in\s*\(([\s\S]*?)\)\)/,
    )?.[1]
      ?.split(",")
      .map((entry) => entry.trim().replace(/^'|'$/g, ""));

    expect(declared).toEqual([...BUSINESS_DOCUMENT_TYPES]);
  });

  it("CRITICAL: rejects 0067's doc types, which the database has never allowed", () => {
    // 0067_business_documents.sql is a dead file: its `create table if not
    // exists` hit 0002's table and did nothing. Its doc_type list is the single
    // most likely thing for a future reader to copy, because it is the newest
    // file with the obvious name. Every one of these violates
    // business_documents_doc_type_check.
    for (const dead of ["dti_permit", "mayor_permit", "bir_2303"]) {
      expect(isBusinessDocumentType(dead)).toBe(false);
    }
  });

  it("accepts the live values", () => {
    expect(isBusinessDocumentType("mayors_permit")).toBe(true);
    expect(isBusinessDocumentType("dti")).toBe(true);
    expect(isBusinessDocumentType("other")).toBe(true);
  });
});

describe("newBusinessDocumentPath", () => {
  const BUSINESS_ID = "9d1f0a4e-3b2c-4d5e-8f60-112233445566";

  it("builds {business_id}/{uuid}.{ext}, one level deep", () => {
    const path = newBusinessDocumentPath(BUSINESS_ID, "application/pdf");

    expect(path).toMatch(
      /^9d1f0a4e-3b2c-4d5e-8f60-112233445566\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/,
    );
    expect(path.split("/")).toHaveLength(BUSINESS_DOCUMENT_FOLDER_DEPTH + 1);
  });

  it("CRITICAL: never derives the filename from anything the merchant supplied", () => {
    // A client-supplied name is a path-traversal and overwrite primitive: it
    // would decide which object a write lands on, which is the whole
    // authorization decision the storage policy makes. Doc 15: "filename
    // regenerated to UUID, never user-controlled paths".
    const first = newBusinessDocumentPath(BUSINESS_ID, "image/png");
    const second = newBusinessDocumentPath(BUSINESS_ID, "image/png");

    expect(first).not.toBe(second);
  });

  it("gives each accepted type its own extension", () => {
    expect(newBusinessDocumentPath(BUSINESS_ID, "image/jpeg").endsWith(".jpg")).toBe(true);
    expect(newBusinessDocumentPath(BUSINESS_ID, "image/png").endsWith(".png")).toBe(true);
    expect(extensionForDocumentMimeType("application/pdf")).toBe("pdf");
  });
});

// --------------------------------------------------------------- magic bytes

// At least 12 bytes each: sniffImageFormat refuses anything shorter, because
// its WebP branch reads a form type at offset 8. Real uploads are never near
// that short, but a fixture that was would make these assertions pass for "too
// small to tell" rather than for the signature.
const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3,
]);
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00,
]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const SVG = new Uint8Array([...Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'>")]);

describe("sniffDocumentFormat", () => {
  it("identifies the three accepted formats by their signatures", () => {
    expect(sniffDocumentFormat(PDF)).toBe("application/pdf");
    expect(sniffDocumentFormat(JPEG)).toBe("image/jpeg");
    expect(sniffDocumentFormat(PNG)).toBe("image/png");
  });

  it("CRITICAL: refuses SVG bytes however they are declared", () => {
    // The bucket's allowed_mime_types checks the DECLARED Content-Type and
    // never the bytes, so a caller can send SVG markup labelled image/png and
    // the bucket will take it. This is the layer that sees bytes, and an admin
    // reviewer opens these documents in a browser tab.
    expect(sniffDocumentFormat(SVG)).toBeNull();
  });

  it("CRITICAL: refuses WebP, which the bucket does not allow either", () => {
    // WebP is accepted by the avatars and receipts buckets, so a sniffer shared
    // with them would wave it through here and produce an upload the bucket
    // then rejects for a reason the merchant cannot see.
    expect(sniffDocumentFormat(WEBP)).toBeNull();
  });

  it("refuses empty and truncated input rather than guessing", () => {
    expect(sniffDocumentFormat(new Uint8Array([]))).toBeNull();
    expect(sniffDocumentFormat(new Uint8Array([0x25, 0x50]))).toBeNull();
  });

  it("CRITICAL: every format it accepts is one the bucket allows", () => {
    // The pairing assertion. Without it, a sniffer that recognised more formats
    // than the bucket takes would pass every test above individually.
    for (const bytes of [PDF, JPEG, PNG]) {
      const sniffed = sniffDocumentFormat(bytes);
      expect(sniffed).not.toBeNull();
      expect([...BUSINESS_DOCUMENT_MIME_TYPES]).toContain(sniffed);
    }
  });
});
