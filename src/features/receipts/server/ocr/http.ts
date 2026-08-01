import "server-only";

import { z } from "zod";

import { OcrError } from "./provider";
import type { OcrHealth, OcrProvider, OcrRequest, OcrResponse } from "./provider";

// The real OCR client, per docs/30-modules/36-receipt-ocr-pipeline.md Stage 4.
// Dormant until OCR_SERVICE_URL and OCR_SERVICE_TOKEN exist; see
// ./provider.ts for the selection rule.

/**
 * Doc 36 Stage 4: "service internal budget 25s; worker HTTP timeout 30s". The
 * 5s gap is deliberate and belongs to the service, not to us: a container that
 * is doing its job returns a 4xx/5xx of its own within 25s, so a timeout on
 * this side means the container is wedged or unreachable rather than merely
 * slow, which is why the timeout is classified retryable.
 */
export const OCR_WORKER_TIMEOUT_MS = 30_000;

/** The service's internal budget, documented here so the two never drift. */
export const OCR_SERVICE_BUDGET_MS = 25_000;

export interface HttpOcrProviderConfig {
  /** `OCR_SERVICE_URL`. Trailing slashes are tolerated. */
  baseUrl: string;
  /** `OCR_SERVICE_TOKEN`, sent as `Authorization: Bearer {token}`. */
  token: string;
  /** Defaults to OCR_WORKER_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Recorded on the provider and, through it, traceable in logs. Defaults to
   * "http". ./edge.ts passes "edge" so a Supabase Edge Function call is
   * distinguishable from a container call even though both speak the identical
   * doc 36 Stage 4 protocol.
   */
  providerName?: "http" | "edge";
  /**
   * The path appended to `baseUrl` for the OCR call. Defaults to doc 36 Stage
   * 4's "/v1/ocr", which is where the container mounts it. A Supabase Edge
   * Function's URL is already the endpoint, so ./edge.ts passes "".
   *
   * This knob exists so the two HTTP implementations share one body of
   * request building, status mapping, timeout handling and response
   * validation. Duplicating it would mean two copies of the retry decisions in
   * `errorForStatus`, and those decisions are the part that must not drift:
   * the whole reason `retryable` is an explicit field is that the answer is
   * not guessable from the status.
   */
  ocrPath?: string;
}

// The documented 200 body. Validated rather than trusted: this is a separate
// process we do not deploy in lockstep with, and an OCR service that starts
// returning an HTML error page with a 200, or renames a field in a new image
// tag, must produce a clean typed failure instead of `undefined.length`
// somewhere deep inside the parser.
const ocrBlockSchema = z.object({
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  conf: z.number(),
});

const ocrResponseSchema = z.object({
  engine: z.string().min(1),
  engine_version: z.string().min(1),
  preprocess_ops: z.array(z.string()).default([]),
  raw_text: z.string(),
  blocks: z.array(ocrBlockSchema).default([]),
  mean_confidence: z.number(),
  duration_ms: z.number(),
});

const healthSchema = z.object({
  status: z.string(),
  engine_version: z.string(),
});

// The 422 body shape. `code` is optional because the only thing we act on is
// the status; see the mapping comment below.
const errorBodySchema = z.object({ code: z.string().optional() });

/** doc 36's documented 422 code. */
const IMAGE_UNREADABLE = "IMAGE_UNREADABLE";

/**
 * The 503 body code the OCR service uses to say its engine's quota is spent
 * rather than that the engine is merely busy (supabase/functions/ocr/index.ts).
 *
 * This is the ONE body code read outside the 422 branch. Everything else about
 * a 503 is the same to this client - "not now, ask again" - but a quota cliff
 * is an operator instruction ("enable billing") that a per-minute throttle is
 * not, and D7 wants that legible in `ocr_results.error` rather than reconstructed
 * from a Google Cloud console six days later.
 */
const QUOTA_EXHAUSTED = "VISION_QUOTA_EXHAUSTED";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * Confidences are a ratio by definition. A service returning 1.02 from a
 * rounding bug is a cosmetic defect, and failing the whole response over it
 * would throw away perfectly good receipt text, so the value is bounded rather
 * than rejected. Downstream, confidence.ts normalizes again; this keeps what
 * lands in `ocr_results.mean_confidence` honest as well.
 */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed = errorBodySchema.safeParse(await response.json());
    return parsed.success ? parsed.data.code : undefined;
  } catch {
    // A non-JSON error body is not itself a problem: the status already told
    // us what happened.
    return undefined;
  }
}

/**
 * Map a non-200 to the taxonomy in ./provider.ts. Doc 36 Stage 4 registers
 * exactly four statuses; the trailing branches only exist so an unregistered
 * status still produces a typed error with a deliberate retry decision rather
 * than an unhandled throw.
 */
