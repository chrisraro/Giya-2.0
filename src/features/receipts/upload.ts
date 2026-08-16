// The client half of doc 36 Stage 1: three network steps between a compressed
// photo and a queued receipt.
//
//   1. POST /api/v1/receipts/uploads  -> { upload_url, image_path }
//   2. PUT  {upload_url}              -> the bytes land in the private bucket
//   3. POST /api/v1/receipts          -> 202 { receipt_id, status }
//
// Step 3 carries an `Idempotency-Key`. Two properties of this module exist
// entirely to make that header do its job:
//
//   - The key is an INPUT, never generated here. It is minted once when the
//     consumer confirms the photo and reused verbatim by every retry of that
//     same submission, so a retry after a network blip replays the original
//     202 instead of filing a second receipt.
//   - `imagePath` is also an input/output. src/lib/api/handler.ts fingerprints
//     the request body and answers a key reused with a DIFFERENT body with a
//     409 IDEMPOTENCY_REPLAYED. Re-running steps 1 and 2 on every retry would
//     mint a fresh path, change the body, and turn the safety net into an
//     error. So once bytes are in the bucket, retries reuse that path and the
//     body stays byte-identical.

import type { CaptureRejectionReason } from "./compress";

/** Where a submission failed, in terms the capture UI can render. */
export type CaptureErrorKind =
  | "network"
  | "blocked"
  | "rate_limited"
  | "duplicate"
  | "invalid_image"
  | "unsupported_device"
  | "unauthenticated"
  | "unavailable"
  | "in_progress"
  | "unknown";

export interface CaptureError {
  readonly kind: CaptureErrorKind;
  /** The API error code, or a client-side pseudo-code. Shown as a small caption. */
  readonly code: string;
  /**
   * The HTTP status the server answered with, or `undefined` where there was no
   * answer at all (transport failure, offline, a photo rejected on device).
   *
   * The capture screen does not read this; the offline outbox does. Doc 41
   * section 3 makes 4xx domain errors TERMINAL on replay - "retrying a
   * RECEIPT_DUPLICATE forever burns the 60/day budget and can never succeed" -
   * and that is a statement about the status class, not about any one code.
   * Classifying by `kind` alone would silently retry an unmapped 400 five times
   * before giving up, because `mapSubmitError`'s fallback branch is written for
   * a UI that offers a Try again button, not for an unattended drain.
   */
  readonly status?: number | undefined;
  readonly title: string;
  readonly message: string;
  /**
   * Whether retrying THIS submission (same photo, same Idempotency-Key) can
   * succeed. False means the remedy is a different photo or simply waiting, and
   * the UI must offer that instead of a retry button that cannot work.
   */
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number | undefined;
}

/** Codes owned by src/features/receipts/server/submit.ts. */
const RECEIPT_DUPLICATE = "RECEIPT_DUPLICATE";
const RECEIPT_INVALID_IMAGE = "RECEIPT_INVALID_IMAGE";
const CONSUMER_SCAN_BLOCKED = "CONSUMER_SCAN_BLOCKED";

/**
 * "in a moment" / "in about 20 minutes" / "in about 3 hours" for a `Retry-After`
 * value in seconds. Deliberately vague at the low end: a countdown to the second
 * invites the consumer to sit on the screen waiting, and the server's window is
 * approximate anyway.
 */
export function formatRetryAfter(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "later";
  if (seconds < 90) return "in a moment";
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return minutes <= 1 ? "in about a minute" : `in about ${minutes} minutes`;
  }
  const hours = Math.round(seconds / 3600);
  if (hours <= 1) return "in about an hour";
  if (hours < 24) return `in about ${hours} hours`;
  return "tomorrow";
}

