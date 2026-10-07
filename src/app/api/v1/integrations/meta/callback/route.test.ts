// @vitest-environment node
//
// The OAuth callback at its ONE static URL, and the property only an end-to-end
// test of the route can prove: THE CODE IS NEVER EXCHANGED UNTIL THE STATE HAS
// BEEN VERIFIED, and the business is taken from the verified state, never from
// the URL (Meta needs one exact, registrable redirect_uri for every merchant).
//
// Each refusal below corresponds to a concrete attack, named in
// src/features/integrations/meta/server/state.ts:
//
//   no state / bad state -> an attacker's `code`, captured from their own flow,
//                           walked into a logged-in merchant's browser.
//   other user's state   -> a state minted by one member completed in another's
//                           session.
//   other tenant's state -> a state minted for tenant A completed by a manager
//                           of tenant B.
//   replay               -> the same callback URL fetched twice.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-1111-4111-8111-111111111111";
const REDIRECT = "https://giya.ph/api/v1/integrations/meta/callback";

const staff = vi.hoisted(() => ({ context: null as unknown, throws: false }));
vi.mock("@/features/businesses/server/resolve-owner-business", () => ({
  resolveStaffContext: async () => {
    if (staff.throws) throw new Error("readMembership: read failed");
    return staff.context;
  },
}));

const stateMock = vi.hoisted(() => ({ verifyState: vi.fn() }));
vi.mock("@/features/integrations/meta/server/state", () => ({
  verifyState: (...args: unknown[]) => stateMock.verifyState(...args),
}));

const serviceMock = vi.hoisted(() => ({ completeCallback: vi.fn() }));
vi.mock("@/features/integrations/meta/server/service", () => ({
  completeCallback: (...args: unknown[]) => serviceMock.completeCallback(...args),
}));

import { NextRequest } from "next/server";

import { GET } from "./route";

function request(query: Record<string, string>): NextRequest {
  const url = new URL(REDIRECT);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { method: "GET" });
}

