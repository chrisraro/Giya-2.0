import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Routing behaviour of middleware() itself, as opposed to the pure helpers
// unit tested in middleware.test.ts.
//
// What is fenced here: the consumer app used to be entirely open. /wallet
// rendered "No balances yet" to a signed-out visitor (which reads as an empty
// account, not a signed-out one), /scan walked someone all the way to a 401
// at submit, and /receipts answered 404 when "sign in" was the actual next
// step. Meanwhile /b/[slug] is a shareable public business page and must NOT
// be caught by any of it.
//
// /design's dev-only fence is NOT here. It was tried in middleware and
// measured to produce a soft 404 (HTTP 200 with 404 content); it lives in
// src/app/design/page.tsx now and is tested in src/app/design/dev-only.test.ts.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ updateSession: vi.fn() }));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: mocks.updateSession,
}));

let middleware: (typeof import("./middleware"))["middleware"];

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
  ({ middleware } = await import("./middleware"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const ORIGIN = "https://giya.test";

function request(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, ORIGIN));
}

/** Pretend the session refresh ran and found (or did not find) a user. */
function session(user: { id: string } | null): void {
  mocks.updateSession.mockResolvedValue({ response: NextResponse.next(), user, claims: {} });
}

const SIGNED_IN = { id: "11111111-1111-4111-8111-111111111111" };

describe("consumer routes that require a session", () => {
  for (const pathname of ["/wallet", "/rewards", "/scan", "/receipts"]) {
    it(`sends a signed-out visitor from ${pathname} to /login with a next`, async () => {
      session(null);
      const response = await middleware(request(pathname));

      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      const url = new URL(location as string);
      expect(url.pathname).toBe("/login");
      expect(url.searchParams.get("next")).toBe(pathname);
    });
  }

  it("lets a signed-in consumer through", async () => {
    session(SIGNED_IN);
    const response = await middleware(request("/wallet"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("gates child paths such as a receipt status screen", async () => {
    session(null);
    const response = await middleware(request("/scan/abc"));

    expect(new URL(response.headers.get("location") as string).pathname).toBe("/login");
  });
});

describe("/b/[slug] stays public", () => {
  it("CRITICAL: a signed-out visitor is not bounced off a business page", async () => {
    session(null);
    const response = await middleware(request("/b/kape-diaria"));

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("leaves the marketing site alone", async () => {
    session(null);
    for (const pathname of ["/", "/business", "/consumers", "/privacy", "/terms"]) {
      const response = await middleware(request(pathname));
      expect(response.headers.get("location"), pathname).toBeNull();
    }
  });
});
