import { describe, it, expect, vi, beforeEach } from "vitest";

// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set); token.ts (transitively imported by
// service.ts) needs it mocked to a no-op, same as
// src/features/rewards/server/token.test.ts.
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  consumeRedemptionToken: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
  })),
}));

class MockRedemptionTokenError extends Error {
  readonly code = "REDEMPTION_TOKEN_INVALID";
  constructor(message = "Redemption token is invalid, expired, or already used") {
    super(message);
    this.name = "RedemptionTokenError";
  }
}

vi.mock("@/features/rewards/server/token", () => ({
  consumeRedemptionToken: mocks.consumeRedemptionToken,
  RedemptionTokenError: MockRedemptionTokenError,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const service = await import("./server/service");
const actions = await import("./actions");
const { revalidatePath } = await import("next/cache");

const AUTH_USER = { id: "user-1" };
const REWARD_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";

function mockAuthed() {
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });
}

function mockUnauthenticated() {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthed();
});

// ------------------------------------------------------------ mapClaimError

describe("mapClaimError", () => {
  const cases: Array<[string, string]> = [
    ["REWARD_UNAVAILABLE", "This reward is no longer available."],
    ["CUSTOMER_RECORD_MISSING", "Something went wrong. Please try again."],
    ["CUSTOMER_BLACKLISTED", "This account cannot claim rewards from this business."],
    ["REWARD_LIMIT_REACHED", "You have already claimed this reward."],
    ["CAMPAIGN_LIMIT_REACHED", "You have already claimed this reward."],
    ["CAMPAIGN_BUDGET_EXHAUSTED", "This promo has reached its limit."],
    ["REWARD_OUT_OF_STOCK", "This reward just ran out."],
    ["POINTS_INSUFFICIENT", "You do not have enough points for this reward yet."],
    ["UNAUTHENTICATED", "Please sign in to claim rewards."],
  ];

  it.each(cases)("maps %s to the documented consumer-facing copy", (code, message) => {
    expect(service.mapClaimError(code)).toEqual({ code, message });
  });

  it("maps an unrecognized message to a generic UNKNOWN error, never echoing raw text", () => {
    expect(service.mapClaimError("division_by_zero at line 42")).toEqual({
      code: "UNKNOWN",
      message: "Something went wrong. Please try again.",
    });
  });

  it("maps an empty message to UNKNOWN", () => {
    expect(service.mapClaimError("")).toEqual({
      code: "UNKNOWN",
      message: "Something went wrong. Please try again.",
    });
  });
});

// ---------------------------------------------------------- mapValidateError

describe("mapValidateError", () => {
  const cases: Array<[string, string]> = [
    ["FORBIDDEN", "You do not have permission to validate for this business."],
    ["CLAIM_ALREADY_REDEEMED", "This reward was already redeemed."],
    ["CLAIM_ALREADY_CANCELLED", "This claim was cancelled by the customer."],
    ["CLAIM_INVALID_STATE", "This claim cannot be redeemed right now."],
    ["CLAIM_EXPIRED", "This claim has expired."],
    ["CUSTOMER_BLACKLISTED", "This account cannot redeem rewards at this business."],
    [
      "REDEMPTION_TOKEN_INVALID",
      "This code is no longer valid. Ask the customer to refresh it.",
    ],
    ["REDEMPTION_METHOD_INVALID", "Unsupported redemption method."],
    ["UNAUTHENTICATED", "Please sign in to validate redemptions."],
  ];

  it.each(cases)("maps %s to the documented staff-facing copy", (code, message) => {
    expect(service.mapValidateError(code)).toEqual({ code, message });
  });

  it("maps an unrecognized message to a generic UNKNOWN error, never echoing raw text", () => {
    expect(service.mapValidateError("relation reward_claims does not exist")).toEqual({
      code: "UNKNOWN",
      message: "Something went wrong. Please try again.",
    });
  });
});

// --------------------------------------------------------- service.claimReward

