import { beforeEach, describe, expect, it, vi } from "vitest";

// Sign-out is the one action on /profile that has to be believed rather than
// looked at. The previous implementation was a <Link href="/login">, which
// moved the user to the login screen while their sb-* session cookies stayed
// valid, so tapping "Log out" and then tapping Back put them straight back into
// their account.
//
// These tests go through the REAL src/lib/supabase/server.ts factory with only
// @supabase/ssr and next/headers stubbed, so what is asserted is the actual
// wiring: the cookie adapter this app hands to @supabase/ssr, and what happens
// to the session cookies when that library clears the session through it.

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  cookieSet: vi.fn(),
  cookieGetAll: vi.fn(() => [{ name: "sb-example-auth-token", value: "a-live-session" }]),
  redirect: vi.fn(),
  /** The cookie adapter src/lib/supabase/server.ts passes to @supabase/ssr. */
  capturedCookies: null as null | {
    getAll: () => { name: string; value: string }[];
    setAll: (cookies: { name: string; value: string; options?: unknown }[]) => void;
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: mocks.cookieGetAll, set: mocks.cookieSet }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: never }) => {
    mocks.capturedCookies = options.cookies;
    return { auth: { signOut: mocks.signOut } };
  },
}));

vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abcdefghijklmnopqrstuvwxyz");

const { signOut } = await import("./actions");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capturedCookies = null;
  mocks.signOut.mockResolvedValue({ error: null });
});

describe("signOut", () => {
  it("CRITICAL: ends the Supabase session instead of only navigating away", async () => {
    await expect(signOut()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it("sends the signed-out user to /login", async () => {
    await expect(signOut()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("ends the session BEFORE redirecting, never the other way round", async () => {
    const order: string[] = [];
    mocks.signOut.mockImplementation(async () => {
      order.push("signOut");
      return { error: null };
    });
    mocks.redirect.mockImplementation(() => order.push("redirect"));

    await expect(signOut()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(order).toEqual(["signOut", "redirect"]);
  });

  it("still redirects when the Auth server round trip fails", async () => {
    // supabase-js drops the local session before it calls the Auth server, so
    // the caller is signed out on this device either way. Stranding them on a
    // page that still looks signed in would be strictly worse.
    mocks.signOut.mockResolvedValue({ error: { message: "network down" } });

    await expect(signOut()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });

  it("CRITICAL: clearing the session writes the cookie expiry through to the cookie store", async () => {
    // This is the assertion that the session cookie actually goes away. It
    // drives the real adapter from src/lib/supabase/server.ts with exactly what
    // @supabase/ssr emits when it removes a session: the cookie name, an empty
    // value, and a zero maxAge.
    mocks.signOut.mockImplementation(async () => {
      mocks.capturedCookies?.setAll([
        { name: "sb-example-auth-token", value: "", options: { maxAge: 0, path: "/" } },
      ]);
      return { error: null };
    });

    await expect(signOut()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mocks.cookieSet).toHaveBeenCalledWith("sb-example-auth-token", "", {
      maxAge: 0,
      path: "/",
    });
  });

  it("hands @supabase/ssr the live session cookies to sign out of", async () => {
    await expect(signOut()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(mocks.capturedCookies?.getAll()).toEqual([
      { name: "sb-example-auth-token", value: "a-live-session" },
    ]);
  });
});
