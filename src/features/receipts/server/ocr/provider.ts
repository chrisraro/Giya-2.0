import "server-only";

import { getServerEnv } from "@/lib/env";

import { createEdgeOcrProvider } from "./edge";
import { createHttpOcrProvider } from "./http";
import { createStubOcrProvider } from "./stub";

// The OCR boundary, per docs/30-modules/36-receipt-ocr-pipeline.md Stage 4 and
// the spec's section 2. One interface, three implementations:
//
//   httpOcrProvider - the PaddleOCR + OpenCV container (decision D1),
//     dormant until its URL and token exist.
//   edgeOcrProvider - the Supabase Edge Function in supabase/functions/ocr,
//     which transcribes with a Hugging Face VLM. This is the live path
//     (spec section 2.1).
//   stubOcrProvider - deterministic fabricated PH receipt text, so the whole
//     pipeline is exercisable and testable offline.
//
// Selection is by which URL is present. Adding an implementation changed
// nothing downstream: all three answer the same contract, so no pipeline code
// knows which one ran.

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
 * The error taxonomy of doc 36 Stage 4, plus the failure modes any HTTP client
 * has to name for itself.
 *
 * ---------------------------------------------------------------------------
 * THE TAXONOMY'S FIRST QUESTION IS WHOSE FAULT IT WAS (D7).
 * ---------------------------------------------------------------------------
 * Every code below belongs to exactly one of two families, and `ocrFailureFault`
 * is the mapping. The split is not cosmetic: it decides what a paying consumer
 * is told about a photograph they cannot see anything wrong with.
 *
 *   IMAGE   The photograph is genuinely the problem. Blaming it is correct,
 *           and the retake call to action is the honest next step.
 *   OPERATOR We failed. Quota exhausted, a credential rejected, a service half
 *           deployed, a provider down, a body we could not parse. NONE of these
 *           is evidence about the image, and telling a consumer "we could not
 *           read this photo" when the truth is "we ran out of Vision credit" is
 *           a lie that also sends them to retake a perfectly good receipt.
 *
 * `retryable` answers a different question - will another attempt help - and the
 * two are independent. OCR_AUTH_FAILED is not retryable AND is our fault;
 * OCR_IMAGE_UNREADABLE is not retryable and is not. Deriving one from the other
 * is exactly the conflation that made a billing lapse read as a bad photo.
 */
export type OcrErrorCode =
  /** 401: bad or missing service token. OPERATOR: our credential, not their photo. */
  | "OCR_AUTH_FAILED"
  /** 413: image too large for the service. IMAGE. */
  | "OCR_IMAGE_TOO_LARGE"
  /** 422 {"code":"IMAGE_UNREADABLE"}: the service could not read the image. IMAGE. */
  | "OCR_IMAGE_UNREADABLE"
  /**
   * 503 or a transport failure: the service is overloaded or unreachable.
   * OPERATOR. Retryable by construction, and if the attempt budget runs out the
   * receipt routes to review - never to a fabricated transcription, and since
   * D7 never to a rejection either.
   */
  | "OCR_UNAVAILABLE"
  /**
   * 503 {"code":"VISION_QUOTA_EXHAUSTED"}: the OCR engine's quota is spent.
   * OPERATOR, and split out of OCR_UNAVAILABLE deliberately.
   *
   * Google Cloud Vision's free tier is 1,000 units a month, so this is not a
   * hypothetical: it is what the last week of a month looks like on a project
   * where billing was never enabled, and it arrives as a cliff rather than a
   * blip. Folded into OCR_UNAVAILABLE it reads in `ocr_results.error` as "Google
   * had a bad minute" and an operator waits for it to pass, which it never does.
   * Named, the row says what to do: enable billing, or raise the quota.
   *
   * Retryable in the same sense as any 503 - a per-minute throttle clears in a
   * minute - so the attempt budget still applies, and the terminal state is the
   * operator one.
   */
  | "OCR_QUOTA_EXHAUSTED"
  /** The 30s worker HTTP timeout elapsed. OPERATOR. */
  | "OCR_TIMEOUT"
  /**
   * A 200 whose body is not the documented shape, or an unmapped status.
   * OPERATOR: a shape mismatch is a deployment mismatch between this app and
   * the OCR service, and the consumer's photo had no part in it.
   */
  | "OCR_BAD_RESPONSE"
  /**
   * A URL is configured without its credential: OCR_SERVICE_URL without
   * OCR_SERVICE_TOKEN, or SUPABASE_EDGE_OCR_URL without OCR_FUNCTION_SECRET.
   * OPERATOR, and the most clearly ours of all of them.
   */
  | "OCR_MISCONFIGURED";

