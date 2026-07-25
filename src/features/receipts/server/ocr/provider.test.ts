// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const serverEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => serverEnv,
}));

import { OcrError, getOcrProvider } from "./provider";

afterEach(() => {
  delete serverEnv.OCR_SERVICE_URL;
  delete serverEnv.OCR_SERVICE_TOKEN;
  delete serverEnv.SUPABASE_EDGE_OCR_URL;
  delete serverEnv.OCR_FUNCTION_SECRET;
  vi.restoreAllMocks();
});

describe("getOcrProvider", () => {
  it("selects the stub when OCR_SERVICE_URL is unset (today's default)", () => {
    const provider = getOcrProvider();

    expect(provider.name).toBe("stub");
    expect(provider.healthz).toBeUndefined();
  });

  it("selects the http provider when both variables are set (no other code change)", () => {
    serverEnv.OCR_SERVICE_URL = "https://ocr.example.dev";
    serverEnv.OCR_SERVICE_TOKEN = "ocr-service-token";

    const provider = getOcrProvider();

    expect(provider.name).toBe("http");
    expect(typeof provider.healthz).toBe("function");
  });

  it("throws rather than silently falling back to the stub when the token is missing", () => {
    // A silent fallback here would feed the pipeline fabricated receipt text
    // in production and award real points for receipts nobody photographed.
    serverEnv.OCR_SERVICE_URL = "https://ocr.example.dev";

    expect(() => getOcrProvider()).toThrow(OcrError);
    expect(() => getOcrProvider()).toThrow(/OCR_SERVICE_TOKEN/);
  });

  it("reports the misconfiguration as non-retryable", () => {
    serverEnv.OCR_SERVICE_URL = "https://ocr.example.dev";

    try {
      getOcrProvider();
      expect.unreachable("expected getOcrProvider to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(OcrError);
      expect((error as OcrError).code).toBe("OCR_MISCONFIGURED");
      expect((error as OcrError).retryable).toBe(false);
    }
  });

  it("ignores a stray token when no url is configured", () => {
    // Token-without-url is not ambiguous: nothing to call, so the stub is the
    // only possible reading and there is nothing to warn about.
    serverEnv.OCR_SERVICE_TOKEN = "ocr-service-token";

    expect(getOcrProvider().name).toBe("stub");
  });

  it("selects the edge provider when the Edge Function pair is set", () => {
    serverEnv.SUPABASE_EDGE_OCR_URL =
      "https://zlfxfzlnklqhajacngxf.supabase.co/functions/v1/ocr";
    serverEnv.OCR_FUNCTION_SECRET = "ocr-function-secret";

    const provider = getOcrProvider();

    expect(provider.name).toBe("edge");
    expect(typeof provider.healthz).toBe("function");
  });

  it("prefers the container over the Edge Function when both are configured", () => {
    // The container is the escape hatch from the metered third-party VLM.
    // Switching to it must be one variable added, never two removed first.
    serverEnv.OCR_SERVICE_URL = "https://ocr.example.dev";
    serverEnv.OCR_SERVICE_TOKEN = "ocr-service-token";
    serverEnv.SUPABASE_EDGE_OCR_URL =
      "https://zlfxfzlnklqhajacngxf.supabase.co/functions/v1/ocr";
    serverEnv.OCR_FUNCTION_SECRET = "ocr-function-secret";

    expect(getOcrProvider().name).toBe("http");
  });

  it("throws rather than falling back when the Edge Function secret is missing", () => {
    // Same rule as the container pair, same reason: a silent fall-through to
    // the stub would feed the pipeline fabricated receipt text in production
    // and award real points for receipts nobody photographed.
    serverEnv.SUPABASE_EDGE_OCR_URL =
      "https://zlfxfzlnklqhajacngxf.supabase.co/functions/v1/ocr";

    expect(() => getOcrProvider()).toThrow(OcrError);
    expect(() => getOcrProvider()).toThrow(/OCR_FUNCTION_SECRET/);

    try {
      getOcrProvider();
      expect.unreachable("expected getOcrProvider to throw");
    } catch (error) {
      expect((error as OcrError).code).toBe("OCR_MISCONFIGURED");
      expect((error as OcrError).retryable).toBe(false);
    }
  });

  it("does not let a stray Edge Function secret change the stub default", () => {
    serverEnv.OCR_FUNCTION_SECRET = "ocr-function-secret";

    expect(getOcrProvider().name).toBe("stub");
  });
});

describe("OcrError", () => {
  it("carries the code, the retry decision and the status", () => {
    const error = new OcrError("OCR_UNAVAILABLE", "overloaded", {
      retryable: true,
      status: 503,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("OcrError");
    expect(error.code).toBe("OCR_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(503);
  });

  it("preserves the underlying cause when there is one", () => {
    const cause = new TypeError("fetch failed");
    const error = new OcrError("OCR_UNAVAILABLE", "unreachable", { retryable: true, cause });

    expect(error.cause).toBe(cause);
  });
});
