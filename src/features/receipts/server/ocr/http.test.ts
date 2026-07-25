// @vitest-environment node
//
// Server-only HTTP client with no DOM dependency; runs under plain Node like
// the other server modules in this codebase.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// This module needs no environment at all; it reaches @/lib/env only because
// it imports the shared types and OcrError from ./provider, and @/lib/env
// validates the client schema at module scope.
vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => ({}),
}));

import { OCR_WORKER_TIMEOUT_MS, createHttpOcrProvider } from "./http";
import { OcrError } from "./provider";
import type { OcrRequest } from "./provider";

const BASE_URL = "https://ocr.example.dev";
const TOKEN = "ocr-service-token";

const REQUEST: OcrRequest = {
  requestId: "req_01JABCDEF",
  imageUrl: "https://storage.example.dev/signed/receipt.jpg",
  preprocess: "auto",
  langs: ["en"],
  returnBlocks: true,
};

// The documented 200 body, doc 36 Stage 4, verbatim in shape.
const OK_BODY = {
  engine: "paddleocr",
  engine_version: "2.8.1",
  preprocess_ops: ["perspective", "deskew", "adaptive_threshold"],
  raw_text: "JOLLI CAFE\nTIN 123-456-789-000\nTOTAL 245.00",
  blocks: [{ text: "TOTAL 245.00", bbox: [34, 812, 310, 840], conf: 0.97 }],
  mean_confidence: 0.91,
  duration_ms: 2140,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchReturning(response: Response): typeof fetch {
  return vi.fn(() => Promise.resolve(response)) as unknown as typeof fetch;
}

/** A fetch that never settles until its abort signal fires. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    });
  })) as unknown as typeof fetch;

async function expectOcrError(promise: Promise<unknown>): Promise<OcrError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OcrError);
    return error as OcrError;
  }
  throw new Error("expected the call to reject with an OcrError");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createHttpOcrProvider - request shape (doc 36 Stage 4)", () => {
  it("POSTs {OCR_SERVICE_URL}/v1/ocr", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(OK_BODY)));
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.ocr(REQUEST);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ocr.example.dev/v1/ocr");
    expect(init.method).toBe("POST");
  });

  it("tolerates a trailing slash on the configured base url", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(OK_BODY)));
    const provider = createHttpOcrProvider({
      baseUrl: `${BASE_URL}/`,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.ocr(REQUEST);

    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://ocr.example.dev/v1/ocr",
    );
  });

  it("sends the bearer service token", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(OK_BODY)));
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.ocr(REQUEST);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends the documented snake_case body", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(OK_BODY)));
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.ocr({ ...REQUEST, preprocess: ["deskew", "adaptive_threshold"] });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      request_id: "req_01JABCDEF",
      image_url: "https://storage.example.dev/signed/receipt.jpg",
      preprocess: ["deskew", "adaptive_threshold"],
      langs: ["en"],
      return_blocks: true,
    });
  });

  it("defaults return_blocks to true (the parser's layout tier needs bboxes)", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(OK_BODY)));
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.ocr({
      requestId: "req_x",
      imageUrl: "https://example.dev/a.jpg",
      preprocess: "auto",
      langs: ["en"],
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).return_blocks).toBe(true);
  });

  it("passes an abort signal so the 30s worker timeout can fire", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse(OK_BODY)));
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.ocr(REQUEST);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("defaults the worker timeout to the documented 30s", () => {
    expect(OCR_WORKER_TIMEOUT_MS).toBe(30_000);
  });

  it("uses the global fetch when none is injected", async () => {
    const globalFetch = vi.fn(() => Promise.resolve(jsonResponse(OK_BODY)));
    vi.stubGlobal("fetch", globalFetch);

    const provider = createHttpOcrProvider({ baseUrl: BASE_URL, token: TOKEN });
    await provider.ocr(REQUEST);

    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

describe("createHttpOcrProvider - success mapping", () => {
  it("camelCases the documented response", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse(OK_BODY)),
    });

    await expect(provider.ocr(REQUEST)).resolves.toEqual({
      engine: "paddleocr",
      engineVersion: "2.8.1",
      preprocessOps: ["perspective", "deskew", "adaptive_threshold"],
      rawText: "JOLLI CAFE\nTIN 123-456-789-000\nTOTAL 245.00",
      blocks: [{ text: "TOTAL 245.00", bbox: [34, 812, 310, 840], conf: 0.97 }],
      meanConfidence: 0.91,
      durationMs: 2140,
    });
  });

  it("clamps an out-of-range mean confidence instead of failing the response", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse({ ...OK_BODY, mean_confidence: 1.4 })),
    });

    await expect(provider.ocr(REQUEST)).resolves.toMatchObject({ meanConfidence: 1 });
  });

  it("defaults absent optional collections rather than rejecting", async () => {
    const withoutCollections = {
      engine: OK_BODY.engine,
      engine_version: OK_BODY.engine_version,
      raw_text: OK_BODY.raw_text,
      mean_confidence: OK_BODY.mean_confidence,
      duration_ms: OK_BODY.duration_ms,
    };
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse(withoutCollections)),
    });

    const result = await provider.ocr(REQUEST);

    expect(result.preprocessOps).toEqual([]);
    expect(result.blocks).toEqual([]);
  });
});

describe("createHttpOcrProvider - status mapping and retryability", () => {
  const cases: Array<{
    label: string;
    response: Response;
    code: string;
    retryable: boolean;
  }> = [
    {
      label: "401 bad token",
      response: jsonResponse({ code: "UNAUTHORIZED" }, 401),
      code: "OCR_AUTH_FAILED",
      retryable: false,
    },
    {
      label: "413 image too large",
      response: jsonResponse({ code: "PAYLOAD_TOO_LARGE" }, 413),
      code: "OCR_IMAGE_TOO_LARGE",
      retryable: false,
    },
    {
      label: "422 IMAGE_UNREADABLE",
      response: jsonResponse({ code: "IMAGE_UNREADABLE" }, 422),
      code: "OCR_IMAGE_UNREADABLE",
      retryable: false,
    },
    {
      label: "503 overloaded",
      response: jsonResponse({ code: "OVERLOADED" }, 503),
      code: "OCR_UNAVAILABLE",
      retryable: true,
    },
  ];

  for (const testCase of cases) {
    it(`maps ${testCase.label} to ${testCase.code} (retryable=${testCase.retryable})`, async () => {
      const provider = createHttpOcrProvider({
        baseUrl: BASE_URL,
        token: TOKEN,
        fetchImpl: fetchReturning(testCase.response),
      });

      const error = await expectOcrError(provider.ocr(REQUEST));

      expect(error.code).toBe(testCase.code);
      expect(error.retryable).toBe(testCase.retryable);
      expect(error.status).toBe(testCase.response.status);
    });
  }

  it("treats a 422 with no body code as unreadable too, and never retries it", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(new Response("not json", { status: 422 })),
    });

    const error = await expectOcrError(provider.ocr(REQUEST));

    expect(error.code).toBe("OCR_IMAGE_UNREADABLE");
    expect(error.retryable).toBe(false);
  });

  it("treats other 5xx and 429 as retryable unavailability", async () => {
    for (const status of [429, 500, 502]) {
      const provider = createHttpOcrProvider({
        baseUrl: BASE_URL,
        token: TOKEN,
        fetchImpl: fetchReturning(jsonResponse({}, status)),
      });

      const error = await expectOcrError(provider.ocr(REQUEST));

      expect(error.code).toBe("OCR_UNAVAILABLE");
      expect(error.retryable).toBe(true);
    }
  });

  it("treats an unmapped 4xx as a non-retryable bad response", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse({}, 400)),
    });

    const error = await expectOcrError(provider.ocr(REQUEST));

    expect(error.code).toBe("OCR_BAD_RESPONSE");
    expect(error.retryable).toBe(false);
  });
});

describe("createHttpOcrProvider - timeout and transport", () => {
  it("maps the worker timeout to a retryable OCR_TIMEOUT", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      timeoutMs: 5,
      fetchImpl: hangingFetch,
    });

    const error = await expectOcrError(provider.ocr(REQUEST));

    expect(error.code).toBe("OCR_TIMEOUT");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("5ms");
  });

  it("maps a transport failure to retryable unavailability", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch,
    });

    const error = await expectOcrError(provider.ocr(REQUEST));

    expect(error.code).toBe("OCR_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });
});

describe("createHttpOcrProvider - malformed success bodies", () => {
  it("does not crash on a non-JSON 200", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(new Response("<html>gateway</html>", { status: 200 })),
    });

    const error = await expectOcrError(provider.ocr(REQUEST));

    expect(error.code).toBe("OCR_BAD_RESPONSE");
    expect(error.retryable).toBe(false);
  });

  it("rejects a 200 whose shape does not match the contract", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse({ engine: "paddleocr", raw_text: 42 })),
    });

    const error = await expectOcrError(provider.ocr(REQUEST));

    expect(error.code).toBe("OCR_BAD_RESPONSE");
    expect(error.retryable).toBe(false);
  });

  it("rejects a block whose bbox is not four numbers", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(
        jsonResponse({
          ...OK_BODY,
          blocks: [{ text: "TOTAL", bbox: [1, 2], conf: 0.9 }],
        }),
      ),
    });

    await expect(provider.ocr(REQUEST)).rejects.toBeInstanceOf(OcrError);
  });
});

describe("createHttpOcrProvider - healthz (doc 36 Stage 4 deploy gate)", () => {
  it("GETs /healthz and maps the body", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ status: "ok", engine_version: "2.8.1" })),
    );
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.healthz?.()).resolves.toEqual({
      status: "ok",
      engineVersion: "2.8.1",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ocr.example.dev/healthz");
    expect(init.method).toBe("GET");
  });

  it("maps a failing probe through the same taxonomy", async () => {
    const provider = createHttpOcrProvider({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchImpl: fetchReturning(jsonResponse({}, 503)),
    });

    const error = await expectOcrError(provider.healthz?.() ?? Promise.resolve());

    expect(error.code).toBe("OCR_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });
});