function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined) return undefined;
  const seconds = Number(header.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * The consumer-facing error matrix.
 *
 * Copy is written here rather than taken from the envelope's `message` for the
 * cases below, even though doc 13 guarantees that message is user-safe. Two
 * reasons: the cooldown and rate-limit messages become materially more useful
 * once `Retry-After` is folded into the sentence, and doc 33 requires the
 * scan-limit copy to say nothing about WHY, which is a promise this file can
 * keep and a promise a pass-through cannot. Unmapped codes still fall back to
 * the server's message verbatim.
 */
export function mapSubmitError(
  status: number,
  code: string | undefined,
  message: string | undefined,
  retryAfterSeconds?: number,
): CaptureError {
  if (code === CONSUMER_SCAN_BLOCKED) {
    return {
      kind: "blocked",
      code: CONSUMER_SCAN_BLOCKED,
      status,
      title: "Scan limit reached",
      // Doc 33: never expose fraud internals, never name the signal that
      // tripped. "Try again later" is the whole truth the consumer is owed.
      message: `You have reached the scan limit for now. Please try again ${formatRetryAfter(retryAfterSeconds)}.`,
      retryable: false,
      retryAfterSeconds,
    };
  }

  if (code === RECEIPT_DUPLICATE) {
    return {
      kind: "duplicate",
      code: RECEIPT_DUPLICATE,
      status,
      title: "Already scanned",
      message: "You have already scanned this receipt. Try a different one.",
      retryable: false,
    };
  }

  if (code === RECEIPT_INVALID_IMAGE) {
    return {
      kind: "invalid_image",
      code: RECEIPT_INVALID_IMAGE,
      status,
      title: "We could not read that photo",
      message: "Take another photo with the whole receipt inside the frame.",
      retryable: false,
    };
  }

  if (status === 429 || code === "RATE_LIMITED") {
    return {
      kind: "rate_limited",
      code: code ?? "RATE_LIMITED",
      status,
      title: "Scan limit reached",
      message: `You have reached the scan limit. Please try again ${formatRetryAfter(retryAfterSeconds)}.`,
      retryable: false,
      retryAfterSeconds,
    };
  }

  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      kind: "unauthenticated",
      code: code ?? "UNAUTHENTICATED",
      status,
      title: "Please sign in again",
      message: "Your session has expired. Sign in again to scan this receipt.",
      retryable: false,
    };
  }

  if (code === "IDEMPOTENCY_IN_PROGRESS") {
    return {
      kind: "in_progress",
      code: "IDEMPOTENCY_IN_PROGRESS",
      status,
      title: "Still working on it",
      message: "Your receipt is still being submitted. Please try again in a moment.",
      retryable: true,
    };
  }

  if (status >= 500 || code === "DEPENDENCY_UNAVAILABLE") {
    return {
      kind: "unavailable",
      code: code ?? "DEPENDENCY_UNAVAILABLE",
      status,
      title: "Scanning is unavailable",
      message: "Receipt scanning is temporarily unavailable. Please try again in a moment.",
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    code: code ?? "UNKNOWN",
    status,
    title: "That did not work",
    message: message ?? "Something went wrong. Please try again.",
    retryable: true,
  };
}

/** A transport failure or an offline device: never the server's fault, always retryable. */
export function networkError(offline: boolean): CaptureError {
  return {
    kind: "network",
    code: offline ? "OFFLINE" : "NETWORK",
    title: offline ? "You are offline" : "Connection problem",
    message: offline
      ? "Your receipt is ready to send. Reconnect and tap Try again."
      : "We could not reach Giya. Check your connection and tap Try again.",
    retryable: true,
  };
}

