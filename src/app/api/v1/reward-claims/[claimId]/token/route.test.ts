import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// src/lib/auth/suspension.ts (imported transitively by this route) is marked
// "server-only", which throws outside Next's react-server condition (vitest
// does not set it) - mocked to a no-op, same as every other server-only test.
vi.mock("server-only", () => ({}));

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
  checkRateLimit: vi.fn(),
  profileMaybeSingle: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    // Backs the suspension gate (src/lib/auth/suspension.ts's
    // readConsumerSuspension), checked before the claim lookup below.
    from: (table: string) => {
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.profileMaybeSingle }) }) };
      }
      throw new Error(`unexpected table read: ${table}`);
    },
  })),
}));

vi.mock("@/features/rewards/server/repo", () => ({
  getClaim: mocks.getClaim,
}));

vi.mock("@/features/rewards/server/token", () => ({
  mintRedemptionToken: mocks.mintRedemptionToken,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

// Real @/lib/redis pulls in @/lib/env, whose client-safe schema is
// validated at module load time - unrelated to anything this route test
// cares about. Mock redisKey deterministically instead of wiring up
// NEXT_PUBLIC_* env vars just to satisfy an unrelated import chain.
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
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
  mocks.checkRateLimit.mockResolvedValue({ ok: true, remaining: 4, resetSeconds: 60 });
  mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: false }, error: null });
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

  // Doc 30 section 2.8 + review finding C1: a suspended consumer must not be
  // able to mint a fresh redemption code, even for a claim they legitimately
  // own, even by calling this route directly.
  it("CRITICAL: refuses a suspended consumer's mint request with 403 ACCOUNT_SUSPENDED", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: true }, error: null });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect(mocks.getClaim).not.toHaveBeenCalled();
    expect(mocks.mintRedemptionToken).not.toHaveBeenCalled();
  });

  it("does not affect an unsuspended consumer's mint request (the negative case)", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: false }, error: null });
    mocks.getClaim.mockResolvedValue(baseClaim());
    mocks.mintRedemptionToken.mockResolvedValue({
      token: "signed.jwt.token",
      expiresAt: "2026-07-25T12:05:00.000Z",
      jti: "jti-1",
    });

    const response = await callRoute();

    expect(response.status).toBe(200);
    expect(mocks.mintRedemptionToken).toHaveBeenCalledWith(CLAIM_ID, BUSINESS_ID);
  });

  it("fails CLOSED (503, refuses to mint) when suspension state cannot be read", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.profileMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(mocks.mintRedemptionToken).not.toHaveBeenCalled();
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

  it("checks the rate limit keyed by (user, claim) before touching the claim", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.getClaim.mockResolvedValue(null);

    await callRoute();

    expect(mocks.checkRateLimit).toHaveBeenCalledWith({
      key: `test:rl:mint:${CONSUMER_ID}:${CLAIM_ID}`,
      limit: 5,
      windowSeconds: 60,
    });
  });

  it("returns 429 RATE_LIMITED with a Retry-After header when the limiter blocks, without touching the claim", async () => {
    mockAuthed(CONSUMER_ID);
    mocks.checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 42 });

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.error).toMatchObject({
      code: "RATE_LIMITED",
      message: "Too many code requests. Please wait a moment.",
    });
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(mocks.getClaim).not.toHaveBeenCalled();
    expect(mocks.mintRedemptionToken).not.toHaveBeenCalled();
  });

  it("does not rate-limit an unauthenticated caller (401 short-circuits first)", async () => {
    mockUnauthenticated();

    await callRoute();

    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });
});
