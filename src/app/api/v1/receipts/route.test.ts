import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/v1/receipts - the rate-limit contract only. Submission itself is
// tested at src/features/receipts/server/submit.ts. A receipt is money, so both
// windows (6/min on the handler, 60/day inside it) must fail CLOSED when the
// limiter is down: failing open would remove the abuse cap during exactly the
// outage an attacker would wait for. The answer is 503, not 429, because
// telling a user to "wait until tomorrow" for our outage would be a lie.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  checkRateLimit: vi.fn(),
  submitReceipt: vi.fn(),
  setNx: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  setNx: mocks.setNx,
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(async () => 1),
}));
vi.mock("@/features/receipts/server/image", () => ({ canonicalizeReceiptImage: vi.fn() }));
vi.mock("@/features/receipts/server/process", () => ({ processReceipt: vi.fn() }));
vi.mock("@/features/receipts/server/submit", async () => {
  const { z } = await import("zod");
  return {
    requireServiceRoleClient: vi.fn(() => ({})),
    submitReceipt: mocks.submitReceipt,
    submitReceiptBodySchema: z.object({}).passthrough(),
  };
});

const { POST } = await import("./route");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OK = { ok: true, remaining: 5, resetSeconds: 60 };
const DOWN = { ok: false, remaining: 0, resetSeconds: 60, unavailable: true };

async function callRoute(): Promise<Response> {
  return POST(
    new NextRequest("https://giya.test/api/v1/receipts", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "abcdefgh12345678" },
      body: "{}",
    }),
    { params: Promise.resolve({}) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
  mocks.checkRateLimit.mockResolvedValue(OK);
  mocks.setNx.mockResolvedValue(true);
  mocks.submitReceipt.mockResolvedValue({ receiptId: "r1", status: "queued" });
});

describe("POST /api/v1/receipts rate limits", () => {
  it("opts BOTH windows into failMode closed", async () => {
    await callRoute();

    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 6, windowSeconds: 60, failMode: "closed" }),
    );
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 60, windowSeconds: 86_400, failMode: "closed" }),
    );
  });

  it("answers 503 DEPENDENCY_UNAVAILABLE when the per-minute limiter is down, without submitting", async () => {
    mocks.checkRateLimit.mockResolvedValue(DOWN);

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(mocks.submitReceipt).not.toHaveBeenCalled();
  });

  it("answers 503 (not the 'try again tomorrow' 429) when only the daily limiter is down", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce(OK).mockResolvedValueOnce(DOWN);

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(mocks.submitReceipt).not.toHaveBeenCalled();
  });

  it("still answers 429 with the real Retry-After when the daily quota is genuinely spent", async () => {
    mocks.checkRateLimit
      .mockResolvedValueOnce(OK)
      .mockResolvedValueOnce({ ok: false, remaining: 0, resetSeconds: 700 });

    const response = await callRoute();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("700");
  });
});
