import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Fast path: a request with no Supabase auth cookie cannot have a session, so
// proxy() must not pay updateSession()'s auth.getUser() round trip, while
// still enforcing the login redirect on gated routes.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ updateSession: vi.fn() }));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession: mocks.updateSession }));

let proxy: (typeof import("./proxy"))["proxy"];
let config: (typeof import("./proxy"))["config"];

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
  ({ proxy, config } = await import("./proxy"));
});

afterEach(() => {
  vi.clearAllMocks();
});

const ORIGIN = "https://giya.test";

function req(pathname: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(pathname, ORIGIN), cookie ? { headers: { cookie } } : undefined);
}

describe("proxy without a session cookie", () => {
  it("does not call updateSession for an anonymous request to /", async () => {
    const response = await proxy(req("/"));

    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
  });

  it("still redirects an anonymous request to /home to /login?next=/home", async () => {
    const response = await proxy(req("/home"));

    expect(mocks.updateSession).not.toHaveBeenCalled();
    const url = new URL(response.headers.get("location") ?? "");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/home");
  });

  it("still sends anonymous /admin traffic to /admin/login", async () => {
    const response = await proxy(req("/admin/users"));

    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/admin/login");
  });

  it("ignores unrelated cookies", async () => {
    await proxy(req("/", "theme=dark; other=1"));

    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
});

describe("proxy with a session cookie", () => {
  it.each(["sb-abcdref-auth-token", "sb-abcdref-auth-token.0", "sb-abcdref-auth-token-code-verifier"])(
    "calls updateSession when %s is present",
    async (name) => {
      mocks.updateSession.mockResolvedValue({ response: NextResponse.next(), user: null });

      await proxy(req("/", `${name}=x`));

      expect(mocks.updateSession).toHaveBeenCalledTimes(1);
    },
  );
});

describe("matcher", () => {
  // Built lazily: `config` is only assigned in beforeAll, after collection.
  const re = { test: (path: string) => new RegExp(`^${config.matcher[0] as string}$`).test(path) };

  it.each(["/api/csp-report", "/manifest.webmanifest", "/robots.txt", "/sitemap.xml", "/brand/icon.svg", "/fonts/x.woff2", "/a/b.png", "/x.webp"])(
    "skips static path %s",
    (path) => {
      expect(re.test(path)).toBe(false);
    },
  );

  it.each(["/", "/home", "/offline", "/privacy", "/b/lugaw-republic", "/business/dashboard"])(
    "still runs on %s",
    (path) => {
      expect(re.test(path)).toBe(true);
    },
  );
});
