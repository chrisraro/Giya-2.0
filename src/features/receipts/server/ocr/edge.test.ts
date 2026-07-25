// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ./provider is imported for OcrError, and it reads the env module at import
// time. Selection is not what this file tests, so the env is stubbed out
// entirely rather than populated.
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

import { createEdgeOcrProvider } from "./edge";
import { OcrError } from "./provider";
import type { OcrRequest } from "./provider";

// The Edge Function itself is verified live against the deployed project; what
// is tested here is the CLIENT side of the seam - that this provider speaks
// doc 36 Stage 4 on the wire, and that every status the function can return
// becomes the right OcrError with the right retry decision. The retry decision
// is the load-bearing part: a transient Hugging Face throttle recorded as
// terminal would send a perfectly good receipt to `rejected` instead of trying
// again, and a terminal failure recorded as transient would burn the whole
// attempt budget reproducing it.

const FUNCTION_URL = "https://zlfxfzlnklqhajacngxf.supabase.co/functions/v1/ocr";
const SECRET = "ocr-function-secret-value";

const REQUEST: OcrRequest = {
  requestId: "req_01JEDGE",
  imageUrl: "https://zlfxfzlnklqhajacngxf.supabase.co/storage/v1/object/sign/receipts/u/a.jpg?token=x",
  preprocess: "auto",
  langs: ["en"],
  returnBlocks: true,
};