/**
 * Whose failure a code describes (D7). See the taxonomy comment above.
 *
 * A TOTAL RECORD, not a function with a default, so adding a code to
 * `OcrErrorCode` without deciding whose fault it is fails to compile. The
 * default that would otherwise be written is `"operator"` - which is the safe
 * direction, since it can only ever cost a review - but a silent default is
 * how the distinction rots back into a boolean.
 */
export const OCR_FAILURE_FAULT: Record<OcrErrorCode, "image" | "operator"> = {
  OCR_IMAGE_UNREADABLE: "image",
  OCR_IMAGE_TOO_LARGE: "image",
  OCR_AUTH_FAILED: "operator",
  OCR_MISCONFIGURED: "operator",
  OCR_QUOTA_EXHAUSTED: "operator",
  OCR_UNAVAILABLE: "operator",
  OCR_TIMEOUT: "operator",
  OCR_BAD_RESPONSE: "operator",
};

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
  readonly name: "http" | "edge" | "stub";
  ocr(request: OcrRequest): Promise<OcrResponse>;
  /** Present on the two network providers (doc 36 Stage 4 deploy gate). */
  healthz?(): Promise<OcrHealth>;
}

/**
 * The provider the pipeline runs against.
 *
 * SELECTION ORDER: OCR_SERVICE_URL, then SUPABASE_EDGE_OCR_URL, then the stub.
 *
 * The container outranks the Edge Function deliberately, and not because it is
 * better today - it does not exist today. It is the escape hatch. The Edge
 * Function's engine is a third-party VLM on a metered account, and the one
 * response to it failing badly (a quality regression, a provider change, an
 * exhausted quota) is to stand up the container and point OCR_SERVICE_URL at
 * it. That has to work by setting one variable on an already-configured
 * environment, without first having to find and unset the Edge Function's two.
 * A migration path that requires unsetting configuration is a migration path
 * people get wrong at 3am.
 *
 * A URL configured without its credential THROWS rather than falling back to
 * the stub, for both pairs. Both alternatives are bad, and this is the less
 * bad one:
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
  const {
    OCR_SERVICE_URL,
    OCR_SERVICE_TOKEN,
    SUPABASE_EDGE_OCR_URL,
    OCR_FUNCTION_SECRET,
  } = getServerEnv();

  if (OCR_SERVICE_URL !== undefined) {
    if (OCR_SERVICE_TOKEN === undefined) {
      throw new OcrError(
        "OCR_MISCONFIGURED",
        "OCR_SERVICE_URL is set but OCR_SERVICE_TOKEN is not. Set both to use the OCR container, or unset both to fall through to the Edge Function or the stub provider.",
        { retryable: false },
      );
    }
    return createHttpOcrProvider({ baseUrl: OCR_SERVICE_URL, token: OCR_SERVICE_TOKEN });
  }

  if (SUPABASE_EDGE_OCR_URL !== undefined) {
    if (OCR_FUNCTION_SECRET === undefined) {
      throw new OcrError(
        "OCR_MISCONFIGURED",
        "SUPABASE_EDGE_OCR_URL is set but OCR_FUNCTION_SECRET is not. Set both to use the Edge Function, or unset both to use the stub provider.",
        { retryable: false },
      );
    }
    return createEdgeOcrProvider({
      functionUrl: SUPABASE_EDGE_OCR_URL,
      secret: OCR_FUNCTION_SECRET,
    });
  }

  return createStubOcrProvider();
}
