import { NextResponse } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `./middleware` imports `@/lib/supabase/middleware`, which in turn imports
// `@/lib/env` and throws at module-evaluation time if the required
// NEXT_PUBLIC_* vars aren't set (see env.test.ts). Stub them before the
// dynamic import so evaluation succeeds regardless of the host shell's
// environment.
let hasBusinessMembership: (typeof import("./middleware"))["hasBusinessMembership"];
let copySessionCookies: (typeof import("./middleware"))["copySessionCookies"];

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");
  ({ hasBusinessMembership, copySessionCookies } = await import("./middleware"));
});

describe("hasBusinessMembership", () => {
  it("is true when biz is a non-empty map", () => {
    expect(hasBusinessMembership({ biz: { "biz-1": "owner" } })).toBe(true);
  });

  it("is true when biz_overflow is set, even with an empty biz map", () => {
    expect(hasBusinessMembership({ biz: {}, biz_overflow: true })).toBe(true);
  });

  it("is true when biz_overflow is set and biz is absent", () => {
    expect(hasBusinessMembership({ biz_overflow: true })).toBe(true);
  });

  it("is false when biz is an empty map and biz_overflow is unset", () => {
    expect(hasBusinessMembership({ biz: {} })).toBe(false);
  });

  it("is false when both biz and biz_overflow are undefined", () => {
    expect(hasBusinessMembership({})).toBe(false);
  });

  it("is false when biz is null", () => {
    expect(hasBusinessMembership({ biz: null })).toBe(false);
  });
});

describe("copySessionCookies", () => {
  it("copies every cookie from source onto target", () => {
    const source = NextResponse.next();
    source.cookies.set("sb-access-token", "access-value");
    source.cookies.set("sb-refresh-token", "refresh-value");

    const target = NextResponse.redirect("https://example.com/login");
    const result = copySessionCookies(source, target);

    expect(result).toBe(target);
    expect(target.cookies.get("sb-access-token")?.value).toBe("access-value");
    expect(target.cookies.get("sb-refresh-token")?.value).toBe("refresh-value");
  });

  it("preserves cookie options such as path and httpOnly", () => {
    const source = NextResponse.next();
    source.cookies.set("sb-access-token", "access-value", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });

    const target = NextResponse.redirect("https://example.com/login");
    copySessionCookies(source, target);

    const cookie = target.cookies.get("sb-access-token");
    expect(cookie?.path).toBe("/");
    expect(cookie?.httpOnly).toBe(true);
  });

  it("is a no-op when source has no cookies", () => {
    const source = NextResponse.next();
    const target = NextResponse.redirect("https://example.com/login");

    copySessionCookies(source, target);

    expect(target.cookies.getAll()).toHaveLength(0);
  });

  it("does not drop cookies already set on target", () => {
    const source = NextResponse.next();
    source.cookies.set("sb-access-token", "access-value");

    const target = NextResponse.redirect("https://example.com/login");
    target.cookies.set("existing", "kept");

    copySessionCookies(source, target);

    expect(target.cookies.get("existing")?.value).toBe("kept");
    expect(target.cookies.get("sb-access-token")?.value).toBe("access-value");
  });
});