/** Copy for a photo rejected before it ever left the device. */
export function mapCaptureRejection(reason: CaptureRejectionReason): CaptureError {
  switch (reason) {
    case "too_large":
      return {
        kind: "invalid_image",
        code: "FILE_TOO_LARGE",
        title: "That photo is too large",
        message: "Photos need to be under 10MB. Take a new photo instead of picking a large file.",
        retryable: false,
      };
    case "unsupported_format":
      return {
        kind: "invalid_image",
        code: "UNSUPPORTED_FORMAT",
        title: "That file is not a photo we can read",
        message: "Use a JPEG, PNG or WebP photo, or take a new one with the camera.",
        retryable: false,
      };
    case "decode_failed":
      return {
        kind: "unsupported_device",
        code: "DECODE_FAILED",
        title: "This browser cannot open that photo",
        message:
          "HEIC photos only open on some devices. Take a new photo with the camera, or pick a JPEG.",
        retryable: false,
      };
    case "empty":
      return {
        kind: "invalid_image",
        code: "EMPTY_FILE",
        title: "That photo is empty",
        message: "The file had no contents. Please pick it again or take a new photo.",
        retryable: false,
      };
    case "encode_failed":
    default:
      return {
        kind: "unsupported_device",
        code: "ENCODE_FAILED",
        title: "We could not prepare that photo",
        message: "Something went wrong preparing the photo on this device. Please try again.",
        retryable: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface ReceiptSubmissionInput {
  readonly blob: Blob;
  /**
   * Generated ONCE per submission by the caller (see this file's header). Every
   * retry of the same photo must pass the same value.
   */
  readonly idempotencyKey: string;
  readonly businessId?: string | undefined;
  readonly clientSha256?: string | undefined;
  /** A path from an earlier attempt whose upload already succeeded. */
  readonly imagePath?: string | null | undefined;
}

export type ReceiptSubmissionOutcome =
  | { readonly ok: true; readonly receiptId: string; readonly status: string; readonly imagePath: string }
  | { readonly ok: false; readonly error: CaptureError; readonly imagePath: string | null };

export interface ReceiptSubmissionDeps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly isOnline?: (() => boolean) | undefined;
}

interface Envelope {
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

async function readEnvelope(response: Response): Promise<Envelope> {
  try {
    return (await response.json()) as Envelope;
  } catch {
    return {};
  }
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultIsOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/**
 * Run the three steps, resuming from a previous attempt's upload where possible.
 *
 * The returned `imagePath` is part of the contract in BOTH branches: the caller
 * stores it and feeds it back in on retry so the submit body cannot drift under
 * a reused Idempotency-Key.
 */
export async function submitCapturedReceipt(
  input: ReceiptSubmissionInput,
  deps: ReceiptSubmissionDeps = {},
): Promise<ReceiptSubmissionOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const isOnline = deps.isOnline ?? defaultIsOnline;
  let imagePath = input.imagePath ?? null;

  if (!isOnline()) {
    return { ok: false, error: networkError(true), imagePath };
  }

  try {
    if (imagePath === null) {
      const ticketResponse = await doFetch("/api/v1/receipts/uploads", { method: "POST" });
      const ticket = await readEnvelope(ticketResponse);

      if (!ticketResponse.ok) {
        return {
          ok: false,
          error: mapSubmitError(
            ticketResponse.status,
            ticket.error?.code,
            ticket.error?.message,
            parseRetryAfter(ticketResponse.headers.get("Retry-After")),
          ),
          imagePath,
        };
      }

      const uploadUrl = stringField(ticket.data, "upload_url");
      const path = stringField(ticket.data, "image_path");
      if (uploadUrl === undefined || path === undefined) {
        return {
          ok: false,
          error: mapSubmitError(502, "DEPENDENCY_UNAVAILABLE", undefined),
          imagePath,
        };
      }

      const putResponse = await doFetch(uploadUrl, {
        method: "PUT",
        headers: { "content-type": "image/jpeg" },
        body: input.blob,
      });

      if (!putResponse.ok) {
        // The signed URL is single-use and short-lived, so a failed PUT must not
        // leave `imagePath` set: the next attempt has to mint a fresh ticket.
        // The submit body has not been sent yet, so nothing depends on the old
        // path and the Idempotency-Key is still unused.
        // NO `status` HERE, DELIBERATELY. The status belongs to the storage
        // host, not to our API, and the outbox reads `status` as "the server
        // gave a 4xx answer about this receipt, so replaying is pointless".
        // A 403 from an expired signed URL is the opposite of that: the very
        // next attempt mints a fresh ticket and succeeds. Passing it through
        // would make a routine expiry delete a consumer's queued receipt.
        return {
          ok: false,
          error: {
            kind: putResponse.status >= 500 ? "unavailable" : "unknown",
            code: "UPLOAD_FAILED",
            title: "Your photo did not finish uploading",
            message: "We could not upload that photo. Please tap Try again.",
            retryable: true,
          },
          imagePath: null,
        };
      }

      imagePath = path;
    }

    const submitResponse = await doFetch("/api/v1/receipts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        image_path: imagePath,
        ...(input.businessId === undefined ? {} : { business_id: input.businessId }),
        ...(input.clientSha256 === undefined ? {} : { client_sha256: input.clientSha256 }),
      }),
    });

    const submitted = await readEnvelope(submitResponse);

    if (!submitResponse.ok) {
      return {
        ok: false,
        error: mapSubmitError(
          submitResponse.status,
          submitted.error?.code,
          submitted.error?.message,
          parseRetryAfter(submitResponse.headers.get("Retry-After")),
        ),
        imagePath,
      };
    }

    const receiptId = stringField(submitted.data, "receipt_id");
    if (receiptId === undefined) {
      return {
        ok: false,
        error: mapSubmitError(502, "DEPENDENCY_UNAVAILABLE", undefined),
        imagePath,
      };
    }

    return {
      ok: true,
      receiptId,
      status: stringField(submitted.data, "status") ?? "queued",
      imagePath,
    };
  } catch {
    // fetch only rejects on transport failure, so this is always connectivity.
    return { ok: false, error: networkError(!isOnline()), imagePath };
  }
}

/**
 * A fresh Idempotency-Key. `crypto.randomUUID` everywhere it exists (every
 * browser on a secure origin); the `getRandomValues` fallback keeps the key
 * unguessable on an insecure origin, where dev builds and older WebViews land.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("This browser cannot generate a secure Idempotency-Key.");
}
