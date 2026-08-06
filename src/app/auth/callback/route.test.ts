import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The PKCE / OAuth landing route. Two things it must never do: honour an
// external `next` (open redirect) and describe an OAuth cancellation as an
// expired link, which is what happened before because a provider error
// carries no `code` and fell through to the generic tail.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  registerDevice: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: mocks.exchangeCodeForSession },
  }),
}));

// The device writer's own SQL and identity rule live in
// src/features/identity/server/devices.test.ts. Here it is a seam: what this
// route owns is WHETHER it is called, and on which branch.
vi.mock("@/features/identity/server/devices", () => ({
  registerDevice: mocks.registerDevice,
}));

const { GET } = await import("./route");

const ORIGIN = "https://giya.test";

async function callback(query: string): Promise<URL> {
  const response = await GET(new NextRequest(new URL(`/auth/callback${query}`, ORIGIN)));
  return new URL(response.headers.get("location") as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
});

describe("successful exchange", () => {
  it("lands on the validated next", async () => {
    const url = await callback("?code=abc&next=%2Fwallet");

    expect(url.pathname).toBe("/wallet");
    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("abc");
  });

  it("defaults to /home, which the consumer layout's gate then re-routes if needed", async () => {
    const url = await callback("?code=abc");

    expect(url.pathname).toBe("/home");
  });

  it("CRITICAL: refuses an external next rather than becoming an open redirect", async () => {
    const url = await callback("?code=abc&next=https%3A%2F%2Fevil.example%2Fx");

    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe("/home");
  });
});

describe("the OAuth failure path", () => {
  it("CRITICAL: a provider error is not reported as an expired link", async () => {
    const url = await callback("?error=access_denied&error_description=User+denied");

    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("error")).toBe("oauth");
    // No exchange is attempted, and the provider's own text never travels.
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(url.search).not.toContain("denied");
  });

  it("takes precedence even if a code somehow rides along", async () => {
    const url = await callback("?error=access_denied&code=abc");

    expect(url.searchParams.get("error")).toBe("oauth");
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});

describe("the dead-handshake path", () => {
  it("sends a code-less arrival back to /login as a confirmation problem", async () => {
    const url = await callback("");

    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("error")).toBe("confirm");
  });

  it("does the same when the exchange itself is rejected", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: { message: "expired" } });

    const url = await callback("?code=stale");

    expect(url.searchParams.get("error")).toBe("confirm");
  });
});

// `public.user_devices` had no writer anywhere in src/. A device only exists
// once a session does, and this route is one of the two places a session is
// established (the other is the password form on /login).
describe("device registration", () => {
  it("CRITICAL: registers the device once the exchange has produced a session", async () => {
    await callback("?code=abc");

    expect(mocks.registerDevice).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: registers nothing when the exchange failed", async () => {
    // No session, no device. Writing one here would attribute a row to whoever
    // happened to be signed in before.
    mocks.exchangeCodeForSession.mockResolvedValue({ error: { message: "expired" } });

    await callback("?code=stale");

    expect(mocks.registerDevice).not.toHaveBeenCalled();
  });

  it("CRITICAL: registers nothing on the OAuth-cancelled path", async () => {
    await callback("?error=access_denied");

    expect(mocks.registerDevice).not.toHaveBeenCalled();
  });

  it("still lands the consumer where they were going when registration throws", async () => {
    // Whatever happened to the device row, the exchange succeeded and they are
    // signed in. Bouncing them to /login with "that link expired" would be a
    // lie about the thing that actually worked.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.registerDevice.mockRejectedValue(new Error("ECONNRESET"));

    const url = await callback("?code=abc&next=%2Fwallet");

    expect(url.pathname).toBe("/wallet");
    consoleError.mockRestore();
  });
});
