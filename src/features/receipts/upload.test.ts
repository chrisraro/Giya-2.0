import { describe, it, expect, vi } from "vitest";

import {
  formatRetryAfter,
  mapCaptureRejection,
  mapSubmitError,
  networkError,
  newIdempotencyKey,
  submitCapturedReceipt,
} from "./upload";

const IDEMPOTENCY_KEY = "11111111-2222-4333-8444-555555555555";
const IMAGE_PATH = "0d5a3f0c-1111-4111-8111-111111111111/2b8f0c1a-2222-4222-8222-222222222222.jpg";
const UPLOAD_URL = "https://storage.example/object/upload/sign/receipts/x?token=abc";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function ticketResponse(): Response {
  return jsonResponse(200, {
    data: { upload_url: UPLOAD_URL, image_path: IMAGE_PATH, token: "abc" },
  });
}

function acceptedResponse(): Response {
  return jsonResponse(202, { data: { receipt_id: "receipt-1", status: "queued" } });
}

function blob(): Blob {
  return new Blob(["bytes"], { type: "image/jpeg" });
}

function headerOf(call: unknown[], name: string): string | undefined {
  const init = call[1] as RequestInit | undefined;
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe("formatRetryAfter", () => {
  it("says later when there is no Retry-After to go on", () => {
    expect(formatRetryAfter(undefined)).toBe("later");
    expect(formatRetryAfter(0)).toBe("later");
  });

  it("stays vague under a minute and a half", () => {
    expect(formatRetryAfter(30)).toBe("in a moment");
  });

  it("rounds to minutes and hours", () => {
    expect(formatRetryAfter(600)).toBe("in about 10 minutes");
    expect(formatRetryAfter(3600)).toBe("in about an hour");
    expect(formatRetryAfter(3 * 3600)).toBe("in about 3 hours");
  });

  it("collapses anything past a day into tomorrow", () => {
    expect(formatRetryAfter(30 * 3600)).toBe("tomorrow");
  });
});

describe("mapSubmitError", () => {
  it("maps 403 CONSUMER_SCAN_BLOCKED to scan-limit copy that never explains why", () => {
    const error = mapSubmitError(403, "CONSUMER_SCAN_BLOCKED", "server copy", 7200);

    expect(error.kind).toBe("blocked");
    expect(error.title).toBe("Scan limit reached");
    expect(error.message).toBe(
      "You have reached the scan limit for now. Please try again in about 2 hours.",
    );
    // Doc 33: fraud internals are never exposed. Nothing about cooldowns,
    // signals, scores or suspicion may appear in consumer copy.
    expect(error.message.toLowerCase()).not.toMatch(/fraud|suspicious|cooldown|blocked|signal/);
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBe(7200);
  });

  it("maps 422 RECEIPT_DUPLICATE to already-scanned copy that cannot be retried", () => {
    const error = mapSubmitError(422, "RECEIPT_DUPLICATE", "server copy");

    expect(error.kind).toBe("duplicate");
    expect(error.message).toContain("already scanned this receipt");
    expect(error.retryable).toBe(false);
  });

  it("maps 400 RECEIPT_INVALID_IMAGE to a retake, not a retry", () => {
    const error = mapSubmitError(400, "RECEIPT_INVALID_IMAGE", "server copy");

    expect(error.kind).toBe("invalid_image");
    expect(error.retryable).toBe(false);
  });

  it("maps 429 to scan-limit copy carrying the Retry-After window", () => {
    const error = mapSubmitError(429, "RATE_LIMITED", "server copy", 900);

    expect(error.kind).toBe("rate_limited");
    expect(error.message).toBe("You have reached the scan limit. Please try again in about 15 minutes.");
    expect(error.retryable).toBe(false);
  });

  it("maps 401 to a sign-in prompt", () => {
    expect(mapSubmitError(401, "UNAUTHENTICATED", undefined).kind).toBe("unauthenticated");
  });

  it("maps a still-running idempotent request to a retryable wait", () => {
    const error = mapSubmitError(409, "IDEMPOTENCY_IN_PROGRESS", "server copy");

    expect(error.kind).toBe("in_progress");
    expect(error.retryable).toBe(true);
  });

  it("maps 503 and 500 to a retryable unavailable state", () => {
    expect(mapSubmitError(503, "DEPENDENCY_UNAVAILABLE", undefined).retryable).toBe(true);
    expect(mapSubmitError(500, "INTERNAL", undefined).kind).toBe("unavailable");
  });

  it("falls back to the server message verbatim for an unmapped code", () => {
    const error = mapSubmitError(422, "VALIDATION_FAILED", "Some of the information needs attention.");

    expect(error.kind).toBe("unknown");
    expect(error.message).toBe("Some of the information needs attention.");
    expect(error.retryable).toBe(true);
  });
});

describe("networkError and mapCaptureRejection", () => {
  it("distinguishes offline from a failed request, and keeps both retryable", () => {
    expect(networkError(true).title).toBe("You are offline");
    expect(networkError(false).title).toBe("Connection problem");
    expect(networkError(true).retryable).toBe(true);
  });

  it("explains the 10MB limit for an oversized pick", () => {
    const error = mapCaptureRejection("too_large");
    expect(error.message).toContain("under 10MB");
    expect(error.retryable).toBe(false);
  });

  it("names the accepted formats for an unsupported pick", () => {
    expect(mapCaptureRejection("unsupported_format").message).toContain("JPEG");
  });

  it("explains a HEIC decode failure in device terms, not format terms", () => {
    const error = mapCaptureRejection("decode_failed");
    expect(error.kind).toBe("unsupported_device");
    expect(error.message).toContain("HEIC");
  });
});

describe("newIdempotencyKey", () => {
  it("produces distinct UUID-shaped keys", () => {
    const first = newIdempotencyKey();
    const second = newIdempotencyKey();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(first).not.toBe(second);
  });
});

describe("submitCapturedReceipt", () => {
  it("runs the three steps and returns the receipt id from the 202", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ticketResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(acceptedResponse());

    const outcome = await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY, businessId: "biz-1" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true },
    );

    expect(outcome).toMatchObject({ ok: true, receiptId: "receipt-1", imagePath: IMAGE_PATH });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/v1/receipts/uploads");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(UPLOAD_URL);
    expect((fetchImpl.mock.calls[1]?.[1] as RequestInit).method).toBe("PUT");
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("/api/v1/receipts");
    expect(headerOf(fetchImpl.mock.calls[2] ?? [], "Idempotency-Key")).toBe(IDEMPOTENCY_KEY);
    expect(JSON.parse((fetchImpl.mock.calls[2]?.[1] as RequestInit).body as string)).toEqual({
      image_path: IMAGE_PATH,
      business_id: "biz-1",
    });
  });

  it("omits business_id entirely for a generic scan", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ticketResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(acceptedResponse());

    await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY, clientSha256: "a".repeat(64) },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true },
    );

    expect(JSON.parse((fetchImpl.mock.calls[2]?.[1] as RequestInit).body as string)).toEqual({
      image_path: IMAGE_PATH,
      client_sha256: "a".repeat(64),
    });
  });

  it("skips the upload steps when a previous attempt already stored the bytes", async () => {
    // This is what keeps a retry's body byte-identical under the same
    // Idempotency-Key: a fresh path would be a different body, and the shared
    // handler answers that with 409 IDEMPOTENCY_REPLAYED instead of replaying.
    const fetchImpl = vi.fn().mockResolvedValueOnce(acceptedResponse());

    const outcome = await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY, imagePath: IMAGE_PATH },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true },
    );

    expect(outcome.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/v1/receipts");
  });

  it("reports offline without making any request at all", async () => {
    const fetchImpl = vi.fn();

    const outcome = await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => false },
    );

    expect(outcome).toMatchObject({ ok: false, imagePath: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    if (!outcome.ok) expect(outcome.error.kind).toBe("network");
  });

  it("treats a thrown fetch as a connection problem", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    const outcome = await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe("network");
  });

  it("clears the image path when the PUT fails, so the next attempt mints a fresh ticket", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ticketResponse())
      .mockResolvedValueOnce(new Response(null, { status: 400 }));

    const outcome = await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true },
    );

    expect(outcome).toMatchObject({ ok: false, imagePath: null });
    if (!outcome.ok) expect(outcome.error.retryable).toBe(true);
  });

  it("returns the path alongside a submit failure so a retry can reuse it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ticketResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: "DEPENDENCY_UNAVAILABLE" } }));

    const outcome = await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true },
    );

    expect(outcome).toMatchObject({ ok: false, imagePath: IMAGE_PATH });
  });

  it("reads Retry-After off a 403 CONSUMER_SCAN_BLOCKED response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ticketResponse())
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        jsonResponse(
          403,
          { error: { code: "CONSUMER_SCAN_BLOCKED", message: "paused" } },
          { "Retry-After": "3600" },
        ),
      );

    const outcome = await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("blocked");
      expect(outcome.error.retryAfterSeconds).toBe(3600);
      expect(outcome.error.message).toContain("in about an hour");
    }
  });

  it("fails cleanly when the upload ticket comes back without a URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: {} }));

    const outcome = await submitCapturedReceipt(
      { blob: blob(), idempotencyKey: IDEMPOTENCY_KEY },
      { fetchImpl: fetchImpl as unknown as typeof fetch, isOnline: () => true },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe("unavailable");
  });
});
