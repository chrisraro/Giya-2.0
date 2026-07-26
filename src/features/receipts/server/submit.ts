import "server-only";

import { createHash } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import type { ErrorDetail } from "@/lib/api/errors";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

import { dctPhash } from "../phash";
import { RECEIPT_MAX_BYTES, sniffImageFormat } from "./image";
import type { CanonicalizeReceiptImage } from "./image";

// Stage 1 of docs/30-modules/36-receipt-ocr-pipeline.md: everything between
// "the consumer's bytes are in the bucket" and "a queued receipts row exists".
//
// The ordering below is the specification's, and each step is here because it
// is the last moment the property it guards can still be established:
//
//   1. path ownership   - the ONLY thing tying the object to this caller
//   2. cooldown         - doc 37 ladder step 2, before any work is done
//   3. download + sniff - the declared content type is attacker-controlled
//   4. canonicalize     - strips EXIF/GPS; after this the bytes are ours
//   5. sha256 + pHash   - over the CANONICAL bytes, which is what is stored
//   6. insert           - service role, since receipts has no client insert
//   7. process          - synchronous today, a queue enqueue tomorrow
//
// EVERY write here goes through the service-role client. That is not a
// convenience: supabase/migrations/0017_receipts.sql gives `receipts` no client
// insert, update or delete policy at all, and a column-level select grant for
// only 13 columns, precisely so that fraud scoring and points award cannot be
// bypassed by a client writing its own row. A session-scoped client physically
// cannot perform the insert below.

/** Bucket from supabase/migrations/0019_receipts_storage.sql. */
export const RECEIPTS_BUCKET = "receipts";

/**
 * Error codes this module registers, per doc 36's "Error codes registered by
 * this module" table and doc 37's `CONSUMER_SCAN_BLOCKED` row. They extend
 * API_ERROR_CODES (doc 13: the registry is extended, never repurposed) and are
 * deliberately domain-owned rather than added to the shared library, which only
 * carries codes the handler itself raises.
 */
export const RECEIPT_ERROR_CODES = {
  /** 422. `receipts_sha_unique` conflict: the only synchronous rejection. */
  RECEIPT_DUPLICATE: "RECEIPT_DUPLICATE",
  /** 400. Failed magic-byte sniff, oversize, undecodable, or a malformed path. */
  RECEIPT_INVALID_IMAGE: "RECEIPT_INVALID_IMAGE",
  /** 403. Submission during a fraud cooldown; `Retry-After` = cooldown end. */
  CONSUMER_SCAN_BLOCKED: "CONSUMER_SCAN_BLOCKED",
} as const;

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

// `{uuid}.jpg`, the filename POST /api/v1/receipts/uploads generates. Pinning
// the shape is not cosmetic: 0019's storage policy asserts a ONE-level path so
// that `(storage.foldername(name))[1]` is unambiguously the owner segment, and
// receipts.image_path is read back by the OCR worker and the review UI, which
// both assume this convention.
const IMAGE_FILENAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Doc 36 Stage 1 step 2's body. `submitted_lat`/`submitted_lng` are ACCEPTED
 * here and stripped later: whether they may be stored depends on
 * `consumers.gps_fraud_opt_in`, which is database state, so rejecting them at
 * the schema would be both wrong (the same payload is valid for an opted-in
 * consumer) and a disclosure (the error would reveal the flag).
 */
export const submitReceiptBodySchema = z.object({
  // 36 for the uid + 1 slash + 40 for "{uuid}.jpg" = 77; the bound is generous
  // headroom that still refuses a pathological string before any IO.
  image_path: z.string().min(3).max(200),
  client_sha256: z.string().regex(SHA256_HEX_PATTERN).optional(),
  business_id: z.string().uuid().optional(),
  submitted_lat: z.number().min(-90).max(90).optional(),
  submitted_lng: z.number().min(-180).max(180).optional(),
  device_id: z.string().uuid().optional(),
});

export type SubmitReceiptBody = z.infer<typeof submitReceiptBodySchema>;

export interface SubmitReceiptInput {
  /** `auth.uid()` of the caller, which is also `consumers.id`. */
  readonly userId: string;
  readonly body: SubmitReceiptBody;
}

export interface SubmitReceiptResult {
  readonly receiptId: string;
  readonly status: "queued";
}