describe("service.claimReward", () => {
  it("returns ok:true with the claim id on success", async () => {
    mocks.rpc.mockResolvedValue({ data: CLAIM_ID, error: null });

    const result = await service.claimReward(REWARD_ID);

    expect(result).toEqual({ ok: true, data: { claimId: CLAIM_ID } });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_reward", { p_reward_id: REWARD_ID });
  });

  it("maps a REWARD_OUT_OF_STOCK RPC error to the friendly message", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "REWARD_OUT_OF_STOCK" } });

    const result = await service.claimReward(REWARD_ID);

    expect(result).toEqual({
      ok: false,
      message: "This reward just ran out.",
      code: "REWARD_OUT_OF_STOCK",
    });
  });

  it("maps a POINTS_INSUFFICIENT RPC error to the friendly message", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "POINTS_INSUFFICIENT" } });

    const result = await service.claimReward(REWARD_ID);

    expect(result).toEqual({
      ok: false,
      message: "You do not have enough points for this reward yet.",
      code: "POINTS_INSUFFICIENT",
    });
  });
});

// ----------------------------------------------------- service.validateRedemption

describe("service.validateRedemption", () => {
  const TOKEN = "signed.jwt.token";
  const RPC_PAYLOAD = {
    claim_id: CLAIM_ID,
    reward_name: "Free Coffee",
    consumer_name: "Juan Dela Cruz",
    redeemed_at: "2026-07-25T12:00:00.000Z",
  };

  it("consumes the token, then calls the RPC, and returns the mapped payload on success", async () => {
    mocks.consumeRedemptionToken.mockResolvedValue({
      claimId: CLAIM_ID,
      businessId: "biz-1",
      jti: "jti-1",
    });
    mocks.rpc.mockResolvedValue({ data: RPC_PAYLOAD, error: null });

    const result = await service.validateRedemption(TOKEN, "qr");

    expect(mocks.consumeRedemptionToken).toHaveBeenCalledWith(TOKEN);
    expect(mocks.rpc).toHaveBeenCalledWith("validate_redemption", {
      p_claim_id: CLAIM_ID,
      p_token_jti: "jti-1",
      p_method: "qr",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        claimId: CLAIM_ID,
        rewardName: "Free Coffee",
        consumerName: "Juan Dela Cruz",
        redeemedAt: "2026-07-25T12:00:00.000Z",
      },
    });
  });

  it("returns REDEMPTION_TOKEN_INVALID without calling the RPC when the token fails to consume", async () => {
    mocks.consumeRedemptionToken.mockRejectedValue(new MockRedemptionTokenError());

    const result = await service.validateRedemption(TOKEN);

    expect(result).toEqual({
      ok: false,
      code: "REDEMPTION_TOKEN_INVALID",
      message: "This code is no longer valid. Ask the customer to refresh it.",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("maps a CLAIM_ALREADY_REDEEMED RPC error, with the token already consumed by that point", async () => {
    mocks.consumeRedemptionToken.mockResolvedValue({
      claimId: CLAIM_ID,
      businessId: "biz-1",
      jti: "jti-1",
    });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "CLAIM_ALREADY_REDEEMED" } });

    const result = await service.validateRedemption(TOKEN);

    // The token-consumed-before-RPC ordering means consumeRedemptionToken
    // was already called exactly once by the time the RPC fails - the burn
    // is not undone, which is intentional (see the comment on
    // service.validateRedemption).
    expect(mocks.consumeRedemptionToken).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      code: "CLAIM_ALREADY_REDEEMED",
      message: "This reward was already redeemed.",
    });
  });
});

// -------------------------------------------------------------- actions: auth