// What supabase/functions/ocr/index.ts returns on a clean transcription: the
// VLM engine identity, no preprocess ops, no blocks, and the neutral 0.5
// mean_confidence that stands in for a per-token confidence a VLM cannot give.
const OK_BODY = {
  engine: "hf-vlm",
  engine_version: "google/gemma-4-26B-A4B-it",
  preprocess_ops: [],
  raw_text: "KAPE DIARIA\nOR# 004512\nTOTAL           150.00\n",
  blocks: [],
  mean_confidence: 0.5,
  duration_ms: 1834,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchImpl = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function provider() {
  return createEdgeOcrProvider({
    functionUrl: FUNCTION_URL,
    secret: SECRET,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe("createEdgeOcrProvider", () => {
  it("reports itself as the edge provider and offers the deploy-gate probe", () => {
    const edge = provider();

    expect(edge.name).toBe("edge");
    expect(typeof edge.healthz).toBe("function");
  });

  it("posts doc 36 Stage 4's request body to the function URL with the shared secret", async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, OK_BODY));

    await provider().ocr(REQUEST);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];

    // No "/v1/ocr" suffix: a Supabase Edge Function's URL is already the
    // endpoint. Appending the container's path would 404 on the gateway.
    expect(url).toBe(FUNCTION_URL);
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    // The secret goes in Authorization exactly as the contract specifies, and
    // it is the shared secret, never the service role key.
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers["Content-Type"]).toBe("application/json");

    expect(JSON.parse(String(init.body))).toEqual({
      request_id: "req_01JEDGE",
      image_url: REQUEST.imageUrl,
      preprocess: "auto",
      langs: ["en"],
      return_blocks: true,
    });
  });

  it("tolerates a trailing slash on the configured URL", async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, OK_BODY));

    await createEdgeOcrProvider({
      functionUrl: `${FUNCTION_URL}/`,
      secret: SECRET,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).ocr(REQUEST);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(FUNCTION_URL);
  });

  it("returns the transcription camelCased, with the VLM engine identity intact", async () => {
    fetchImpl.mockResolvedValue(jsonResponse(200, OK_BODY));

    const result = await provider().ocr(REQUEST);

    expect(result).toEqual({
      // `engine` is what lands in ocr_results.engine, and it is what makes a
      // VLM-read row distinguishable from a stub row and from a future
      // paddleocr row.
      engine: "hf-vlm",
      engineVersion: "google/gemma-4-26B-A4B-it",
      preprocessOps: [],
      rawText: OK_BODY.raw_text,
      blocks: [],
      meanConfidence: 0.5,
      durationMs: 1834,
    });
  });

  it("passes the neutral 0.5 mean confidence through unchanged", async () => {
    // 0.5 is chosen so `shouldEmitLowConfidenceSignal` (strict `< 0.5`) does
    // NOT fire on every receipt, and so the Stage 9 OCR term contributes half
    // its 0.30 weight, leaving the field terms to decide routing. Any
    // rescaling here would quietly break both.
    fetchImpl.mockResolvedValue(jsonResponse(200, OK_BODY));

    const result = await provider().ocr(REQUEST);

    expect(result.meanConfidence).toBe(0.5);
  });

  it("passes a truncated read's 0 mean confidence through unchanged", async () => {
    // 0 is the function's answer when the model hit the token cap, so the
    // transcription is provably incomplete. It caps parse_confidence at 0.75,
    // below the 0.80 approve threshold, and it must not be clamped up.
    fetchImpl.mockResolvedValue(jsonResponse(200, { ...OK_BODY, mean_confidence: 0 }));

    const result = await provider().ocr(REQUEST);

    expect(result.meanConfidence).toBe(0);
  });

  it("maps 401 to a terminal auth failure", async () => {
    fetchImpl.mockResolvedValue(jsonResponse(401, { code: "UNAUTHORIZED" }));

    const error = await provider()
      .ocr(REQUEST)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OcrError);
    expect((error as OcrError).code).toBe("OCR_AUTH_FAILED");
    expect((error as OcrError).retryable).toBe(false);
    expect((error as OcrError).status).toBe(401);
  });

  it("maps 413 to a terminal too-large failure", async () => {
    fetchImpl.mockResolvedValue(jsonResponse(413, { code: "IMAGE_TOO_LARGE" }));

    const error = await provider()
      .ocr(REQUEST)
      .catch((caught: unknown) => caught);

    expect((error as OcrError).code).toBe("OCR_IMAGE_TOO_LARGE");
    expect((error as OcrError).retryable).toBe(false);
  });

  it("maps 422 IMAGE_UNREADABLE to the terminal unreadable path", async () => {
    // The function answers this when the model returned no usable text.
    // Terminal on purpose: retrying the same photo produces the same nothing,
    // and doc 36 Stage 9 already has an honest home for it.
    fetchImpl.mockResolvedValue(
      jsonResponse(422, { code: "IMAGE_UNREADABLE", message: "Transcription model returned no text." }),
    );

    const error = await provider()
      .ocr(REQUEST)
      .catch((caught: unknown) => caught);

    expect((error as OcrError).code).toBe("OCR_IMAGE_UNREADABLE");
    expect((error as OcrError).retryable).toBe(false);
    expect((error as OcrError).message).toContain("IMAGE_UNREADABLE");
  });

  it("maps 503 to a RETRYABLE failure, which is how a throttled free tier degrades", async () => {
    // The HF account has no billing, so 402 and 429 upstream are expected
    // operating conditions. The function folds them onto 503, and this is the
    // assertion that they degrade to "try again" rather than to a fabricated
    // transcription.
    fetchImpl.mockResolvedValue(
      jsonResponse(503, { code: "VLM_UNAVAILABLE", message: "status 429" }),
    );

    const error = await provider()
      .ocr(REQUEST)
      .catch((caught: unknown) => caught);

    expect((error as OcrError).code).toBe("OCR_UNAVAILABLE");
    expect((error as OcrError).retryable).toBe(true);
    expect((error as OcrError).status).toBe(503);
  });

  it("never yields a transcription when the service fails", async () => {
    // The property that matters more than any single mapping: no failure path
    // returns text. An OCR failure routes a receipt to review; it can never
    // become an award (plan risk 3).
    for (const status of [401, 413, 422, 429, 500, 503]) {
      fetchImpl.mockResolvedValue(jsonResponse(status, { code: "NOPE" }));

      const outcome = await provider()
        .ocr(REQUEST)
        .then(() => "resolved" as const)
        .catch(() => "rejected" as const);

      expect(outcome, `status ${status} must reject`).toBe("rejected");
    }
  });

  it("maps a transport failure to a retryable unavailable", async () => {
    fetchImpl.mockRejectedValue(new TypeError("fetch failed"));

    const error = await provider()
      .ocr(REQUEST)
      .catch((caught: unknown) => caught);

    expect((error as OcrError).code).toBe("OCR_UNAVAILABLE");
    expect((error as OcrError).retryable).toBe(true);
  });

  it("reports the worker timeout as a retryable OCR_TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      fetchImpl.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );

      const pending = createEdgeOcrProvider({
        functionUrl: FUNCTION_URL,
        secret: SECRET,
        timeoutMs: 1_000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
        .ocr(REQUEST)
        .catch((caught: unknown) => caught);

      await vi.advanceTimersByTimeAsync(1_001);
      const error = await pending;

      expect((error as OcrError).code).toBe("OCR_TIMEOUT");
      expect((error as OcrError).retryable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a 200 whose body is not the Stage 4 contract", async () => {
    // A deployment mismatch, not a transient fault: the next attempt gets the
    // identical body, so retrying only spends the budget.
    fetchImpl.mockResolvedValue(jsonResponse(200, { engine: "hf-vlm" }));

    const error = await provider()
      .ocr(REQUEST)
      .catch((caught: unknown) => caught);

    expect((error as OcrError).code).toBe("OCR_BAD_RESPONSE");
    expect((error as OcrError).retryable).toBe(false);
  });

  it("probes health on the /healthz suffix of the function URL", async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse(200, { status: "ok", engine_version: "google/gemma-4-26B-A4B-it" }),
    );

    const health = await provider().healthz?.();

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${FUNCTION_URL}/healthz`);
    expect(health).toEqual({ status: "ok", engineVersion: "google/gemma-4-26B-A4B-it" });
  });
});