/**
 * Doc 36 Stage 2's entry point, owned by T11's
 * `src/features/receipts/server/process.ts`. It is INJECTED rather than
 * imported so this module never depends on the orchestrator: submit's job is
 * done the moment a queued row exists, and today's synchronous call is a
 * stand-in for tomorrow's QStash enqueue (see TODO(queue) below).
 */
export type ProcessReceipt = (receiptId: string) => Promise<void>;

export interface SubmitReceiptDeps {
  /** MUST be the service-role client; see the file header. */
  readonly supabase: SupabaseClient<Database>;
  readonly canonicalize: CanonicalizeReceiptImage;
  readonly processReceipt: ProcessReceipt;
  /** Injectable clock, so the cooldown boundary is testable. */
  readonly now?: () => Date;
}

/**
 * The service-role client or a 503. Unlike the settings loader, submission has
 * no meaningful degraded mode: without this key there is no way to write a
 * receipts row at all, so pretending otherwise would drop a consumer's
 * submission on the floor after they had already uploaded the photo.
 */
export function requireServiceRoleClient(): SupabaseClient<Database> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[receipts] SUPABASE_SERVICE_ROLE_KEY is not configured; receipt submission is disabled",
    );
    throw new ApiError(
      503,
      API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
      "Receipt scanning is temporarily unavailable. Please try again shortly.",
    );
  }
  return supabase;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function invalidImage(message: string): ApiError {
  return new ApiError(400, RECEIPT_ERROR_CODES.RECEIPT_INVALID_IMAGE, message);
}

function duplicateReceipt(): ApiError {
  return new ApiError(
    422,
    RECEIPT_ERROR_CODES.RECEIPT_DUPLICATE,
    "You have already submitted this exact photo. Please take a new one.",
  );
}

// ---------------------------------------------------------------------------
// Postgres error inspection
// ---------------------------------------------------------------------------

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

// Postgres reports the offending constraint by NAME inside its 23505 message:
//   duplicate key value violates unique constraint "receipts_sha_unique"
// PostgREST forwards that message but does not surface the constraint as its
// own field, so the identifier is lifted out of the quotes and compared
// exactly. That is deliberately different from testing whether the message
// merely CONTAINS "sha256" or "duplicate key": receipts carries a second unique
// index (`receipts_number_unique`, on business_id + receipt_number) whose
// violation is a different outcome entirely (doc 36 Stage 8 routes it to a
// rejected status with a fraud signal, not to a synchronous 422), and a
// substring test would happily conflate the two the first time a number
// collided.
const CONSTRAINT_NAME_PATTERN = /constraint "([^"]+)"/;

/** The constraint an error names, or null when it names none. */
function violatedConstraint(error: PostgrestError): string | null {
  for (const source of [error.message, error.details]) {
    const matched = typeof source === "string" ? CONSTRAINT_NAME_PATTERN.exec(source) : null;
    if (matched?.[1]) return matched[1];
  }
  return null;
}

/** doc 24 / 0017: `create unique index receipts_sha_unique on public.receipts (sha256)`. */
const SHA_UNIQUE_CONSTRAINT = "receipts_sha_unique";

function mapInsertError(error: PostgrestError): ApiError {
  if (error.code === UNIQUE_VIOLATION) {
    if (violatedConstraint(error) === SHA_UNIQUE_CONSTRAINT) {
      return duplicateReceipt();
    }
    console.error("[receipts] unexpected unique violation on insert", error);
    return new ApiError(
      409,
      API_ERROR_CODES.CONFLICT,
      "This receipt could not be saved. Please try again.",
    );
  }

  if (error.code === FOREIGN_KEY_VIOLATION) {
    // A business_id or device_id the caller made up. 422 with the field named,
    // rather than a 500, because it is the request that is wrong.
    const constraint = violatedConstraint(error) ?? "";
    const field = constraint.includes("device") ? "device_id" : "business_id";
    const details: ErrorDetail[] = [{ field, issue: "not_found" }];
    return new ApiError(
      422,
      API_ERROR_CODES.VALIDATION_FAILED,
      "Some of the information provided needs your attention.",
      details,
    );
  }

  console.error("[receipts] receipt insert failed", error);
  return new ApiError(
    500,
    API_ERROR_CODES.INTERNAL,
    "Something went wrong. Please try again.",
  );
}