describe("actions.claimReward: auth and validation gating", () => {
  it("returns ok:false and never calls the RPC when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await actions.claimReward({ rewardId: REWARD_ID });

    expect(result).toEqual({
      ok: false,
      message: "Please sign in to claim rewards.",
      code: "UNAUTHENTICATED",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns ok:false and never calls the RPC when rewardId is not a uuid", async () => {
    const result = await actions.claimReward({ rewardId: "not-a-uuid" });

    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------- actions: claimReward

describe("actions.claimReward", () => {
  it("returns ok:true with the claim id and revalidates /rewards and /wallet on success", async () => {
    mocks.rpc.mockResolvedValue({ data: CLAIM_ID, error: null });

    const result = await actions.claimReward({ rewardId: REWARD_ID });

    expect(result).toEqual({ ok: true, data: { claimId: CLAIM_ID } });
    expect(revalidatePath).toHaveBeenCalledWith("/rewards");
    expect(revalidatePath).toHaveBeenCalledWith("/wallet");
  });

  it("returns ok:false with the mapped message and does not revalidate when the RPC errors", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "CAMPAIGN_BUDGET_EXHAUSTED" } });

    const result = await actions.claimReward({ rewardId: REWARD_ID });

    expect(result).toEqual({
      ok: false,
      message: "This promo has reached its limit.",
      code: "CAMPAIGN_BUDGET_EXHAUSTED",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ mapCancelError

describe("mapCancelError", () => {
  const cases: Array<[string, string]> = [
    ["FORBIDDEN", "Something went wrong. Please try again."],
    ["CLAIM_ALREADY_REDEEMED", "This reward was already redeemed, so it can no longer be cancelled."],
    ["CLAIM_ALREADY_CANCELLED", "This claim was already cancelled."],
    ["CLAIM_INVALID_STATE", "This claim can't be cancelled right now."],
    ["UNAUTHENTICATED", "Please sign in to manage your claims."],
  ];

  it.each(cases)("maps %s to the documented consumer-facing copy", (code, message) => {
    expect(service.mapCancelError(code)).toEqual({ code, message });
  });

  it("maps an unrecognized message to a generic UNKNOWN error, never echoing raw text", () => {
    expect(service.mapCancelError("relation reward_claims does not exist")).toEqual({
      code: "UNKNOWN",
      message: "Something went wrong. Please try again.",
    });
  });
});

// -------------------------------------------------------- service.cancelClaim

describe("service.cancelClaim", () => {
  it("calls the cancel_claim RPC with the claim id and returns ok:true on success", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    const result = await service.cancelClaim(CLAIM_ID);

    expect(mocks.rpc).toHaveBeenCalledWith("cancel_claim", { p_claim_id: CLAIM_ID });
    expect(result).toEqual({ ok: true, data: { claimId: CLAIM_ID } });
  });

  it("maps a CLAIM_ALREADY_CANCELLED RPC error to the friendly message", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "CLAIM_ALREADY_CANCELLED" } });

    const result = await service.cancelClaim(CLAIM_ID);

    expect(result).toEqual({
      ok: false,
      message: "This claim was already cancelled.",
      code: "CLAIM_ALREADY_CANCELLED",
    });
  });

  it("maps a CLAIM_ALREADY_REDEEMED RPC error to the friendly message", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "CLAIM_ALREADY_REDEEMED" } });

    const result = await service.cancelClaim(CLAIM_ID);

    expect(result).toEqual({
      ok: false,
      message: "This reward was already redeemed, so it can no longer be cancelled.",
      code: "CLAIM_ALREADY_REDEEMED",
    });
  });
});

// -------------------------------------------------------------- actions: cancelClaim

describe("actions.cancelClaim: auth and validation gating", () => {
  it("returns ok:false and never calls the RPC when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await actions.cancelClaim({ claimId: CLAIM_ID });

    expect(result).toEqual({
      ok: false,
      message: "Please sign in to claim rewards.",
      code: "UNAUTHENTICATED",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns ok:false and never calls the RPC when claimId is not a uuid", async () => {
    const result = await actions.cancelClaim({ claimId: "not-a-uuid" });

    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("actions.cancelClaim", () => {
  it("returns ok:true and revalidates /rewards and /wallet on success", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    const result = await actions.cancelClaim({ claimId: CLAIM_ID });

    expect(result).toEqual({ ok: true, data: { claimId: CLAIM_ID } });
    expect(revalidatePath).toHaveBeenCalledWith("/rewards");
    expect(revalidatePath).toHaveBeenCalledWith("/wallet");
    expect(revalidatePath).toHaveBeenCalledWith(`/rewards/claims/${CLAIM_ID}`);
  });

  it("returns ok:false with the mapped message and does not revalidate when the RPC errors", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "CLAIM_ALREADY_CANCELLED" } });

    const result = await actions.cancelClaim({ claimId: CLAIM_ID });

    expect(result).toEqual({
      ok: false,
      message: "This claim was already cancelled.",
      code: "CLAIM_ALREADY_CANCELLED",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
