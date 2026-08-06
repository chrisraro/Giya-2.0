import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/v1/auth/forgot-password - the server side of the forgot-password
// page. Public (no session), sends a Supabase Auth recovery email, and must
// never let its response (body OR timing) reveal whether the address it was
// given has an account - see src/lib/auth/timing.ts for the timing half.
// This is also the ONLY place resetPasswordForEmail is called from now on:
// moving it here from the client (T3.1's first pass called it directly from
// the browser) is what makes it possible to rate-limit at all, since a
// direct browser->Supabase call can never be gated by this repo's own
// limiter.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mocks.getUser,
      resetPasswordForEmail: mocks.resetPasswordForEmail,
    },
  })),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

const { POST } = await import("./route");

async function callRoute(body: unknown = { email: "a@b.com" }) {
  const request = new NextRequest("http://localhost/api/v1/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return POST(request);
}

interface RateLimitAnswer {
  ok: boolean;
  remaining: number;
  resetSeconds: number;
}

const RL_OK: RateLimitAnswer = { ok: true, remaining: 9, resetSeconds: 600 };

// Keyed by which BUDGET the call is actually for (recognized by the key's
// own content, via the `redisKey` mock below - the IP-scoped key always
// contains "ip:", the address-scoped key never does), not by call order.
// A previous version of this suite used `mockResolvedValueOnce` chains
// instead, which pass regardless of whether the two budgets are wired
// correctly: removing the IP limiter entirely just shifts which check
// consumes the first queued answer, and a test asserting "429 when the IP
// is over budget" can still see a 429 - for the wrong reason - because the
// email check happened to inherit that answer. Keying by the real argument
// closes that hole: an answer configured for "ip" is only ever returned to
// a call whose key actually says "ip".
function mockRateLimit(overrides: { ip?: RateLimitAnswer; email?: RateLimitAnswer } = {}) {
  const ip = overrides.ip ?? RL_OK;
  const email = overrides.email ?? RL_OK;
  mocks.checkRateLimit.mockImplementation(async ({ key }: { key: string }) => {
    return key.includes(":ip:") ? ip : email;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  mockRateLimit();
});

describe("POST /api/v1/auth/forgot-password", () => {
  it("calls resetPasswordForEmail with the entered address and the token_hash confirm endpoint", async () => {
    const response = await callRoute({ email: "a@b.com" });
    const json = (await response.json()) as { data: { message: string } };

    expect(response.status).toBe(200);
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(
      "a@b.com",
      expect.objectContaining({
        redirectTo: expect.stringContaining("/auth/confirm"),
      }),
    );
    expect(json.data.message).toBeTruthy();
  });

  it("returns a byte-identical body AND header set whether Supabase answers with success or an error", async () => {
    mocks.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });
    const successResponse = await callRoute({ email: "known@b.com" });
    const successJson = await successResponse.json();

    mocks.resetPasswordForEmail.mockResolvedValueOnce({
      data: {},
      error: { message: "Unable to validate email address: invalid format" },
    });
    const errorResponse = await callRoute({ email: "known@b.com" });
    const errorJson = await errorResponse.json();

    expect(errorResponse.status).toBe(successResponse.status);
    expect(errorJson.data).toEqual(successJson.data);
    expect(JSON.stringify(errorJson)).not.toMatch(/Unable to validate email address/);

    // Body equality alone would miss a leak carried in a HEADER instead of
    // the JSON payload (e.g. a hypothetical X-Account-Exists). X-Request-Id
    // is excluded because it is a fresh, random per-call correlation id by
    // design (src/lib/api/handler.ts's resolveRequestId) - it is SUPPOSED to
    // differ every call, success or not, and asserting it matches would make
    // this test fail for a reason that has nothing to do with enumeration.
    function headersWithoutRequestId(response: Response): Record<string, string> {
      const entries = [...response.headers.entries()].filter(
        ([name]) => name.toLowerCase() !== "x-request-id",
      );
      return Object.fromEntries(entries);
    }
    expect(headersWithoutRequestId(errorResponse)).toEqual(headersWithoutRequestId(successResponse));
  });

  it("swallows a rejected resetPasswordForEmail call and still answers 200 with the generic body", async () => {
    mocks.resetPasswordForEmail.mockRejectedValueOnce(new Error("network down"));

    const response = await callRoute({ email: "a@b.com" });
    const json = (await response.json()) as { data: { message: string } };

    expect(response.status).toBe(200);
    expect(json.data.message).toBeTruthy();
    expect(JSON.stringify(json)).not.toMatch(/network down/);
  });

  it("logs a swallowed resetPasswordForEmail failure server-side, so it is not invisible everywhere", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const boom = new Error("network down");
      mocks.resetPasswordForEmail.mockRejectedValueOnce(boom);

      await callRoute({ email: "a@b.com" });

      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("auth-forgot-password"), boom);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("422s a malformed email without calling resetPasswordForEmail", async () => {
    const response = await callRoute({ email: "not-an-email" });

    expect(response.status).toBe(422);
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("forwards a submitted captchaToken to resetPasswordForEmail as options.captchaToken", async () => {
    await callRoute({ email: "a@b.com", captchaToken: "verified-token" });

    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(
      "a@b.com",
      expect.objectContaining({ captchaToken: "verified-token" }),
    );
  });

  it("omits captchaToken from options when the caller did not send one", async () => {
    await callRoute({ email: "a@b.com" });

    const [, options] = mocks.resetPasswordForEmail.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty("captchaToken");
  });

  it("also omits captchaToken from options when the caller sent an empty string, not just when the field is absent", async () => {
    await callRoute({ email: "a@b.com", captchaToken: "" });

    const [, options] = mocks.resetPasswordForEmail.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).not.toHaveProperty("captchaToken");
  });
});

describe("rate limiting - per caller IP", () => {
  it("checks the caller's IP against its own budget", async () => {
    await callRoute({ email: "a@b.com" });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining(":ip:"), limit: 10, windowSeconds: 600 }),
    );
  });

  it("answers 429 without calling resetPasswordForEmail once the caller's IP is over budget", async () => {
    mockRateLimit({ ip: { ok: false, remaining: 0, resetSeconds: 45 } });

    const response = await callRoute({ email: "a@b.com" });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("rate limiting - per target address", () => {
  it("checks the submitted address against its own budget, independent of the IP budget", async () => {
    await callRoute({ email: "victim@b.com" });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringContaining("victim@b.com"),
        limit: 3,
        windowSeconds: 900,
      }),
    );
  });

  it("answers 429 without calling resetPasswordForEmail once the ADDRESS is over budget, even from a fresh IP", async () => {
    // IP budget is fine; the address budget alone is exhausted.
    mockRateLimit({ email: { ok: false, remaining: 0, resetSeconds: 30 } });

    const response = await callRoute({ email: "victim@b.com" });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("normalizes the address (trim + lowercase) before keying the budget, so case/whitespace cannot dodge it", async () => {
    await callRoute({ email: "  Victim@B.com  " });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining("victim@b.com") }),
    );
  });

  it("clamps a caller-controlled address to 128 chars before it enters the redis key, matching handler.ts's own defense for exactly this", async () => {
    const longLocalPart = "x".repeat(300);
    const email = `${longLocalPart}@b.com`; // 306 chars total, still under the 320 zod cap

    await callRoute({ email });

    const calls = mocks.checkRateLimit.mock.calls as [{ key: string }][];
    const call = calls.find(([params]) => !params.key.includes(":ip:"));
    expect(call).toBeDefined();
    const [{ key }] = call!;
    // "test:rl:auth-forgot-password-email:" is the fixed prefix the mocked
    // redisKey produces; everything after it is the (clamped) address.
    expect(key.length).toBeLessThanOrEqual("test:rl:auth-forgot-password-email:".length + 128);
    expect(key).not.toContain(email); // the full 306-char address must not appear whole
  });
});

describe("timing", () => {
  it("holds the response back for a minimum delay even when Supabase answers instantly", async () => {
    vi.useFakeTimers();
    try {
      const responsePromise = callRoute({ email: "a@b.com" });
      let settled = false;
      void responsePromise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(799);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await responsePromise).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delay a request refused by the rate limiter - only the real Supabase call is padded", async () => {
    mockRateLimit({ ip: { ok: false, remaining: 0, resetSeconds: 45 } });
    vi.useFakeTimers();
    try {
      const responsePromise = callRoute({ email: "a@b.com" });
      let settled = false;
      void responsePromise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect((await responsePromise).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});