/**
 * Best-effort HTTP status of a Supabase storage error. The storage client's
 * error type is not discriminated in its published typings, so the numeric
 * status is read structurally rather than cast.
 */
function storageErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as Record<string, unknown>;
  for (const key of ["statusCode", "status"]) {
    const value = candidate[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Doc 36 Stage 1 step 2: "Validate `image_path` prefix matches `auth.uid()`".
 *
 * This is an AUTHORIZATION check, not a formatting one, and it is the only
 * thing standing between a caller and another consumer's receipt image. The
 * service-role client used below bypasses RLS, so 0019's owner-prefix policy on
 * storage.objects does not protect this path: without this check, submitting
 * `{someone-elses-uid}/{uuid}.jpg` would have the server read, re-encode,
 * OVERWRITE and hash a stranger's evidence, then file it as the caller's own
 * receipt. Hence 403 rather than a validation error.
 */
function assertOwnedImagePath(imagePath: string, userId: string): void {
  const segments = imagePath.split("/");
  const [prefix, filename] = segments;

  if (prefix !== userId) {
    throw new ApiError(
      403,
      API_ERROR_CODES.FORBIDDEN,
      "That image does not belong to your account.",
    );
  }

  if (segments.length !== 2 || filename === undefined || !IMAGE_FILENAME_PATTERN.test(filename)) {
    throw invalidImage("That image path is not one this app issued. Please try again.");
  }
}

interface ConsumerContext {
  readonly gpsOptIn: boolean;
  readonly blockedUntil: Date | null;
}

async function loadConsumer(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ConsumerContext> {
  const { data, error } = await supabase
    .from("consumers")
    .select("gps_fraud_opt_in, scan_blocked_until")
    .eq("id", userId)
    .maybeSingle();

  if (error !== null) {
    console.error("[receipts] could not read the submitting consumer", error);
    throw new ApiError(
      503,
      API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
      "Receipt scanning is temporarily unavailable. Please try again shortly.",
    );
  }

  if (data === null) {
    // A signed-in profile with no consumers row is staff-only. receipts.user_id
    // references consumers(id), so the insert would fail anyway; refusing here
    // makes the reason legible instead of surfacing as a foreign key error.
    throw new ApiError(
      403,
      API_ERROR_CODES.FORBIDDEN,
      "Only customer accounts can scan receipts.",
    );
  }

  return {
    gpsOptIn: data.gps_fraud_opt_in,
    blockedUntil: data.scan_blocked_until === null ? null : new Date(data.scan_blocked_until),
  };
}

/**
 * Doc 37 consequences ladder step 2: a cooldown is "automatic, auto-expiring,
 * audited", so the block is a timestamp comparison and the response says
 * exactly when it lifts. `Retry-After` is in seconds (RFC 9110), rounded UP so
 * a client that retries the instant it elapses is not refused a second time.
 *
 * The message deliberately does not say WHY. Doc 33's rule is that fraud
 * internals are never exposed to the consumer: naming the signal that tripped
 * would tell an abuser precisely which behaviour to change.
 */
function assertNotBlocked(consumer: ConsumerContext, now: Date): void {
  if (consumer.blockedUntil === null || consumer.blockedUntil <= now) return;

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((consumer.blockedUntil.getTime() - now.getTime()) / 1000),
  );

  throw new ApiError(
    403,
    RECEIPT_ERROR_CODES.CONSUMER_SCAN_BLOCKED,
    "Receipt scanning is paused on your account for now. Please try again later.",
    undefined,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

/**
 * RA 10173 data minimisation, restated by doc 36 Stage 1: coordinates are
 * stored ONLY when the consumer opted into the GPS fraud check. Silently
 * dropping them (rather than erroring) is the specified behaviour, and it is
 * also the only behaviour that keeps a shared client build honest: one app
 * sends the fields for everyone, and the server decides per consumer.
 *
 * A lone coordinate is dropped too. Half a fix is not a location, and storing
 * it would leave `submitted_lat` populated with `submitted_lng` null, which
 * every downstream reader would have to special-case.
 */
function resolveCoordinates(
  body: SubmitReceiptBody,
  consumer: ConsumerContext,
): { lat: number | null; lng: number | null } {
  if (!consumer.gpsOptIn) return { lat: null, lng: null };
  if (body.submitted_lat === undefined || body.submitted_lng === undefined) {
    return { lat: null, lng: null };
  }
  return { lat: body.submitted_lat, lng: body.submitted_lng };
}

async function downloadUpload(
  supabase: SupabaseClient<Database>,
  imagePath: string,
): Promise<Uint8Array> {
  const { data, error } = await supabase.storage.from(RECEIPTS_BUCKET).download(imagePath);

  if (error !== null || data === null) {
    const status = storageErrorStatus(error);
    // 4xx means the object is not there (or not readable as addressed), which
    // is a client-side problem: the upload never completed. Anything else is
    // ours, and telling the consumer their photo is invalid would send them off
    // retaking pictures to fix a storage outage.
    if (status !== null && status >= 400 && status < 500) {
      throw invalidImage("We could not find your uploaded photo. Please try again.");
    }
    console.error("[receipts] could not download the uploaded object", error);
    throw new ApiError(
      503,
      API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
      "Receipt scanning is temporarily unavailable. Please try again shortly.",
    );
  }

  return new Uint8Array(await data.arrayBuffer());
}

function assertUsableBytes(bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw invalidImage("That photo appears to be empty. Please try again.");
  }
  // Doc 15's 10MB cap, re-checked server side. 0019 sets the same limit as the
  // bucket's file_size_limit and doc 36 has the client reject earlier still;
  // this is the fence that does not depend on either of them behaving.
  if (bytes.length > RECEIPT_MAX_BYTES) {
    throw invalidImage("That photo is too large. Please use one under 10MB.");
  }
  // Magic bytes, not the declared content type: the Content-Type that reached
  // the bucket is whatever the uploading client claimed, so it is exactly as
  // trustworthy as the bytes it describes are not.
  if (sniffImageFormat(bytes) === null) {
    throw invalidImage("That file is not a JPEG, PNG or WebP photo.");
  }
}

/**
 * doc 36 Stage 1: `client_sha256` is ADVISORY ONLY and is never stored as
 * `receipts.sha256`. The reason is structural, not a policy choice: the server
 * re-encodes the image, so the authoritative hash is taken over bytes the
 * client has never seen and the two values cannot agree by construction.
 *
 * It is therefore not used for a duplicate pre-check either. Every stored
 * sha256 is a post-canonicalization hash, so comparing a pre-canonicalization
 * hash against that column would match nothing, ever, and a "fast pre-check"
 * that structurally cannot fire is worse than none: it reads as protection.
 *
 * What it CAN do is exactly this: confirm that the bytes now in the bucket are
 * the bytes the client believed it uploaded. A mismatch means a truncated
 * upload or an object swapped between the PUT and this request, so it is worth
 * a log line. It is never worth a rejection: the submission is honest either
 * way, and the pipeline hashes what it actually holds.
 */
function auditClientHash(bytes: Uint8Array, clientSha256: string | undefined): void {
  if (clientSha256 === undefined) return;
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== clientSha256.toLowerCase()) {
    console.warn(
      "[receipts] client_sha256 does not match the uploaded bytes; continuing with the server hash",
    );
  }
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Turn an uploaded object into a queued receipt. Throws `ApiError` for every
 * outcome a caller is meant to surface; anything else is a genuine fault.
 */
export async function submitReceipt(
  input: SubmitReceiptInput,
  deps: SubmitReceiptDeps,
): Promise<SubmitReceiptResult> {
  const { userId, body } = input;
  const { supabase, canonicalize, processReceipt } = deps;
  const now = deps.now?.() ?? new Date();

  assertOwnedImagePath(body.image_path, userId);

  const consumer = await loadConsumer(supabase, userId);
  assertNotBlocked(consumer, now);

  const uploaded = await downloadUpload(supabase, body.image_path);
  assertUsableBytes(uploaded);
  auditClientHash(uploaded, body.client_sha256);

  let canonical;
  try {
    canonical = await canonicalize(uploaded);
  } catch (error) {
    // The bytes passed the signature check but the decoder refused them:
    // truncated, or a valid header wrapped around something that is not an
    // image. Either way the consumer's remedy is to retake the photo.
    console.warn("[receipts] canonicalization failed", error);
    throw invalidImage("We could not read that photo. Please take another one.");
  }

  // Authoritative hashes, both over the CANONICAL bytes. Computed before the
  // overwrite so that the row can never describe bytes that were not stored,
  // and stored before the insert so a duplicate is caught by the database.
  const sha256 = createHash("sha256").update(canonical.jpeg).digest("hex");
  const imageHash = dctPhash(canonical.grayscale);

  // Overwrite the object with the canonical bytes. This is the step that
  // removes EXIF/GPS from what is stored (doc 15), so a failure here MUST stop
  // the submission: continuing would file a receipt whose stored image still
  // carries the consumer's location, and whose sha256 describes bytes that are
  // not in the bucket. Nothing has been written yet, so refusing is clean.
  const { error: uploadError } = await supabase.storage
    .from(RECEIPTS_BUCKET)
    .upload(body.image_path, canonical.jpeg, {
      contentType: "image/jpeg",
      upsert: true,
    });

  if (uploadError !== null) {
    console.error(
      "[receipts] could not overwrite the uploaded object with canonical bytes; the original (with EXIF) remains in the bucket",
      uploadError,
    );
    throw new ApiError(
      503,
      API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
      "Receipt scanning is temporarily unavailable. Please try again shortly.",
    );
  }

  const coordinates = resolveCoordinates(body, consumer);

  const { data: inserted, error: insertError } = await supabase
    .from("receipts")
    .insert({
      user_id: userId,
      business_id: body.business_id ?? null,
      status: "queued",
      source: "scan",
      image_path: body.image_path,
      image_hash: imageHash,
      // The server hash, always. `body.client_sha256` never reaches this row.
      sha256,
      device_id: body.device_id ?? null,
      submitted_lat: coordinates.lat,
      submitted_lng: coordinates.lng,
      created_by: userId,
      updated_by: userId,
    })
    .select("id")
    .single();

  if (insertError !== null) {
    throw mapInsertError(insertError);
  }

  const receiptId = inserted.id;

  // TODO(queue): doc 36 Stage 2. THE INFRASTRUCTURE NOW EXISTS and this call
  // site is deliberately still inline. What is already built:
  //
  //   * `jobs` (0029_jobs.sql), with the partial `jobs_dedupe_idx` on
  //     (queue, dedupe_key) while queued/running that prevents concurrent
  //     double processing;
  //   * `enqueue()` in src/lib/queue/publish.ts, which writes the row before it
  //     publishes and never throws;
  //   * `ocr.process` in src/lib/queue/queues.ts, already carrying doc 39's
  //     retry budget (3 attempts), flow-control key (`ocr`, parallelism 10) and
  //     dedupe key (`receipts.id`);
  //   * the claim protocol and the worker-route shape, both proven by
  //     `notify.email` (src/app/api/jobs/notify.email/route.ts).
  //
  // WHAT REMAINS is not queue work, it is re-entrancy work in
  // src/features/receipts/server/process.ts. Enqueuing makes concurrent
  // execution of `processReceipt` ORDINARY rather than exceptional (a retry
  // after a timeout overlaps the original; QStash delivers at least once by
  // design), and the pipeline is not yet safe under that: velocity is counted
  // per pass, and the status claim does not verify that it changed a row. Doc
  // 39 is explicit that a worker must be "idempotent by domain key", and today
  // this one is not. Flipping the seam before that lands would not add
  // durability, it would convert a rare race into the normal case.
  //
  // So the last step is exactly two lines here - swap the call below for
  // `enqueue({queue: "ocr.process", payload: {receipt_id: receiptId},
  // businessId: body.business_id ?? null, dedupeKey: receiptId})` - and it is
  // gated on process.ts being safe to run twice. The call site does not change
  // shape either way: a receipt id in, nothing out.
  //
  // Until then it runs inline, and a failure must NOT fail the submission. The
  // row exists and is `queued`, which is precisely the state a retry expects;
  // turning a processing fault into a 500 here would tell the consumer their
  // submission was lost while it sits in the database waiting to be picked up,
  // and would invite a resubmission that `receipts_sha_unique` then refuses.
  try {
    await processReceipt(receiptId);
  } catch (error) {
    console.error(`[receipts] processing failed for ${receiptId}; left queued for retry`, error);
  }

  return { receiptId, status: "queued" };
}
