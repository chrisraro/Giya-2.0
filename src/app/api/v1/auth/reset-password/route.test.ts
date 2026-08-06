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

// This route sets no rateLimit config of its own, but defineHandler
// (src/lib/api/handler.ts) unconditionally imports @/lib/rate-limit and
// @/lib/redis at module scope, which eagerly reads @/lib/env's
// NEXT_PUBLIC_SUPABASE_* vars - unset in this test environment. Same
// mocks as forgot-password/route.test.ts, for the same reason.
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
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