async function errorForStatus(response: Response): Promise<OcrError> {
  const { status } = response;

  if (status === 401) {
    return new OcrError("OCR_AUTH_FAILED", "OCR service rejected the service token", {
      retryable: false,
      status,
    });
  }

  if (status === 413) {
    return new OcrError("OCR_IMAGE_TOO_LARGE", "OCR service rejected the image as too large", {
      retryable: false,
      status,
    });
  }

  if (status === 422) {
    // Any 422 maps to unreadable, whether or not the documented code came
    // back. A 422 is the service saying it processed the request and refused
    // the image; there is no second attempt that could turn that around, and
    // the pipeline already has a correct home for it (Stage 9's `unreadable`
    // rejection path). The observed code travels in the message so an
    // undocumented one is visible in the logs rather than swallowed.
    const code = await readErrorCode(response);
    return new OcrError(
      "OCR_IMAGE_UNREADABLE",
      `OCR service could not read the image (code=${code ?? IMAGE_UNREADABLE})`,
      { retryable: false, status },
    );
  }

  // 503 is doc 36's documented overload status. 429 and the rest of the 5xx
  // range are the same class of answer - "not now, ask again" - and treating
  // them as retryable is what the attempt budget in `ocr.max_attempts` is for.
  //
  // Both codes below are OPERATOR failures under D7, so neither one can reject
  // a receipt whatever the body says; the split buys the operator a diagnosis,
  // not the consumer a different outcome.
  if (status === 503 || status === 429 || status >= 500) {
    const code = await readErrorCode(response);
    if (code === QUOTA_EXHAUSTED) {
      return new OcrError(
        "OCR_QUOTA_EXHAUSTED",
        `OCR engine quota is exhausted (status=${status}, code=${code})`,
        { retryable: true, status },
      );
    }
    return new OcrError("OCR_UNAVAILABLE", `OCR service is unavailable (status=${status})`, {
      retryable: true,
      status,
    });
  }

  // Any other 4xx is a bug in the request we just built. Retrying an
  // identical malformed request cannot help.
  return new OcrError("OCR_BAD_RESPONSE", `OCR service returned status ${status}`, {
    retryable: false,
    status,
  });
}

export function createHttpOcrProvider(config: HttpOcrProviderConfig): OcrProvider {
  const timeoutMs = config.timeoutMs ?? OCR_WORKER_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;
  const providerName = config.providerName ?? "http";
  const ocrPath = config.ocrPath ?? "/v1/ocr";

  async function send(url: string, init: RequestInit): Promise<Response> {
    // An AbortController plus an explicit flag rather than AbortSignal.timeout:
    // the flag is what lets a timeout be reported as OCR_TIMEOUT instead of
    // being lumped in with a generic network abort, and the two have different
    // meanings in the logs even though both retry.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (timedOut) {
        throw new OcrError("OCR_TIMEOUT", `OCR service did not respond within ${timeoutMs}ms`, {
          retryable: true,
          cause,
        });
      }
      // DNS failure, connection refused, TLS error, socket reset. All of them
      // are "the service is not reachable right now", which is the same
      // retryable class as a 503.
      throw new OcrError("OCR_UNAVAILABLE", "OCR service could not be reached", {
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: providerName,

    async ocr(request: OcrRequest): Promise<OcrResponse> {
      const response = await send(joinUrl(config.baseUrl, ocrPath), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request_id: request.requestId,
          image_url: request.imageUrl,
          preprocess: request.preprocess,
          langs: request.langs,
          return_blocks: request.returnBlocks ?? true,
        }),
      });

      if (!response.ok) {
        throw await errorForStatus(response);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        throw new OcrError("OCR_BAD_RESPONSE", "OCR service returned a non-JSON body", {
          retryable: false,
          status: response.status,
          cause,
        });
      }

      const parsed = ocrResponseSchema.safeParse(body);
      if (!parsed.success) {
        // Not retryable: a shape mismatch is a deployment mismatch, and the
        // next attempt gets the identical body. Retrying would only spend the
        // attempt budget before landing in the same place.
        throw new OcrError(
          "OCR_BAD_RESPONSE",
          `OCR service returned an unexpected body: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
          { retryable: false, status: response.status },
        );
      }

      const data = parsed.data;
      return {
        engine: data.engine,
        engineVersion: data.engine_version,
        preprocessOps: data.preprocess_ops,
        rawText: data.raw_text,
        blocks: data.blocks.map((block) => ({
          text: block.text,
          bbox: block.bbox,
          conf: clampConfidence(block.conf),
        })),
        meanConfidence: clampConfidence(data.mean_confidence),
        durationMs: data.duration_ms,
      };
    },

    async healthz(): Promise<OcrHealth> {
      const response = await send(joinUrl(config.baseUrl, "/healthz"), {
        method: "GET",
        headers: { Authorization: `Bearer ${config.token}` },
      });

      if (!response.ok) {
        throw await errorForStatus(response);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (cause) {
        throw new OcrError("OCR_BAD_RESPONSE", "OCR health probe returned a non-JSON body", {
          retryable: false,
          status: response.status,
          cause,
        });
      }

      const parsed = healthSchema.safeParse(body);
      if (!parsed.success) {
        throw new OcrError("OCR_BAD_RESPONSE", "OCR health probe returned an unexpected body", {
          retryable: false,
          status: response.status,
        });
      }

      return { status: parsed.data.status, engineVersion: parsed.data.engine_version };
    },
  };
}
