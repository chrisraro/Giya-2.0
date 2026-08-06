import "server-only";

import { createHash } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import type { ErrorDetail } from "@/lib/api/errors";
import { ACCOUNT_SUSPENDED, readConsumerSuspension } from "@/lib/auth/suspension";
import { enqueue, isQueueConfigured } from "@/lib/queue/publish";
import type { EnqueueInput, EnqueueResult } from "@/lib/queue/publish";
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
//   2. suspension       - doc 37 ladder step 4 (full lockout), the MORE severe
//                         of the two account-level gates, checked before the
//                         less severe one so a suspended consumer's refusal
//                         never depends on cooldown state
//   3. cooldown         - doc 37 ladder step 2, before any work is done
//   4. download + sniff - the declared content type is attacker-controlled
//   5. canonicalize     - strips EXIF/GPS; after this the bytes are ours
//   6. sha256 + pHash   - over the CANONICAL bytes, which is what is stored
//   7. insert           - service role, since receipts has no client insert
//   8. dispatch         - enqueue `ocr.process` (doc 36 Stage 1 step 5), or
//                         process inline when there is no queue to enqueue to
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
 * Doc 36 Stage 2's entry point, owned by
 * `src/features/receipts/server/process.ts`. It is INJECTED rather than
 * imported so this module never depends on the orchestrator: submit's job is
 * done the moment a queued row exists.
 *
 * Still required after the queue flip, and NOT as a leftover: it is the
 * degraded path. See `dispatchProcessing`.
 */
export type ProcessReceipt = (receiptId: string) => Promise<void>;

