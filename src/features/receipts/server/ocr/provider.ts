import "server-only";

import { getServerEnv } from "@/lib/env";

import { createHttpOcrProvider } from "./http";
import { createStubOcrProvider } from "./stub";

// The OCR boundary, per docs/30-modules/36-receipt-ocr-pipeline.md Stage 4 and
// the spec's section 2. One interface, two implementations:
//
//   httpOcrProvider - the real PaddleOCR + OpenCV container (decision D1),
//     dormant until its URL and token exist.
//   stubOcrProvider - deterministic fabricated PH receipt text, so the whole
//     pipeline is exercisable and testable today.
//
// Selection is by the presence of OCR_SERVICE_URL alone. When the container
// arrives, set two environment variables; no code changes anywhere.

/** The request body of `POST {OCR_SERVICE_URL}/v1/ocr` (doc 36 Stage 4). */
export interface OcrRequest {
  /** Propagated for log correlation; the same `request_id` the API envelope carries. */
  requestId: string;
  /** A 5-minute signed URL to the receipts object. */
  imageUrl: string;
  /** "auto", or an explicit op list such as ["deskew","adaptive_threshold"]. */
  preprocess: "auto" | string[];
  /** English covers PH receipts; "fil" is reserved. */
  langs: string[];
  /** Defaults to true; the parser's layout_anchors tier needs the bboxes. */
  returnBlocks?: boolean;
}

/** One OCR text block. `bbox` is `[x0, y0, x1, y1]` in image pixels. */
export interface OcrBlock {
  text: string;
  bbox: [number, number, number, number];
  conf: number;
}

/**
 * The 200 response of `POST /v1/ocr` (doc 36 Stage 4), camelCased. Persisted
 * verbatim to `ocr_results`, which is why `engine` and `engineVersion` travel
 * with it: a stub-derived row must always be distinguishable from a real one.
 */
export interface OcrResponse {
  engine: string;
  engineVersion: string;
  preprocessOps: string[];
  rawText: string;
  blocks: OcrBlock[];
  meanConfidence: number;
  durationMs: number;
}

/** Health probe response of `GET /healthz` (doc 36 Stage 4 deploy gate). */
export interface OcrHealth {
  status: string;
  engineVersion: string;
}

/**
 * The error taxonomy of doc 36 Stage 4, plus the two failure modes any HTTP
 * client has to name for itself.
 */
export type OcrErrorCode =
  /** 401: bad or missing service token. */
  | "OCR_AUTH_FAILED"
  /** 413: image too large for the service. */
  | "OCR_IMAGE_TOO_LARGE"
  /** 422 {"code":"IMAGE_UNREADABLE"}: the service could not read the image. */
  | "OCR_IMAGE_UNREADABLE"
  /** 503 or a transport failure: the service is overloaded or unreachable. */
  | "OCR_UNAVAILABLE"
  /** The 30s worker HTTP timeout elapsed. */
  | "OCR_TIMEOUT"
  /** A 200 whose body is not the documented shape, or an unmapped status. */
  | "OCR_BAD_RESPONSE"
  /** OCR_SERVICE_URL is set but OCR_SERVICE_TOKEN is not. */
  | "OCR_MISCONFIGURED";

/**
 * A failure from the OCR boundary.
 *
 * `retryable` is an explicit field rather than something the caller derives
 * from the code, because doc 36's "Retry, timeouts, DLQ" section is specific
 * about which failures earn another attempt and the answer is not guessable
 * from the HTTP status. Timeout and 503 are transient and retry inside
 * `ocr.max_attempts`. 401, 413 and 422 are terminal for this image: retrying a
 * bad token, an oversized file, or an unreadable photo produces the identical
 * failure and burns the attempt budget. In particular IMAGE_UNREADABLE is NOT
 * retried; it routes into the confidence and rejection path (Stage 9
 * `unreadable`), where a human or the consumer decides what happens next.
 */
export class OcrError extends Error {
  readonly code: OcrErrorCode;
  readonly retryable: boolean;
  /** The HTTP status when the failure came from a response, else undefined. */
  readonly status: number | undefined;

  constructor(
    code: OcrErrorCode,
    message: string,
    options: { retryable: boolean; status?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OcrError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export interface OcrProvider {
  /** Which implementation this is. Recorded so stub rows are traceable. */
  readonly name: "http" | "stub";
  ocr(request: OcrRequest): Promise<OcrResponse>;
  /** Present on the http provider only (doc 36 Stage 4 deploy gate). */
  healthz?(): Promise<OcrHealth>;
}

/**
 * The provider the pipeline runs against.
 *
 * OCR_SERVICE_URL set but OCR_SERVICE_TOKEN missing THROWS rather than falling
 * back to the stub. Both alternatives are bad, and this is the less bad one:
 *
 *   - Falling back silently is the unacceptable failure. In production it
 *     would feed the pipeline fabricated receipt text that parses cleanly, and
 *     the award path would write real `earn` rows against receipts nobody ever
 *     photographed. A points ledger corrupted by our own stub is far worse
 *     than an outage, and it would be invisible until someone noticed the
 *     `engine='stub'` rows in `ocr_results`.
 *   - Throwing at process startup would be the annoying failure: an env typo
 *     would take down auth, the business portal and everything else. So this
 *     check is NOT at module scope and NOT in the env schema (see the comment
 *     on OCR_SERVICE_URL in src/lib/env.ts).
 *
 * Throwing here puts the failure exactly where it belongs: the app boots, every
 * unrelated surface works, and the first receipt to reach the OCR stage fails
 * loudly and retryably-never with a message naming the missing variable. Half a
 * configuration is always a mistake, never an intent.
 */
export function getOcrProvider(): OcrProvider {
  const { OCR_SERVICE_URL, OCR_SERVICE_TOKEN } = getServerEnv();

  if (OCR_SERVICE_URL === undefined) {
    return createStubOcrProvider();
  }

  if (OCR_SERVICE_TOKEN === undefined) {
    throw new OcrError(
      "OCR_MISCONFIGURED",
      "OCR_SERVICE_URL is set but OCR_SERVICE_TOKEN is not. Set both to use the OCR container, or unset both to use the stub provider.",
      { retryable: false },
    );
  }

  return createHttpOcrProvider({ baseUrl: OCR_SERVICE_URL, token: OCR_SERVICE_TOKEN });
}
