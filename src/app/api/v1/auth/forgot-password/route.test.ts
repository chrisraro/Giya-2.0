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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: null } });
  mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  mocks.checkRateLimit.mockResolvedValue({ ok: true, remaining: 9, resetSeconds: 600 });
});

describe("POST /api/v1/auth/forgot-password", () => {
  it("calls resetPasswordForEmail with the entered address and the reset-password callback redirect", async () => {
    const response = await callRoute({ email: "a@b.com" });
    const json = (await response.json()) as { data: { message: string } };

    expect(response.status).toBe(200);
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(
      "a@b.com",
      expect.objectContaining({
        redirectTo: expect.stringContaining("/auth/callback?next=/reset-password"),
      }),
    );
    expect(json.data.message).toBeTruthy();
  });

  it("returns a byte-identical body whether Supabase answers with success or an error", async () => {
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
  });

  it("swallows a rejected resetPasswordForEmail call and still answers 200 with the generic body", async () => {
    mocks.resetPasswordForEmail.mockRejectedValueOnce(new Error("network down"));

    const response = await callRoute({ email: "a@b.com" });
    const json = (await response.json()) as { data: { message: string } };

    expect(response.status).toBe(200);
    expect(json.data.message).toBeTruthy();
    expect(JSON.stringify(json)).not.toMatch(/network down/);
  });

  it("422s a malformed email without calling resetPasswordForEmail", async () => {
    const response = await callRoute({ email: "not-an-email" });

    expect(response.status).toBe(422);
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("rate limiting - per caller IP", () => {
  it("checks the caller's IP against its own budget", async () => {
    await callRoute({ email: "a@b.com" });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining("ip"), limit: 10, windowSeconds: 600 }),
    );
  });

  it("answers 429 without calling resetPasswordForEmail once the caller's IP is over budget", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, resetSeconds: 45 });

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
    // First call (IP check, inside defineHandler) succeeds; second call (the
    // email check, made manually inside the handler) is over budget.
    mocks.checkRateLimit
      .mockResolvedValueOnce({ ok: true, remaining: 9, resetSeconds: 600 })
      .mockResolvedValueOnce({ ok: false, remaining: 0, resetSeconds: 30 });

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
    mocks.checkRateLimit.mockResolvedValueOnce({ ok: false, remaining: 0, resetSeconds: 45 });
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