export interface SubmitReceiptDeps {
  /** MUST be the service-role client; see the file header. */
  readonly supabase: SupabaseClient<Database>;
  readonly canonicalize: CanonicalizeReceiptImage;
  readonly processReceipt: ProcessReceipt;
  /**
   * Doc 39's single enqueue path (`src/lib/queue/publish.ts`), injected so the
   * submission tests never reach QStash. Defaults to the real one.
   */
  readonly enqueue?: (input: EnqueueInput) => Promise<EnqueueResult>;
  /**
   * Whether this deployment can deliver a job at all. Defaults to the real env
   * check; see `dispatchProcessing` for why the choice is made here rather than
   * left to `enqueue()`.
   */
  readonly isQueueConfigured?: () => boolean;
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

/**
 * Doc 30 section 2.8 + the brief's requirement 3: a suspended consumer must
 * be refused by this money path directly, independent of the `/suspended`
 * screen the consumer layout redirects to (that redirect is a courtesy; this
 * is the control - a suspended consumer calling `POST /api/v1/receipts`
 * straight past the UI must still be refused). Checked with the SAME
 * service-role client `loadConsumer` below already uses, so this is one more
 * query on that client, not a new session dependency.
 *
 * Fails CLOSED: `readConsumerSuspension` returning `"unknown"` (a read this
 * function cannot trust) refuses the scan with 503, the SAME status
 * `loadConsumer`'s own read failure already answers with - a suspension
 * state this code cannot verify must not let an award-triggering scan
 * through.
 */
async function assertNotSuspended(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<void> {
  const status = await readConsumerSuspension(supabase, userId);
  if (status === "suspended") {
    throw new ApiError(
      403,
      ACCOUNT_SUSPENDED,
      "Your account is suspended. Please contact support.",
    );
  }
  if (status === "unknown") {
    throw new ApiError(
      503,
      API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
      "Receipt scanning is temporarily unavailable. Please try again shortly.",
    );
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
// Step 7 - dispatch (doc 36 Stage 1 step 5, Stage 2)
// ---------------------------------------------------------------------------
//
// "Enqueue `ocr.process` with `payload={receipt_id}` and
// `jobs.dedupe_key = sha256`" - doc 36 Stage 1 step 5, verbatim. `max_attempts`
// is 3 for this queue, doc 36 Stage 2's deliberate override of the column
// default 5; it is not passed here because `enqueue()` reads it from the
// registry (src/lib/queue/queues.ts), which is the only place it can be stated
// once for the publisher, the row and QStash's own `Upstash-Retries` header.
//
// =============================================================================
// TWO DECISIONS LIVE HERE. BOTH ARE ABOUT NOT LOSING A RECEIPT.
// =============================================================================
//
// -----------------------------------------------------------------------------
// DECISION 1: WHAT HAPPENS WHEN THERE IS NO QUEUE (the local-dev / degraded case)
// -----------------------------------------------------------------------------
// A deployment with no `QSTASH_TOKEN` must still scan receipts. So the path is
// selected on env, once, exactly the way `getOcrProvider()` selects an OCR
// implementation - a synchronous read of the configuration, a branch, and a log
// line naming the branch, so nobody debugging a receipt has to guess which one
// ran.
//
// The check is deliberately made BEFORE the enqueue rather than inferred from
// its result. `enqueue()` would happily write a `jobs` row on an unconfigured
// deployment and report `published: false` - which is the right behaviour for a
// fire-and-forget caller, because doc 39's reconciler exists to re-publish
// exactly those. But here it would accumulate one undeliverable row per
// submission on every developer machine: a queue whose depth only ever grows,
// which doc 39's own metrics section describes as the failure of a registry
// entry with no worker.
//
// -----------------------------------------------------------------------------
// DECISION 2: WHAT HAPPENS WHEN THE ENQUEUE FAILS (fail-soft, and which way)
// -----------------------------------------------------------------------------
// The receipt row already exists at `status='queued'` and its sha256 is already
// claimed by `receipts_sha_unique`. Three options, and two of them lose the
// receipt:
//
//   * FAIL THE REQUEST (500). Rejected outright. It tells the consumer their
//     submission was lost while it is sitting in the database, and it invites a
//     resubmission of the same photo that `receipts_sha_unique` then refuses
//     with a 422 - so the honest-looking answer produces a receipt that can
//     never be filed at all. Being wrong in this direction costs a real
//     customer their points.
//
//   * 202 AND LET A SWEEPER FIND IT. This is the option the shape of the code
//     argues for, and it does not work TODAY, which is the whole point.
//     `sweep_stuck_receipts` (0028) only ever looks at `status='processing'` -
//     its candidate predicate says so and its comment explains why (a receipt
//     with zero OCR attempts is left alone deliberately, because there is no
//     evidence the image was ever the problem). A receipt stranded at `queued`
//     is therefore swept by NOTHING. It is not retried, not rejected, not
//     surfaced; it just sits, and the consumer watches a "Processing receipt…"
//     entry forever. A silent enqueue failure would be the only way in this
//     system to lose a receipt completely, so answering 202 and hoping is not
//     fail-soft, it is fail-silent.
//
//   * 202 AND PROCESS IT INLINE. Chosen. The 202 is preserved (the row exists,
//     which is all the response ever asserted), and the work still happens.
//
// WHY THE INLINE FALLBACK IS THE HONEST CLOSE, rather than a new sweeper: the
// gap is that `queued` has no owner, and the cheapest correct fix is to not
// leave a receipt there. Running the pipeline inline moves the receipt to
// `processing` within milliseconds, and `processing` is a state the EXISTING
// 0028 sweep already owns end to end - if the inline pass then dies, times out,
// or is frozen by the platform mid-flight, the receipt is dead-lettered within
// the hour as rejected / manual / 'processing_failed', the consumer is
// notified, and they can resubmit. That converts an invisible permanent loss
// into a bounded, visible, already-handled failure using machinery that is
// already deployed and already tested. Extending the sweep instead would mean
// re-enqueuing from SQL, and pg_cron can only call SQL: 0028's header explains
// at length that it deliberately does not reimplement any of the pipeline's
// retry logic in plpgsql, and a publisher living in the database with a QStash
// token in it would be a worse answer than the one it replaced.
//
// THE PREDICATE IS "IS A DELIVERY IN FLIGHT", NOT "DID THE ROW GET WRITTEN".
// `enqueue()` reports `status:'enqueued', published:false` when the row landed
// but QStash refused, was unreachable, or timed out. That row is durable and
// doc 39's hourly reconciler is designed to find it - but that reconciler is
// not built yet (0028 ships only the receipts half of it), so today
// `published:false` strands the receipt exactly as `status:'failed'` does.
// Treating them the same is therefore not conservatism, it is accuracy about
// what this deployment can currently recover. When the jobs reconciler ships,
// this branch narrows to `status:'failed'` alone.
//
// The cost of being wrong in the chosen direction is a QStash outage turning
// every submission into a slow request rather than a fast lie. That is the
// right trade for the money path, and it is bounded by the 6/min per-consumer
// rate limit; it is also no worse than the behaviour this very function had
// before the seam flipped.

/** Which path actually ran, for the caller's log and for the tests. */
export type ReceiptDispatch = "queued" | "inline";

interface DispatchInput {
  readonly receiptId: string;
  readonly businessId: string | null;
  /** doc 36 Stage 1 step 5's `jobs.dedupe_key`. */
  readonly sha256: string;
  readonly deps: SubmitReceiptDeps;
}

/**
 * Run the pipeline in this request. Never throws, for the reason the enqueue
 * never does: the receipt is already committed, and a processing fault must not
 * be able to un-file a submission the consumer has already made.
 */
async function processInline(input: DispatchInput, why: string): Promise<ReceiptDispatch> {
  const { receiptId, deps } = input;
  console.info(`[receipts] ${receiptId} is being processed INLINE (${why})`);
  try {
    await deps.processReceipt(receiptId);
  } catch (error) {
    // The row exists and is `queued` or `processing`, which is precisely the
    // state a retry expects; turning a processing fault into a 500 here would
    // tell the consumer their submission was lost while it sits in the database
    // waiting to be picked up.
    console.error(`[receipts] inline processing failed for ${receiptId}`, error);
  }
  return "inline";
}

async function dispatchProcessing(input: DispatchInput): Promise<ReceiptDispatch> {
  const { receiptId, businessId, sha256, deps } = input;
  const queueConfigured = deps.isQueueConfigured ?? isQueueConfigured;

  // Decision 1.
  if (!queueConfigured()) {
    return processInline(input, "QStash is not configured on this deployment");
  }

  const publishJob = deps.enqueue ?? enqueue;
  const result = await publishJob({
    queue: "ocr.process",
    // Identifiers only (doc 39). `job_id` is added by the publisher.
    payload: { receipt_id: receiptId },
    businessId,
    // Doc 36 Stage 1 step 5: the sha256, so a duplicate submission cannot
    // double-process. `jobs_dedupe_idx` (0029) is what enforces it, and only
    // while the owning job is `queued`/`running`, so a finished job never holds
    // the key hostage.
    dedupeKey: sha256,
    // The client that just wrote the receipt, reused rather than re-created.
    // It is service-role by this function's contract, which makes `enqueue()`'s
    // own "no service-role client" failure branch unreachable from here.
    supabase: deps.supabase,
  });

  switch (result.status) {
    case "enqueued":
      if (result.published) {
        console.info(
          `[receipts] ${receiptId} is QUEUED on ocr.process as job ${result.jobId} (message ${result.messageId})`,
        );
        return "queued";
      }
      // Decision 2, the `published:false` half.
      console.error(
        `[receipts] job ${result.jobId} for ${receiptId} was recorded but QStash did not accept it`,
      );
      return processInline(input, "the job row landed but no delivery is in flight");

    case "deduplicated":
      // An in-flight job already owns this sha256. Given `receipts_sha_unique`
      // this is close to unreachable, but if it happens the work IS scheduled
      // and enqueuing again would be the double-processing the key exists to
      // prevent.
      console.info(
        `[receipts] ${receiptId} is already owned by in-flight job ${result.jobId ?? "(unknown)"}; not enqueuing again`,
      );
      return "queued";

    case "failed":
      // Decision 2, the no-row half.
      console.error(`[receipts] could not enqueue ocr.process for ${receiptId}: ${result.reason}`);
      return processInline(input, "the job row could not be written");
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
  // `processReceipt` is deliberately NOT destructured: it is reached only
  // through `dispatchProcessing`, which decides whether it should run at all.
  const { supabase, canonicalize } = deps;
  const now = deps.now?.() ?? new Date();

  assertOwnedImagePath(body.image_path, userId);
  await assertNotSuspended(supabase, userId);

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

  // Doc 36 Stage 1 step 5 / Stage 2. The seam: the pipeline is the queue's
  // work now, and only this deployment's own configuration (or a failure to
  // hand the job over) can make it this request's. See `dispatchProcessing` for
  // both decisions and why they are the way round they are.
  //
  // NOTHING ABOUT THE RESPONSE DEPENDS ON THE ANSWER. Doc 36 Stage 1 step 6 is
  // `202 { receipt_id, status: "queued" }`, and it was always an assertion
  // about the ROW rather than about the delivery: the receipt exists, it is
  // `queued`, and the consumer should subscribe to it. That is true on every
  // branch below, which is why this call's result is a log line and not part of
  // the return value.
  await dispatchProcessing({
    receiptId,
    businessId: body.business_id ?? null,
    // The AUTHORITATIVE server hash, over the canonical bytes - the same value
    // written to the row above, so the dedupe key and `receipts.sha256` can
    // never describe different images.
    sha256,
    deps,
  });

  return { receiptId, status: "queued" };
}