function redirectTarget(response: Response): URL {
  return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
  staff.throws = false;
  staff.context = {
    userId: USER,
    businessId: BUSINESS,
    businessName: "Kape Cebu",
    businessSlug: "kape-cebu",
    businessStatus: "active",
    role: "owner",
  };
  stateMock.verifyState
    .mockReset()
    .mockResolvedValue({ ok: true, businessId: BUSINESS, redirectUri: REDIRECT });
  serviceMock.completeCallback
    .mockReset()
    .mockResolvedValue({ ok: true, selectionId: "sel-1234567890123456", pageCount: 2 });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("session and role", () => {
  it("answers 'unavailable' - not 'denied', not a crash - when the membership read fails", async () => {
    staff.throws = true;

    const response = await GET(request({ code: "c", state: "s" }));

    expect(redirectTarget(response).searchParams.get("meta")).toBe("unavailable");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("refuses a caller with no session or no owner/manager role, without checking any state", async () => {
    // resolveStaffContext returns null for both: no session, and a role outside
    // owner/manager (marketing, staff).
    staff.context = null;

    const response = await GET(request({ code: "c", state: "s" }));

    expect(redirectTarget(response).searchParams.get("meta")).toBe("denied");
    expect(stateMock.verifyState).not.toHaveBeenCalled();
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("refuses a state minted for a business the caller does not manage", async () => {
    stateMock.verifyState.mockResolvedValue({
      ok: true,
      businessId: OTHER_BUSINESS,
      redirectUri: REDIRECT,
    });

    const response = await GET(request({ code: "c", state: "s" }));

    expect(redirectTarget(response).searchParams.get("meta")).toBe("denied");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("ignores a businessId smuggled into the query string", async () => {
    await GET(request({ code: "c", state: "s", businessId: OTHER_BUSINESS, business_id: OTHER_BUSINESS }));

    expect(serviceMock.completeCallback).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS }),
    );
  });
});

describe("state verification", () => {
  it("EXCHANGES NOTHING when the state is missing", async () => {
    stateMock.verifyState.mockResolvedValue({ ok: false, reason: "missing" });

    const response = await GET(request({ code: "the-code" }));

    expect(redirectTarget(response).searchParams.get("meta")).toBe("rejected");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("EXCHANGES NOTHING when the state was tampered with or expired (unknown)", async () => {
    stateMock.verifyState.mockResolvedValue({ ok: false, reason: "unknown" });

    const response = await GET(request({ code: "the-code", state: "s" }));

    expect(redirectTarget(response).searchParams.get("meta")).toBe("rejected");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("EXCHANGES NOTHING on a replay (the state is already spent)", async () => {
    stateMock.verifyState
      .mockResolvedValueOnce({ ok: true, businessId: BUSINESS, redirectUri: REDIRECT })
      .mockResolvedValueOnce({ ok: false, reason: "unknown" });

    const first = await GET(request({ code: "the-code", state: "s" }));
    const second = await GET(request({ code: "the-code", state: "s" }));

    expect(redirectTarget(first).searchParams.get("meta")).toBe("select");
    expect(redirectTarget(second).searchParams.get("meta")).toBe("rejected");
    expect(serviceMock.completeCallback).toHaveBeenCalledTimes(1);
  });

  it("EXCHANGES NOTHING when the session user differs from the state's user", async () => {
    stateMock.verifyState.mockResolvedValue({ ok: false, reason: "user_mismatch" });

    const response = await GET(request({ code: "the-code", state: "s" }));

    expect(redirectTarget(response).searchParams.get("meta")).toBe("rejected");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("EXCHANGES NOTHING when the state store is unreachable", async () => {
    stateMock.verifyState.mockResolvedValue({ ok: false, reason: "unavailable" });

    await GET(request({ code: "the-code", state: "s" }));

    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("never tells the caller WHY the state was rejected", async () => {
    const reasons = ["missing", "malformed", "unknown", "user_mismatch"];
    const outcomes = new Set<string>();

    for (const reason of reasons) {
      stateMock.verifyState.mockResolvedValue({ ok: false, reason });
      const response = await GET(request({ code: "c", state: "s" }));
      const target = redirectTarget(response);
      outcomes.add(target.searchParams.get("meta") ?? "");
      expect(target.search).not.toContain(reason);
    }

    expect(outcomes).toEqual(new Set(["rejected"]));
  });

  it("binds the state to the session's own user id, and passes no business", async () => {
    await GET(request({ code: "c", state: "the-state" }));

    expect(stateMock.verifyState).toHaveBeenCalledWith({ state: "the-state", userId: USER });
  });
});

describe("the happy path", () => {
  it("exchanges the code and redirects to the page picker", async () => {
    const response = await GET(request({ code: "the-code", state: "s" }));
    const target = redirectTarget(response);

    expect(response.status).toBe(303);
    expect(target.pathname).toBe("/business/settings");
    expect(target.searchParams.get("meta")).toBe("select");
    expect(target.searchParams.get("sid")).toBe("sel-1234567890123456");
  });

  it("exchanges with the state's business and redirect_uri === <origin>/api/v1/integrations/meta/callback", async () => {
    await GET(request({ code: "the-code", state: "s" }));

    expect(serviceMock.completeCallback).toHaveBeenCalledWith({
      businessId: BUSINESS,
      userId: USER,
      code: "the-code",
      redirectUri: "https://giya.ph/api/v1/integrations/meta/callback",
    });
  });

  it("puts no code, state or token into the redirect it hands the browser", async () => {
    const response = await GET(request({ code: "the-code", state: "the-state" }));
    const location = response.headers.get("location") ?? "";

    expect(location).not.toContain("the-code");
    expect(location).not.toContain("the-state");
  });
});

describe("the unhappy paths", () => {
  it("treats a declined consent dialog as a normal outcome", async () => {
    const response = await GET(request({ error: "access_denied", error_reason: "user_denied" }));

    expect(redirectTarget(response).searchParams.get("meta")).toBe("cancelled");
    expect(stateMock.verifyState).not.toHaveBeenCalled();
  });

  it("does not forward Meta's error_description to the merchant", async () => {
    const response = await GET(
      request({ error: "access_denied", error_description: "user denied 1234" }),
    );

    expect(response.headers.get("location")).not.toContain("1234");
  });

  it("refuses a verified state with no code", async () => {
    const response = await GET(request({ state: "s" }));

    expect(redirectTarget(response).searchParams.get("meta")).toBe("failed");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("reports an account with no Pages as its own outcome", async () => {
    serviceMock.completeCallback.mockResolvedValue({ ok: false, failure: "no_pages" });

    const response = await GET(request({ code: "c", state: "s" }));
    expect(redirectTarget(response).searchParams.get("meta")).toBe("no_pages");
  });

  it("reports a Meta outage as retryable rather than as a failure", async () => {
    serviceMock.completeCallback.mockResolvedValue({ ok: false, failure: "unavailable" });

    const response = await GET(request({ code: "c", state: "s" }));
    expect(redirectTarget(response).searchParams.get("meta")).toBe("unavailable");
  });

  it("reports a dormant integration honestly", async () => {
    serviceMock.completeCallback.mockResolvedValue({ ok: false, failure: "not_configured" });

    const response = await GET(request({ code: "c", state: "s" }));
    expect(redirectTarget(response).searchParams.get("meta")).toBe("not_configured");
  });
});
