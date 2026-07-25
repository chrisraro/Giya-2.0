import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The auth gate on the consumer surfaces that are ABOUT the signed-in person.
//
// /home used to render module-level fixtures, so a signed-out visitor who
// opened the deployed app landed on a fully populated dashboard belonging to
// nobody: a greeting by name, a points total, four business cards. /profile did
// the same with a name, initials and a city. Neither route has an honest
// anonymous version, so both now require a session.
//
// This file drives the real middleware() with updateSession mocked, which is
// what middleware.test.ts (helpers only, dynamic import, no module mocks)
// deliberately does not do.

const mocks = vi.hoisted(() => ({ updateSession: vi.fn() }));

vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: mocks.updateSession,
}));

vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");

const { middleware, isAuthenticatedConsumerRoute } = await import("./middleware");

const ORIGIN = "https://giya.example";

function requestFor(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, ORIGIN));
}

function signedOut(): void {
  mocks.updateSession.mockResolvedValue({ response: NextResponse.next(), user: null, claims: {} });
}

function signedIn(): void {
  mocks.updateSession.mockResolvedValue({
    response: NextResponse.next(),
    user: { id: "user-1" },
    claims: {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

describe("isAuthenticatedConsumerRoute - the consumer account routes", () => {
  it.each(["/home", "/profile", "/notifications"])("gates %s", (pathname) => {
    expect(isAuthenticatedConsumerRoute(pathname)).toBe(true);
  });

  it.each(["/home/anything", "/profile/settings"])("gates the child route %s", (pathname) => {
    expect(isAuthenticatedConsumerRoute(pathname)).toBe(true);
  });

  it.each(["/homework", "/profiles", "/home-page"])(
    "does not gate %s, which merely starts with the same letters",
    (pathname) => {
      expect(isAuthenticatedConsumerRoute(pathname)).toBe(false);
    },
  );

  it("CRITICAL: leaves /b/[slug] public, since that is where /home's cards point", () => {
    expect(isAuthenticatedConsumerRoute("/b/lugaw-republic")).toBe(false);
  });

  it.each(["/", "/login", "/signup", "/business", "/privacy", "/terms"])(
    "leaves %s public",
    (pathname) => {
      expect(isAuthenticatedConsumerRoute(pathname)).toBe(false);
    },
  );
});

describe("middleware() on /home and /profile", () => {
  it.each(["/home", "/profile"])(
    "CRITICAL: redirects an anonymous visitor away from %s",
    async (pathname) => {
      const response = await middleware(requestFor(pathname));

      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.pathname).toBe("/login");
    },
  );

  it.each(["/home", "/profile"])("carries %s back as ?next= so the trip resumes", async (pathname) => {
    const response = await middleware(requestFor(pathname));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("next")).toBe(pathname);
  });

  it.each(["/home", "/profile"])("lets a signed-in consumer through to %s", async (pathname) => {
    signedIn();

    const response = await middleware(requestFor(pathname));

    expect(response.headers.get("location")).toBeNull();
  });

  it("still lets an anonymous visitor reach a public business page", async () => {
    const response = await middleware(requestFor("/b/lugaw-republic"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("carries refreshed session cookies onto the redirect rather than dropping them", async () => {
    const refreshed = NextResponse.next();
    refreshed.cookies.set("sb-example-auth-token", "refreshed-value");
    mocks.updateSession.mockResolvedValue({ response: refreshed, user: null, claims: {} });

    const response = await middleware(requestFor("/home"));

    expect(response.cookies.get("sb-example-auth-token")?.value).toBe("refreshed-value");
  });
});
