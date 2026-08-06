import { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME, clearRecoveryCookieHeader } from "./recovery-cookie";

// This is the one test that can see BOTH sides of the mint/clear pairing
// at once: src/app/auth/confirm/route.ts (mints the cookie, via
// NextResponse.cookies.set with its own options object) and
// clearRecoveryCookieHeader above (clears it, as a raw Set-Cookie string,
// since a defineHandler route only gets to add response headers through
// its HandlerResult contract, never a NextResponse of its own to call
// .cookies.delete() on).
//
// A browser matches a clearing Set-Cookie against an existing cookie by
// (name, path, domain) ONLY - never HttpOnly/Secure/SameSite/value (see
// route.test.ts's own comment and its X5-survives note: stripping those
// three from the clear still deletes the cookie, confirmed against a real
// RFC-6265 jar). If (name, path, domain-absence) ever drift between the
// two call sites, the clear silently targets a DIFFERENT cookie and the
// real marker survives untouched - this is exactly what reopened the
// ten-minute reuse window I8 fixed, if these three ever come apart again.
//
// Neither confirm/route.test.ts (which only sees the mint) nor a
// clear-side-only assertion in reset-password/route.test.ts (which only
// sees the clear) can catch a FUTURE drift between the two on its own -
// each one only has a hardcoded expectation of what the OTHER side does.
// Only a test that extracts both REAL Set-Cookie headers and compares them
// directly can, which is what this file exists to do.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ verifyOtp: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { verifyOtp: mocks.verifyOtp } })),
}));

interface CookieIdentity {
  name: string;
  path: string | undefined;
  hasDomain: boolean;
}

function parseCookieIdentity(setCookieHeader: string): CookieIdentity {
  const [nameValue, ...attrs] = setCookieHeader.split(";").map((part) => part.trim());
  const name = (nameValue ?? "").split("=")[0] ?? "";
  const pathAttr = attrs.find((attr) => attr.toLowerCase().startsWith("path="));
  const hasDomain = attrs.some((attr) => attr.toLowerCase().startsWith("domain="));
  return { name, path: pathAttr?.slice("path=".length), hasDomain };
}

beforeEach(() => {
  mocks.verifyOtp.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("recovery cookie identity: mint (confirm/route.ts) and clear (clearRecoveryCookieHeader) must target the same cookie", () => {
  it("share an identical (name, path, domain-absence) identity", async () => {
    const { GET } = await import("@/app/auth/confirm/route");
    const mintResponse = await GET(
      new NextRequest("https://giya.test/auth/confirm?token_hash=abc123&type=recovery"),
    );
    const mintSetCookie = mintResponse.headers.get("set-cookie") ?? "";

    const mintIdentity = parseCookieIdentity(mintSetCookie);
    const clearIdentity = parseCookieIdentity(clearRecoveryCookieHeader());

    expect(mintIdentity.name).toBe(RECOVERY_COOKIE_NAME);
    expect(clearIdentity).toEqual(mintIdentity);
  });
});
