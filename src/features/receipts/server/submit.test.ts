// @vitest-environment node
//
// Doc 36 Stage 1 as a set of assertions. No Supabase, no Upstash, no sharp:
// the storage/database boundary is a hand-written fake and the image work is
// injected, which is exactly why `canonicalize` is a dependency of
// submitReceipt rather than a direct sharp import. The real sharp behaviour
// (EXIF stripping, the 32x32 grayscale shape) is asserted in image.test.ts
// against real bytes.

import { createHash } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// submit.ts reaches `src/lib/queue/publish.ts` for the enqueue, which reads
// `@/lib/env` - and that module validates the whole client environment at
// IMPORT time, so a test process with no .env.local cannot even load it.
// Mocked with an EMPTY server env deliberately: that is what an unconfigured
// deployment looks like, so the real `isQueueConfigured()` answers false and
// every test that does not inject the seam takes the inline path. The queue
// tests at the bottom of this file inject it explicitly.
vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => ({}),
}));

const createServiceRoleClient = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

import { isApiError } from "@/lib/api/errors";
import type { ApiError } from "@/lib/api/errors";
import { QUEUE_REGISTRY } from "@/lib/queue/queues";
import type { Database } from "@/lib/supabase/types";

import { dctPhash } from "../phash";
import { RECEIPT_MAX_BYTES } from "./image";
import type { CanonicalReceiptImage } from "./image";
import {
  RECEIPT_ERROR_CODES,
  requireServiceRoleClient,
  submitReceipt,
  submitReceiptBodySchema,
} from "./submit";
import type { SubmitReceiptBody } from "./submit";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const BUSINESS_ID = "33333333-3333-4333-8333-333333333333";
const DEVICE_ID = "44444444-4444-4444-8444-444444444444";
const RECEIPT_ID = "55555555-5555-4555-8555-555555555555";
const IMAGE_UUID = "0192f1a0-1b2c-4d3e-8f01-234567890abc";
const IMAGE_PATH = `${USER_ID}/${IMAGE_UUID}.jpg`;

// Bytes that pass the magic-byte sniff (JPEG SOI + a marker), standing in for
// whatever the consumer's phone uploaded.
function uploadedBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes.fill(0x41, 4);
  return bytes;
}

// The canonical JPEG the fake canonicalizer "produces": deliberately different
// from the uploaded bytes, because the whole point of the re-encode is that the
// stored bytes are not the submitted ones.
function canonicalBytes(): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set([0xff, 0xd8, 0xff, 0xdb], 0);
  bytes.fill(0x7a, 4);
  return bytes;
}

// A 32x32 grayscale gradient: real enough that dctPhash produces a non-trivial
// hash rather than the all-zero hash a flat image yields.
function canonicalGrayscale(): Uint8Array {
  const pixels = new Uint8Array(32 * 32);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      pixels[y * 32 + x] = (x * 7 + y * 3) % 256;
    }
  }
  return pixels;
}

const EXPECTED_SHA256 = createHash("sha256").update(canonicalBytes()).digest("hex");
const EXPECTED_IMAGE_HASH = dctPhash(canonicalGrayscale());

interface ReceiptInsertRow {
  user_id: string;
  business_id: string | null;
  status: string;
  source: string;
  image_path: string;
  image_hash: string;
  sha256: string;
  device_id: string | null;
  submitted_lat: number | null;
  submitted_lng: number | null;
  created_by: string;
  updated_by: string;
}

interface StorageUploadCall {
  path: string;
  body: Uint8Array;
  options: { contentType?: string; upsert?: boolean };
}

interface FakeOptions {
  consumer?: { gps_fraud_opt_in: boolean; scan_blocked_until: string | null } | null;
  consumerError?: PostgrestError | null;
  profile?: { is_suspended: boolean } | null;
  profileError?: PostgrestError | null;
  download?: Uint8Array | null;
  downloadError?: { statusCode?: number } | null;
  uploadError?: { statusCode?: number } | null;
  insertError?: PostgrestError | null;
}

