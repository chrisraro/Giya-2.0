// @vitest-environment node
//
// The OAuth callback, and the property only an end-to-end test of the route can
// prove: THE CODE IS NEVER EXCHANGED UNTIL THE STATE HAS BEEN VERIFIED, and the
// state is checked against the caller's real tenancy rather than the path.
//
// Each refusal below corresponds to a concrete attack, named in
// src/features/integrations/meta/server/state.ts:
//
//   no state / bad state -> an attacker's `code`, captured from their own flow,
//                           walked into a logged-in merchant's browser. Without
//                           this the attacker's Facebook Page is attached to the
//                           merchant's tenant.
//   wrong business       -> a state minted for tenant A replayed at tenant B.
//   replay               -> the same callback URL fetched twice.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-1111-4111-8111-111111111111";

const staff = vi.hoisted(() => ({ context: null as unknown }));
vi.mock("@/features/businesses/server/resolve-owner-business", () => ({
  resolveStaffContext: async () => staff.context,
}));

const stateMock = vi.hoisted(() => ({ verifyState: vi.fn() }));
vi.mock("@/features/integrations/meta/server/state", () => ({
  verifyState: (...args: unknown[]) => stateMock.verifyState(...args),
}));

const serviceMock = vi.hoisted(() => ({ completeCallback: vi.fn() }));
vi.mock("@/features/integrations/meta/server/service", () => ({
  completeCallback: (...args: unknown[]) => serviceMock.completeCallback(...args),
  callbackUrl: (origin: string, businessId: string) =>
    `${origin}/api/v1/businesses/${businessId}/integrations/meta/callback`,
}));

import { NextRequest } from "next/server";

import { GET } from "./route";

function request(query: Record<string, string>, businessId = BUSINESS): NextRequest {
  const url = new URL(
    `https://giya.ph/api/v1/businesses/${businessId}/integrations/meta/callback`,
  );
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new NextRequest(url, { method: "GET" });
}

function params(businessId = BUSINESS) {
  return { params: Promise.resolve({ businessId }) };
}

function redirectTarget(response: Response): URL {
  return new URL(response.headers.get("location") ?? "");
}

