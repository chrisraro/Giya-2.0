import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// CRITICAL regression coverage: reward_claims RLS is a UNION of
// reward_claims_consumer_select (consumer_id = auth.uid()) and
// reward_claims_staff_select (staff of the business) - see
// supabase/migrations/0012_campaigns.sql. That means repo.getClaim can
// legitimately return a claim that belongs to someone else (a staff member
// reading a customer's claim), so this route MUST re-check ownership
// itself before minting a token. Without that check, any staff member of
// the business could mint a redemption token for a customer's claim and
// self-redeem the customer's reward.

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getClaim: vi.fn(),
  mintRedemptionToken: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
  })),
}));

vi.mock("@/features/rewards/server/repo", () => ({
  getClaim: mocks.getClaim,
}));

vi.mock("@/features/rewards/server/token", () => ({
  mintRedemptionToken: mocks.mintRedemptionToken,
}));

const { POST } = await import("./route");

const CONSUMER_ID = "11111111-1111-4111-8111-111111111111";
const STAFF_ID = "22222222-2222-4222-8222-222222222222";
const CLAIM_ID = "33333333-3333-4333-8333-333333333333";
const BUSINESS_ID = "44444444-4444-4444-8444-444444444444";

function baseClaim(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    claimId: CLAIM_ID,
    rewardId: "reward-1",
    rewardName: "Free Coffee",
    businessId: BUSINESS_ID,
    consumerId: CONSUMER_ID,
    businessName: "Cafe Giya",
    status: "claimed",
    pointsSpent: 100,
    claimedAt: "2026-07-24T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    redeemedAt: null,
    ...overrides,
  };
}

function mockAuthed(userId: string) {
  mocks.getUser.mockResolvedValue({ data: { user: { id: userId } } });
}

function mockUnauthenticated() {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
}

async function callRoute() {
  const request = new NextRequest(
    `http://localhost/api/v1/reward-claims/${CLAIM_ID}/token`,
    { method: "POST" },
  );
  return POST(request, { params: Promise.resolve({ claimId: CLAIM_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/reward-claims/{claimId}/token", () => {
  it("returns 401 UNAUTHENTICATED when no session", async () => {
    mockUnauthenticated();

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(mocks.getClaim).not.toHaveBeenCalled();
  });

  it("returns 404 NOT_FOUND when the claim does not exist", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockResolvedValue(null);

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(mocks.mintRedemptionToken).not.toHaveBeenCalled();
  });

  it("CRITICAL: returns 404 NOT_FOUND (not a token) when a staff member of the business - not the claim owner - calls this route", async () => {
    // repo.getClaim's RLS union lets staff of BUSINESS_ID read this claim
    // even though it belongs to CONSUMER_ID, so the mock returns the row
    // exactly as RLS would - proving the route's OWN ownership check is
    // what refuses the staff caller, not the database.
    mockAuthed(STAFF_ID);
    mocks.getClaim.mockResolvedValue(baseClaim());

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("This claim was not found.");
    expect(mocks.mintRedemptionToken).not.toHaveBeenCalled();
  });

  it("mints a token and returns 200 with a snake_case body when the caller owns the claim", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockResolvedValue(baseClaim());
    mocks.mintRedemptionToken.mockResolvedValue({
      token: "signed.jwt.token",
      expiresAt: "2026-07-25T12:05:00.000Z",
      jti: "jti-1",
    });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.mintRedemptionToken).toHaveBeenCalledWith(CLAIM_ID, BUSINESS_ID);
    expect(body).toEqual({
      data: { token: "signed.jwt.token", expires_at: "2026-07-25T12:05:00.000Z" },
    });
    // snake_case only: no camelCase "expiresAt" key leaks into the body.
    expect(body.data.expiresAt).toBeUndefined();
  });

  it("returns 409 CLAIM_ALREADY_REDEEMED when the claim's status is 'redeemed'", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockResolvedValue(baseClaim({ status: "redeemed" }));

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({
      code: "CLAIM_ALREADY_REDEEMED",
      message: "This reward was already redeemed.",
    });
    expect(mocks.mintRedemptionToken).not.toHaveBeenCalled();
  });

  it("returns 422 CLAIM_EXPIRED when the claim's status is 'expired'", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockResolvedValue(baseClaim({ status: "expired" }));

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error).toMatchObject({
      code: "CLAIM_EXPIRED",
      message: "This claim has expired.",
    });
  });

  it("returns 422 CLAIM_EXPIRED when status is still 'claimed' but expires_at is in the past", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockResolvedValue(
      baseClaim({ status: "claimed", expiresAt: "2020-01-01T00:00:00.000Z" }),
    );

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("CLAIM_EXPIRED");
  });

  it("returns 422 CLAIM_INVALID_STATE for any other status (e.g. 'cancelled')", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockResolvedValue(baseClaim({ status: "cancelled" }));

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("CLAIM_INVALID_STATE");
  });

  it("returns 500 INTERNAL, not 404, when the claim read fails for a genuine DB error", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockRejectedValue(new Error("connection to database lost"));

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL");
    // Never echoes the raw DB error text to the client (doc 33).
    expect(JSON.stringify(body)).not.toContain("connection to database lost");
  });

  it("every response carries the X-Request-Id header", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockResolvedValue(null);

    const response = await callRoute();

    expect(response.headers.get("X-Request-Id")).toBeTruthy();
  });
});
