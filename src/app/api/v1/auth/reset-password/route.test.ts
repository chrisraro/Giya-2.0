import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/auth/recovery-cookie";

// POST /api/v1/auth/reset-password - promotes the recovery cookie from a
// UI gate to a genuine authorization control (I8): updateUser() now runs
// ONLY behind this route, which checks the cookie itself (403 if absent or
// not exactly "1", even for an otherwise-valid session) and clears it on
// success. Without the clear, the marker /auth/confirm minted stays valid
// for its full TTL: sign in normally with the freshly-reset password,
// navigate back to /reset-password, and the old getSession()-only design's
// exact flaw (I4) would reappear for up to ten minutes.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser, updateUser: mocks.updateUser },
  })),
}));

const rateLimitMocks = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: rateLimitMocks.checkRateLimit }));
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

const { POST } = await import("./route");

const USER_ID = "11111111-1111-4111-8111-111111111111";

function callRoute(body: unknown, cookieValue?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookieValue !== undefined) {
    headers.cookie = `${RECOVERY_COOKIE_NAME}=${cookieValue}`;
  }
  const request = new NextRequest("http://localhost/api/v1/auth/reset-password", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
  return POST(request);
}

beforeEach(() => {
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mocks.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
  rateLimitMocks.checkRateLimit
    .mockReset()
    .mockResolvedValue({ ok: true, remaining: 4, resetSeconds: 600 });
});

describe("POST /api/v1/auth/reset-password", () => {
  it("401s when there is no session at all, cookie or not", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const response = await callRoute({ password: "newSecret123" }, "1");

    expect(response.status).toBe(401);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("403s when the recovery cookie is missing, even with a valid session", async () => {
    const response = await callRoute({ password: "newSecret123" });

    expect(response.status).toBe(403);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("403s when the cookie holds any value other than exactly '1'", async () => {
    const response = await callRoute({ password: "newSecret123" }, "true");

    expect(response.status).toBe(403);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("422s an empty password without calling updateUser", async () => {
    const response = await callRoute({ password: "" }, "1");

    expect(response.status).toBe(422);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it("updates the password and clears the recovery cookie on success", async () => {
    const response = await callRoute({ password: "newSecret123" }, "1");

    expect(mocks.updateUser).toHaveBeenCalledWith({ password: "newSecret123" });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${RECOVERY_COOKIE_NAME}=;`);
    expect(setCookie).toMatch(/max-age=0/i);
    // A browser matches a clearing Set-Cookie against the real cookie by
    // (name, path, domain) ONLY - not HttpOnly/Secure/SameSite/value. If
    // either of these drifts from what /auth/confirm minted (path: "/",
    // no explicit Domain - host-only), the clear silently targets a
    // DIFFERENT cookie and the real marker survives, reopening I8's
    // ten-minute reuse window even though this response looks correct.
    expect(setCookie).toMatch(/;\s*path=\/(;|$)/i); // X1 (Path=/reset-password), X15 (Path omitted)
    expect(setCookie).not.toMatch(/domain=/i); // X16 (Domain=.giya.test added)
  });

  it("does NOT clear the cookie when updateUser fails, so a retry inside the window still works", async () => {
    mocks.updateUser.mockResolvedValueOnce({
      data: {},
      error: { message: "Password should be at least 6 characters" },
    });

    const response = await callRoute({ password: "abc" }, "1");
    const json = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(422);
    expect(json.error.message).toBe("Password should be at least 6 characters");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("rate limiting", () => {
  it("is rate-limited per user, matching the sibling forgot-password route's own budgets", async () => {
    await callRoute({ password: "newSecret123" }, "1");

    expect(rateLimitMocks.checkRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringContaining(`user:${USER_ID}`),
        limit: 5,
        windowSeconds: 600,
      }),
    );
  });

  it("answers 429 without calling updateUser once the caller is over budget", async () => {
    rateLimitMocks.checkRateLimit.mockResolvedValueOnce({
      ok: false,
      remaining: 0,
      resetSeconds: 45,
    });

    const response = await callRoute({ password: "newSecret123" }, "1");

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