interface Fake {
  client: SupabaseClient<Database>;
  inserts: ReceiptInsertRow[];
  uploads: StorageUploadCall[];
  downloads: string[];
  consumerReads: number;
  profileReads: number;
}

/**
 * A Blob over a copy of the bytes. The copy is what makes the type check:
 * `Uint8Array<ArrayBufferLike>` is not a `BlobPart` under this repo's strict
 * settings, since the backing buffer could in principle be a SharedArrayBuffer.
 */
function toBlob(bytes: Uint8Array): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer]);
}

function postgrestError(code: string, message: string, details = ""): PostgrestError {
  return { code, message, details, hint: "", name: "PostgrestError" } as PostgrestError;
}

function createFakeSupabase(options: FakeOptions = {}): Fake {
  const consumer =
    options.consumer === undefined
      ? { gps_fraud_opt_in: false, scan_blocked_until: null }
      : options.consumer;
  const profile = options.profile === undefined ? { is_suspended: false } : options.profile;

  const fake: Fake = {
    client: undefined as unknown as SupabaseClient<Database>,
    inserts: [],
    uploads: [],
    downloads: [],
    consumerReads: 0,
    profileReads: 0,
  };

  const client = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                fake.profileReads += 1;
                return options.profileError
                  ? { data: null, error: options.profileError }
                  : { data: profile, error: null };
              },
            }),
          }),
        };
      }
      if (table === "consumers") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                fake.consumerReads += 1;
                return options.consumerError
                  ? { data: null, error: options.consumerError }
                  : { data: consumer, error: null };
              },
            }),
          }),
        };
      }
      if (table === "receipts") {
        return {
          insert: (row: ReceiptInsertRow) => {
            fake.inserts.push(row);
            return {
              select: () => ({
                single: async () =>
                  options.insertError
                    ? { data: null, error: options.insertError }
                    : { data: { id: RECEIPT_ID }, error: null },
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table read: ${table}`);
    },
    storage: {
      from(bucket: string) {
        if (bucket !== "receipts") throw new Error(`unexpected bucket: ${bucket}`);
        return {
          download: async (path: string) => {
            fake.downloads.push(path);
            if (options.downloadError) {
              return { data: null, error: options.downloadError };
            }
            const bytes = options.download ?? uploadedBytes();
            return { data: toBlob(bytes), error: null };
          },
          upload: async (
            path: string,
            body: Uint8Array,
            uploadOptions: { contentType?: string; upsert?: boolean },
          ) => {
            fake.uploads.push({ path, body, options: uploadOptions });
            return options.uploadError
              ? { data: null, error: options.uploadError }
              : { data: { path }, error: null };
          },
        };
      },
    },
  };

  fake.client = client as unknown as SupabaseClient<Database>;
  return fake;
}

const canonicalize = vi.fn(
  async (): Promise<CanonicalReceiptImage> => ({
    jpeg: canonicalBytes(),
    grayscale: canonicalGrayscale(),
  }),
);

const processReceipt = vi.fn(async (): Promise<void> => undefined);

function body(overrides: Partial<SubmitReceiptBody> = {}): SubmitReceiptBody {
  return { image_path: IMAGE_PATH, ...overrides };
}

async function submit(
  fake: Fake,
  overrides: Partial<SubmitReceiptBody> = {},
  at?: Date,
): ReturnType<typeof submitReceipt> {
  return submitReceipt(
    { userId: USER_ID, body: body(overrides) },
    {
      supabase: fake.client,
      canonicalize,
      processReceipt,
      now: () => at ?? new Date(),
    },
  );
}

/** Assert a rejection is an ApiError and hand it back, strictly typed. */
async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) return error;
    throw error;
  }
  throw new Error("expected the submission to be rejected");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  canonicalize.mockImplementation(async () => ({
    jpeg: canonicalBytes(),
    grayscale: canonicalGrayscale(),
  }));
  processReceipt.mockImplementation(async () => undefined);
});

describe("submitReceipt - the happy path", () => {
  it("stores canonical bytes and inserts a queued scan receipt", async () => {
    const fake = createFakeSupabase();

    const result = await submit(fake, { business_id: BUSINESS_ID, device_id: DEVICE_ID });

    expect(result).toEqual({ receiptId: RECEIPT_ID, status: "queued" });

    // The object was overwritten in place with the canonical JPEG.
    expect(fake.uploads).toHaveLength(1);
    expect(fake.uploads[0]?.path).toBe(IMAGE_PATH);
    expect(fake.uploads[0]?.options).toEqual({ contentType: "image/jpeg", upsert: true });
    expect(Buffer.from(fake.uploads[0]?.body ?? new Uint8Array()).equals(Buffer.from(canonicalBytes()))).toBe(true);

    expect(fake.inserts).toHaveLength(1);
    expect(fake.inserts[0]).toEqual({
      user_id: USER_ID,
      business_id: BUSINESS_ID,
      status: "queued",
      source: "scan",
      image_path: IMAGE_PATH,
      image_hash: EXPECTED_IMAGE_HASH,
      sha256: EXPECTED_SHA256,
      device_id: DEVICE_ID,
      submitted_lat: null,
      submitted_lng: null,
      created_by: USER_ID,
      updated_by: USER_ID,
    });
  });

  it("hashes the CANONICAL bytes, not the uploaded ones", async () => {
    const fake = createFakeSupabase();
    await submit(fake);

    const uploadedHash = createHash("sha256").update(uploadedBytes()).digest("hex");
    expect(fake.inserts[0]?.sha256).toBe(EXPECTED_SHA256);
    expect(fake.inserts[0]?.sha256).not.toBe(uploadedHash);
  });

  it("never stores client_sha256, whatever the client claims", async () => {
    const fake = createFakeSupabase();
    const clientHash = "a".repeat(64);

    await submit(fake, { client_sha256: clientHash });

    expect(fake.inserts[0]?.sha256).toBe(EXPECTED_SHA256);
    const row = JSON.stringify(fake.inserts[0]);
    expect(row).not.toContain(clientHash);
  });

  it("hands the new receipt id to the processing stage", async () => {
    const fake = createFakeSupabase();
    await submit(fake);

    expect(processReceipt).toHaveBeenCalledExactlyOnceWith(RECEIPT_ID);
  });

  it("still returns 'queued' when processing throws, leaving the row retryable", async () => {
    const fake = createFakeSupabase();
    processReceipt.mockRejectedValueOnce(new Error("OCR service unreachable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(submit(fake)).resolves.toEqual({ receiptId: RECEIPT_ID, status: "queued" });
  });
});

describe("submitReceipt - image path ownership (doc 36 Stage 1 step 2)", () => {
  it("refuses another consumer's prefix with 403 and touches nothing", async () => {
    const fake = createFakeSupabase();

    const error = await expectApiError(
      submitReceipt(
        { userId: USER_ID, body: { image_path: `${OTHER_USER_ID}/${IMAGE_UUID}.jpg` } },
        { supabase: fake.client, canonicalize, processReceipt },
      ),
    );

    expect(error.status).toBe(403);
    expect(error.code).toBe("FORBIDDEN");
    // The check must come before any IO: the service-role client bypasses RLS,
    // so downloading first would already have read a stranger's object.
    expect(fake.consumerReads).toBe(0);
    expect(fake.downloads).toEqual([]);
    expect(fake.uploads).toEqual([]);
    expect(fake.inserts).toEqual([]);
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("refuses a nested path even inside the caller's own prefix", async () => {
    const fake = createFakeSupabase();

    const error = await expectApiError(
      submit(fake, { image_path: `${USER_ID}/nested/${IMAGE_UUID}.jpg` }),
    );

    expect(error.status).toBe(400);
    expect(error.code).toBe(RECEIPT_ERROR_CODES.RECEIPT_INVALID_IMAGE);
    expect(fake.downloads).toEqual([]);
  });

  it("refuses a filename this app did not issue", async () => {
    const fake = createFakeSupabase();

    for (const filename of ["receipt.jpg", "../secret.jpg", `${IMAGE_UUID}.png`, IMAGE_UUID]) {
      const error = await expectApiError(submit(fake, { image_path: `${USER_ID}/${filename}` }));
      expect(error.code).toBe(RECEIPT_ERROR_CODES.RECEIPT_INVALID_IMAGE);
    }
    expect(fake.inserts).toEqual([]);
  });

  it("refuses a bare object name with no prefix at all", async () => {
    const fake = createFakeSupabase();

    const error = await expectApiError(submit(fake, { image_path: `${IMAGE_UUID}.jpg` }));

    expect(error.status).toBe(403);
  });
});

describe("submitReceipt - account suspension (doc 30 section 2.8)", () => {
  // The brief's requirement 3: a suspended consumer must be refused even when
  // calling this money path directly, before any image work or IO runs. This
  // is doc 37's MORE severe ladder step (full lockout) than the cooldown
  // block below, so it is checked first.
  it("CRITICAL: refuses a suspended consumer's scan with 403 ACCOUNT_SUSPENDED, touching nothing downstream", async () => {
    const fake = createFakeSupabase({ profile: { is_suspended: true } });

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(403);
    expect(error.code).toBe("ACCOUNT_SUSPENDED");
    expect(fake.consumerReads).toBe(0);
    expect(fake.downloads).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it("does not affect an unsuspended consumer (the negative case)", async () => {
    const fake = createFakeSupabase({ profile: { is_suspended: false } });

    await expect(submit(fake)).resolves.toMatchObject({ status: "queued" });
  });

  it("fails CLOSED (503, refuses the scan) when suspension state cannot be read", async () => {
    const fake = createFakeSupabase({
      profileError: postgrestError("500", "connection reset"),
    });

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(503);
    expect(fake.inserts).toEqual([]);
  });
});

describe("submitReceipt - fraud cooldown (doc 37 ladder step 2)", () => {
  const now = new Date("2026-07-25T10:00:00.000Z");

  it("returns 403 CONSUMER_SCAN_BLOCKED with Retry-After while the cooldown holds", async () => {
    const fake = createFakeSupabase({
      consumer: {
        gps_fraud_opt_in: false,
        scan_blocked_until: new Date("2026-07-25T12:00:00.000Z").toISOString(),
      },
    });

    const error = await expectApiError(submit(fake, {}, now));

    expect(error.status).toBe(403);
    expect(error.code).toBe(RECEIPT_ERROR_CODES.CONSUMER_SCAN_BLOCKED);
    expect(error.headers?.["Retry-After"]).toBe(String(2 * 60 * 60));
    // Nothing downstream ran: the cooldown is checked before any image work.
    expect(fake.downloads).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it("rounds Retry-After up so an on-the-second retry is not refused again", async () => {
    const fake = createFakeSupabase({
      consumer: {
        gps_fraud_opt_in: false,
        scan_blocked_until: new Date(now.getTime() + 1500).toISOString(),
      },
    });

    const error = await expectApiError(submit(fake, {}, now));

    expect(error.headers?.["Retry-After"]).toBe("2");
  });

  it("never leaks why scanning is paused", async () => {
    const fake = createFakeSupabase({
      consumer: {
        gps_fraud_opt_in: false,
        scan_blocked_until: new Date(now.getTime() + 60_000).toISOString(),
      },
    });

    const error = await expectApiError(submit(fake, {}, now));

    for (const forbidden of ["fraud", "duplicate", "blocked", "signal"]) {
      expect(error.message.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("lets an elapsed cooldown through", async () => {
    const fake = createFakeSupabase({
      consumer: {
        gps_fraud_opt_in: false,
        scan_blocked_until: new Date(now.getTime() - 1).toISOString(),
      },
    });

    await expect(submit(fake, {}, now)).resolves.toMatchObject({ status: "queued" });
  });
});

describe("submitReceipt - GPS minimisation (doc 36 Stage 1, RA 10173)", () => {
  it("strips coordinates when the consumer has not opted in, without erroring", async () => {
    const fake = createFakeSupabase({
      consumer: { gps_fraud_opt_in: false, scan_blocked_until: null },
    });

    const result = await submit(fake, { submitted_lat: 14.5995, submitted_lng: 120.9842 });

    expect(result.status).toBe("queued");
    expect(fake.inserts[0]?.submitted_lat).toBeNull();
    expect(fake.inserts[0]?.submitted_lng).toBeNull();
  });

  it("stores coordinates when the consumer has opted in", async () => {
    const fake = createFakeSupabase({
      consumer: { gps_fraud_opt_in: true, scan_blocked_until: null },
    });

    await submit(fake, { submitted_lat: 14.5995, submitted_lng: 120.9842 });

    expect(fake.inserts[0]?.submitted_lat).toBe(14.5995);
    expect(fake.inserts[0]?.submitted_lng).toBe(120.9842);
  });

  it("drops a lone coordinate even for an opted-in consumer", async () => {
    const fake = createFakeSupabase({
      consumer: { gps_fraud_opt_in: true, scan_blocked_until: null },
    });

    await submit(fake, { submitted_lat: 14.5995 });

    expect(fake.inserts[0]?.submitted_lat).toBeNull();
    expect(fake.inserts[0]?.submitted_lng).toBeNull();
  });
});

describe("submitReceipt - image safety (doc 15)", () => {
  it("rejects bytes that are not one of the accepted formats", async () => {
    const fake = createFakeSupabase({
      download: new TextEncoder().encode("<?php echo 'not a receipt'; ?>"),
    });

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(400);
    expect(error.code).toBe(RECEIPT_ERROR_CODES.RECEIPT_INVALID_IMAGE);
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("rejects an object over the 10MB cap", async () => {
    const oversized = new Uint8Array(RECEIPT_MAX_BYTES + 1);
    oversized.set([0xff, 0xd8, 0xff, 0xe0], 0);
    const fake = createFakeSupabase({ download: oversized });

    const error = await expectApiError(submit(fake));

    expect(error.code).toBe(RECEIPT_ERROR_CODES.RECEIPT_INVALID_IMAGE);
    expect(fake.inserts).toEqual([]);
  });

  it("rejects an empty object", async () => {
    const fake = createFakeSupabase({ download: new Uint8Array(0) });

    const error = await expectApiError(submit(fake));

    expect(error.code).toBe(RECEIPT_ERROR_CODES.RECEIPT_INVALID_IMAGE);
  });

  it("maps a decoder failure to 400 rather than a 500", async () => {
    const fake = createFakeSupabase();
    canonicalize.mockRejectedValueOnce(new Error("unsupported image format"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(400);
    expect(error.code).toBe(RECEIPT_ERROR_CODES.RECEIPT_INVALID_IMAGE);
    expect(fake.uploads).toEqual([]);
    expect(fake.inserts).toEqual([]);
  });

  it("refuses to file a receipt when the canonical overwrite fails", async () => {
    // The original object still carries EXIF at this point, so proceeding would
    // store a receipt whose image retains the consumer's location.
    const fake = createFakeSupabase({ uploadError: { statusCode: 500 } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(503);
    expect(fake.inserts).toEqual([]);
  });

  it("treats a missing object as a client error and a storage outage as a 503", async () => {
    const missing = createFakeSupabase({ downloadError: { statusCode: 404 } });
    const missingError = await expectApiError(submit(missing));
    expect(missingError.status).toBe(400);
    expect(missingError.code).toBe(RECEIPT_ERROR_CODES.RECEIPT_INVALID_IMAGE);

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = createFakeSupabase({ downloadError: { statusCode: 500 } });
    const downError = await expectApiError(submit(down));
    expect(downError.status).toBe(503);
  });

  it("logs but does not reject when client_sha256 disagrees with the uploaded bytes", async () => {
    const fake = createFakeSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(submit(fake, { client_sha256: "b".repeat(64) })).resolves.toMatchObject({
      status: "queued",
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe("submitReceipt - duplicate detection (doc 36 Stage 1 step 4)", () => {
  it("maps a receipts_sha_unique violation to 422 RECEIPT_DUPLICATE", async () => {
    const fake = createFakeSupabase({
      insertError: postgrestError(
        "23505",
        'duplicate key value violates unique constraint "receipts_sha_unique"',
        `Key (sha256)=(${EXPECTED_SHA256}) already exists.`,
      ),
    });

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(422);
    expect(error.code).toBe(RECEIPT_ERROR_CODES.RECEIPT_DUPLICATE);
  });

  it("does NOT call a receipt number collision a duplicate submission", async () => {
    // receipts_number_unique is a different rule with a different outcome
    // (doc 36 Stage 8 rejects asynchronously with a fraud signal). A detector
    // that matched on "duplicate key" instead of the constraint name would
    // wrongly answer 422 RECEIPT_DUPLICATE here.
    const fake = createFakeSupabase({
      insertError: postgrestError(
        "23505",
        'duplicate key value violates unique constraint "receipts_number_unique"',
      ),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await expectApiError(submit(fake));

    expect(error.code).not.toBe(RECEIPT_ERROR_CODES.RECEIPT_DUPLICATE);
    expect(error.status).toBe(409);
  });

  it("maps an unknown business_id to a 422 naming the field", async () => {
    const fake = createFakeSupabase({
      insertError: postgrestError(
        "23503",
        'insert or update on table "receipts" violates foreign key constraint "receipts_business_id_fkey"',
      ),
    });

    const error = await expectApiError(submit(fake, { business_id: BUSINESS_ID }));

    expect(error.status).toBe(422);
    expect(error.details?.[0]?.field).toBe("business_id");
  });

  it("keeps an unrecognised database failure a 500 with no internal detail", async () => {
    const fake = createFakeSupabase({
      insertError: postgrestError("42501", 'permission denied for table "receipts"'),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(500);
    expect(error.message).not.toContain("permission denied");
  });
});

describe("submitReceipt - caller eligibility", () => {
  it("refuses a signed-in profile that is not a consumer", async () => {
    const fake = createFakeSupabase({ consumer: null });

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(403);
    expect(fake.downloads).toEqual([]);
  });

  it("returns a retryable 503 when the consumer read fails", async () => {
    const fake = createFakeSupabase({
      consumerError: postgrestError("57014", "canceling statement due to statement timeout"),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await expectApiError(submit(fake));

    expect(error.status).toBe(503);
  });
});

describe("submitReceiptBodySchema", () => {
  it("accepts the doc 36 Stage 1 body", () => {
    const parsed = submitReceiptBodySchema.safeParse({
      image_path: IMAGE_PATH,
      client_sha256: EXPECTED_SHA256,
      business_id: BUSINESS_ID,
      submitted_lat: 14.5995,
      submitted_lng: 120.9842,
      device_id: DEVICE_ID,
    });
    expect(parsed.success).toBe(true);
  });

  it("requires image_path and rejects malformed optional fields", () => {
    expect(submitReceiptBodySchema.safeParse({}).success).toBe(false);
    expect(
      submitReceiptBodySchema.safeParse({ image_path: IMAGE_PATH, client_sha256: "nope" }).success,
    ).toBe(false);
    expect(
      submitReceiptBodySchema.safeParse({ image_path: IMAGE_PATH, business_id: "nope" }).success,
    ).toBe(false);
    expect(
      submitReceiptBodySchema.safeParse({ image_path: IMAGE_PATH, submitted_lat: 91 }).success,
    ).toBe(false);
  });
});

describe("requireServiceRoleClient", () => {
  it("fails loudly with a 503 when the service-role key is unset", () => {
    createServiceRoleClient.mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      requireServiceRoleClient();
      throw new Error("expected a rejection");
    } catch (error) {
      expect(isApiError(error)).toBe(true);
      if (isApiError(error)) {
        expect(error.status).toBe(503);
        expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
      }
    }
  });

  it("returns the client when it is configured", () => {
    const client = createFakeSupabase().client;
    createServiceRoleClient.mockReturnValue(client);

    expect(requireServiceRoleClient()).toBe(client);
  });
});

// ===========================================================================
// The queue seam (doc 36 Stage 1 step 5 / Stage 2)
// ===========================================================================
//
// The blocks above exercise the DEGRADED path without meaning to, and that is
// worth stating rather than leaving as an accident: none of them inject
// `isQueueConfigured`, and this test process has no QSTASH_* environment, so
// the real predicate answers false and every one of them runs inline. That is
// the local-development contract - a deployment with no QStash still scans
// receipts - and the last test in this file asserts it explicitly rather than
// leaving it implied.

/** Submit with the queue seam wired. The default `submit` helper deliberately
 * leaves both queue dependencies at their real values. */
async function submitQueued(
  fake: Fake,
  queue: { enqueue: ReturnType<typeof vi.fn>; configured?: boolean },
  overrides: Partial<SubmitReceiptBody> = {},
): ReturnType<typeof submitReceipt> {
  return submitReceipt(
    { userId: USER_ID, body: body(overrides) },
    {
      supabase: fake.client,
      canonicalize,
      processReceipt,
      enqueue: queue.enqueue as never,
      isQueueConfigured: () => queue.configured ?? true,
    },
  );
}

const JOB_ID = "55555555-5555-4555-8555-555555555555";

function enqueued() {
  return { status: "enqueued", jobId: JOB_ID, published: true, messageId: "msg_1" } as const;
}

/** Every branch here logs; silencing is not the assertion, the calls are. */
function muteLogs(): void {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("submitReceipt - enqueueing ocr.process", () => {
  it("enqueues with the sha256 as the dedupe key and the receipt id as the whole payload", async () => {
    const fake = createFakeSupabase();
    const enqueue = vi.fn(async () => enqueued());
    muteLogs();

    await submitQueued(fake, { enqueue }, { business_id: BUSINESS_ID });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: "ocr.process",
        // Identifiers only: doc 39 forbids denormalized state in a payload.
        payload: { receipt_id: RECEIPT_ID },
        businessId: BUSINESS_ID,
        // Doc 36 Stage 1 step 5, and it is the SERVER hash over the canonical
        // bytes - the same value written to the row, so the dedupe key and
        // `receipts.sha256` can never describe different images.
        dedupeKey: EXPECTED_SHA256,
      }),
    );
    // The pipeline is the queue's work now.
    expect(processReceipt).not.toHaveBeenCalled();
  });

  it("carries doc 36's max_attempts of 3, its override of the column default 5", () => {
    // Not passed at the call site on purpose: `enqueue()` reads it from the
    // registry, the single place it can be stated once for the row, the
    // publisher and QStash's own Upstash-Retries header.
    expect(QUEUE_REGISTRY["ocr.process"].maxAttempts).toBe(3);
  });

  it("reuses the service-role client that just wrote the receipt", async () => {
    const fake = createFakeSupabase();
    const enqueue = vi.fn(async () => enqueued());
    muteLogs();

    await submitQueued(fake, { enqueue });

    // Which is what makes enqueue()'s own "no service-role client" failure
    // branch unreachable from this call site.
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ supabase: fake.client }));
  });

  it("still answers 202 with the same body", async () => {
    const fake = createFakeSupabase();
    muteLogs();

    // The response asserts a fact about the ROW, not about the delivery, which
    // is why it is identical on every branch in this file.
    await expect(
      submitQueued(fake, { enqueue: vi.fn(async () => enqueued()) }),
    ).resolves.toEqual({ receiptId: RECEIPT_ID, status: "queued" });
  });

  // A duplicate submission cannot double-process: `jobs_dedupe_idx` refuses the
  // second row while the first job is queued/running, and `enqueue` says so.
  it("does not process inline when an in-flight job already owns the receipt", async () => {
    const fake = createFakeSupabase();
    const enqueue = vi.fn(async () => ({ status: "deduplicated", jobId: "job-1" }) as const);
    muteLogs();

    await expect(submitQueued(fake, { enqueue })).resolves.toEqual({
      receiptId: RECEIPT_ID,
      status: "queued",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    // The work IS scheduled. Processing inline as well would be exactly the
    // double-processing the dedupe key exists to prevent.
    expect(processReceipt).not.toHaveBeenCalled();
  });
});

describe("submitReceipt - when the enqueue puts no delivery in flight", () => {
  // THE GAP THIS CLOSES: `sweep_stuck_receipts` (0028) only ever looks at
  // status='processing'. A receipt stranded at 'queued' is swept by nothing, so
  // answering 202 and hoping would be the one way in this system to lose a
  // receipt completely. Running it inline moves it to 'processing', which the
  // existing sweep already owns end to end.
  it("processes inline when the job row could not be written at all", async () => {
    const fake = createFakeSupabase();
    const enqueue = vi.fn(
      async () => ({ status: "failed", reason: "jobs table unreachable" }) as const,
    );
    muteLogs();

    await expect(submitQueued(fake, { enqueue })).resolves.toEqual({
      receiptId: RECEIPT_ID,
      status: "queued",
    });
    expect(processReceipt).toHaveBeenCalledExactlyOnceWith(RECEIPT_ID);
  });

  // The predicate is "is a delivery in flight", not "did the row get written".
  // Doc 39's hourly reconciler would re-publish this row, but only the receipts
  // half of it is built (0028), so today a durable row with no message strands
  // the receipt exactly as no row would.
  it("processes inline when the row landed but QStash refused the message", async () => {
    const fake = createFakeSupabase();
    const enqueue = vi.fn(
      async () =>
        ({ status: "enqueued", jobId: JOB_ID, published: false, messageId: null }) as const,
    );
    muteLogs();

    await expect(submitQueued(fake, { enqueue })).resolves.toEqual({
      receiptId: RECEIPT_ID,
      status: "queued",
    });
    expect(processReceipt).toHaveBeenCalledExactlyOnceWith(RECEIPT_ID);
  });

  // Never a 500. The row exists and its sha256 is already claimed, so telling
  // the consumer the submission was lost would invite a resubmission of the
  // same photo that `receipts_sha_unique` then refuses with a 422.
  it("never fails the request when the inline fallback also fails", async () => {
    const fake = createFakeSupabase();
    const enqueue = vi.fn(async () => ({ status: "failed", reason: "boom" }) as const);
    processReceipt.mockRejectedValueOnce(new Error("OCR service unreachable"));
    muteLogs();

    await expect(submitQueued(fake, { enqueue })).resolves.toEqual({
      receiptId: RECEIPT_ID,
      status: "queued",
    });
  });
});

describe("submitReceipt - a deployment with no QStash (doc 39 local development)", () => {
  it("processes inline and never touches the queue", async () => {
    const fake = createFakeSupabase();
    const enqueue = vi.fn();
    muteLogs();

    await expect(submitQueued(fake, { enqueue, configured: false })).resolves.toEqual({
      receiptId: RECEIPT_ID,
      status: "queued",
    });

    // Not even a jobs row: an unconfigured deployment must not accumulate one
    // undeliverable row per submission, which is a queue whose depth only grows.
    expect(enqueue).not.toHaveBeenCalled();
    expect(processReceipt).toHaveBeenCalledExactlyOnceWith(RECEIPT_ID);
  });

  it("names the path it took in the log, so nobody has to guess which one ran", async () => {
    const fake = createFakeSupabase();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await submitQueued(fake, { enqueue: vi.fn(), configured: false });

    expect(info.mock.calls.flat().join(" ")).toContain("INLINE");
  });

  it("is what the real env predicate selects here, with nothing injected", async () => {
    // This process has no QSTASH_* variables, so the real `isQueueConfigured`
    // runs. Every other test in this file depends on this being true.
    const fake = createFakeSupabase();
    muteLogs();

    await submit(fake);

    expect(processReceipt).toHaveBeenCalledExactlyOnceWith(RECEIPT_ID);
  });
});