beforeEach(() => {
  staff.context = {
    userId: USER,
    businessId: BUSINESS,
    businessName: "Kape Cebu",
    businessSlug: "kape-cebu",
    businessStatus: "active",
    role: "owner",
  };
  stateMock.verifyState.mockReset().mockResolvedValue({
    ok: true,
    redirectUri: `https://giya.ph/api/v1/businesses/${BUSINESS}/integrations/meta/callback`,
  });
  serviceMock.completeCallback
    .mockReset()
    .mockResolvedValue({ ok: true, selectionId: "sel-1234567890123456", pageCount: 2 });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("session and tenancy", () => {
  it("refuses a caller with no session, without checking any state", async () => {
    staff.context = null;

    const response = await GET(request({ code: "c", state: "s" }), params());

    expect(redirectTarget(response).searchParams.get("meta")).toBe("denied");
    expect(stateMock.verifyState).not.toHaveBeenCalled();
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("refuses when the path names a business the caller does not manage", async () => {
    // The path segment is attacker-controlled and is checked against the
    // caller's real membership, never trusted.
    const response = await GET(
      request({ code: "c", state: "s" }, OTHER_BUSINESS),
      params(OTHER_BUSINESS),
    );

    expect(redirectTarget(response).searchParams.get("meta")).toBe("denied");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("collapses 'not signed in' and 'not your business' into one answer", async () => {
    staff.context = null;
    const anonymous = await GET(request({ code: "c" }), params());
    staff.context = { userId: USER, businessId: OTHER_BUSINESS, role: "owner" };
    const wrongTenant = await GET(request({ code: "c" }), params());

    expect(redirectTarget(anonymous).searchParams.get("meta")).toBe(
      redirectTarget(wrongTenant).searchParams.get("meta"),
    );
  });
});

describe("state verification", () => {
  it("EXCHANGES NOTHING when the state is missing", async () => {
    stateMock.verifyState.mockResolvedValue({ ok: false, reason: "missing" });

    const response = await GET(request({ code: "the-code" }), params());

    expect(redirectTarget(response).searchParams.get("meta")).toBe("rejected");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("EXCHANGES NOTHING when the state belongs to another business", async () => {
    stateMock.verifyState.mockResolvedValue({ ok: false, reason: "business_mismatch" });

    const response = await GET(request({ code: "the-code", state: "s" }), params());

    expect(redirectTarget(response).searchParams.get("meta")).toBe("rejected");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("EXCHANGES NOTHING on a replay (the state is already spent)", async () => {
    stateMock.verifyState.mockResolvedValue({ ok: false, reason: "unknown" });

    const response = await GET(request({ code: "the-code", state: "s" }), params());

    expect(redirectTarget(response).searchParams.get("meta")).toBe("rejected");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("EXCHANGES NOTHING when the state store is unreachable", async () => {
    stateMock.verifyState.mockResolvedValue({ ok: false, reason: "unavailable" });

    await GET(request({ code: "the-code", state: "s" }), params());

    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("never tells the caller WHY the state was rejected", async () => {
    // Four different facts about our storage, one answer. Anything finer is an
    // oracle for whoever is probing the endpoint.
    const reasons = ["missing", "malformed", "unknown", "business_mismatch", "user_mismatch"];
    const outcomes = new Set<string>();

    for (const reason of reasons) {
      stateMock.verifyState.mockResolvedValue({ ok: false, reason });
      const response = await GET(request({ code: "c", state: "s" }), params());
      const target = redirectTarget(response);
      outcomes.add(target.searchParams.get("meta") ?? "");
      expect(target.search).not.toContain(reason);
    }

    expect(outcomes).toEqual(new Set(["rejected"]));
  });

  it("binds the state to the caller's own user id", async () => {
    await GET(request({ code: "c", state: "the-state" }), params());

    expect(stateMock.verifyState).toHaveBeenCalledWith({
      state: "the-state",
      businessId: BUSINESS,
      userId: USER,
    });
  });
});

describe("the happy path", () => {
  it("exchanges the code and redirects to the page picker", async () => {
    const response = await GET(request({ code: "the-code", state: "s" }), params());
    const target = redirectTarget(response);

    expect(response.status).toBe(303);
    expect(target.pathname).toBe("/business/settings");
    expect(target.searchParams.get("meta")).toBe("select");
    expect(target.searchParams.get("sid")).toBe("sel-1234567890123456");
  });

  it("uses the redirect_uri FROM THE STORED STATE, not one rebuilt from the request", async () => {
    // Meta requires it byte-identical to the dialog's, and a value derived
    // from the incoming request is a value the caller influences.
    stateMock.verifyState.mockResolvedValue({
      ok: true,
      redirectUri: "https://giya.ph/the/exact/uri",
    });

    await GET(request({ code: "the-code", state: "s" }), params());

    expect(serviceMock.completeCallback).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: "https://giya.ph/the/exact/uri" }),
    );
  });

  it("puts no code, state or token into the redirect it hands the browser", async () => {
    const response = await GET(request({ code: "the-code", state: "the-state" }), params());
    const location = response.headers.get("location") ?? "";

    expect(location).not.toContain("the-code");
    expect(location).not.toContain("the-state");
  });
});

describe("the unhappy paths", () => {
  it("treats a declined consent dialog as a normal outcome", async () => {
    const response = await GET(
      request({ error: "access_denied", error_reason: "user_denied" }),
      params(),
    );

    expect(redirectTarget(response).searchParams.get("meta")).toBe("cancelled");
    expect(stateMock.verifyState).not.toHaveBeenCalled();
  });

  it("does not forward Meta's error_description to the merchant", async () => {
    const response = await GET(
      request({ error: "access_denied", error_description: "user denied 1234" }),
      params(),
    );

    expect(response.headers.get("location")).not.toContain("1234");
  });

  it("refuses a verified state with no code", async () => {
    const response = await GET(request({ state: "s" }), params());

    expect(redirectTarget(response).searchParams.get("meta")).toBe("failed");
    expect(serviceMock.completeCallback).not.toHaveBeenCalled();
  });

  it("reports an account with no Pages as its own outcome", async () => {
    serviceMock.completeCallback.mockResolvedValue({ ok: false, failure: "no_pages" });

    const response = await GET(request({ code: "c", state: "s" }), params());
    expect(redirectTarget(response).searchParams.get("meta")).toBe("no_pages");
  });

  it("reports a Meta outage as retryable rather than as a failure", async () => {
    serviceMock.completeCallback.mockResolvedValue({ ok: false, failure: "unavailable" });

    const response = await GET(request({ code: "c", state: "s" }), params());
    expect(redirectTarget(response).searchParams.get("meta")).toBe("unavailable");
  });

  it("reports a dormant integration honestly", async () => {
    serviceMock.completeCallback.mockResolvedValue({ ok: false, failure: "not_configured" });

    const response = await GET(request({ code: "c", state: "s" }), params());
    expect(redirectTarget(response).searchParams.get("meta")).toBe("not_configured");
  });
});
