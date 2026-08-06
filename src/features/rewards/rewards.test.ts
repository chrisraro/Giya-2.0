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
  profileMaybeSingle: vi.fn(),
  businessMaybeSingle: vi.fn(),
  claimRowMaybeSingle: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

// Session-scoped client dispatch, shared by both the "profiles" read
// (claimReward's own suspension gate) and the "reward_claims"/"businesses"/
// "profiles" reads used by validateRedemption's suspension gate below - the
// LATTER go through the service-role client instead (staff cannot read
// another user's `profiles.is_suspended` under RLS), which is why this same
// table-dispatch shape is reused for `createServiceRoleClient`'s return
// value too.
function tableDispatch(table: string) {
  if (table === "profiles") {
    return { select: () => ({ eq: () => ({ maybeSingle: mocks.profileMaybeSingle }) }) };
  }
  if (table === "businesses") {
    return { select: () => ({ eq: () => ({ maybeSingle: mocks.businessMaybeSingle }) }) };
  }
  if (table === "reward_claims") {
    return { select: () => ({ eq: () => ({ maybeSingle: mocks.claimRowMaybeSingle }) }) };
  }
  throw new Error(`unexpected table read: ${table}`);
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: tableDispatch,
  })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
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
  // `clearAllMocks` clears call history but NOT a previously-set
  // `mockResolvedValue` implementation (that needs `mockReset`/
  // `resetAllMocks`, and the latter would also wipe `createClient`'s own
  // factory implementation, breaking every test). `rpc` and
  // `consumeRedemptionToken` are reset explicitly here so a test that
  // expects the RPC never to be called cannot accidentally observe a
  // PREVIOUS test's leftover resolved value if a mutant makes the guard
  // above it fall through - every test either sets its own value or gets a
  // clean vi.fn() that resolves to `undefined`.
  mocks.rpc.mockReset();
  mocks.consumeRedemptionToken.mockReset();
  mockAuthed();
  mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: false }, error: null });
  mocks.businessMaybeSingle.mockResolvedValue({ data: { status: "active" }, error: null });
  mocks.claimRowMaybeSingle.mockResolvedValue({
    data: { business_id: "biz-1", consumer_id: "consumer-1" },
    error: null,
  });
  mocks.createServiceRoleClient.mockReturnValue({ from: tableDispatch });
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

    const result = await service.claimReward(REWARD_ID, AUTH_USER.id);

    expect(result).toEqual({ ok: true, data: { claimId: CLAIM_ID } });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_reward", { p_reward_id: REWARD_ID });
  });

  it("maps a REWARD_OUT_OF_STOCK RPC error to the friendly message", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "REWARD_OUT_OF_STOCK" } });

    const result = await service.claimReward(REWARD_ID, AUTH_USER.id);

    expect(result).toEqual({
      ok: false,
      message: "This reward just ran out.",
      code: "REWARD_OUT_OF_STOCK",
    });
  });

  it("maps a POINTS_INSUFFICIENT RPC error to the friendly message", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "POINTS_INSUFFICIENT" } });

    const result = await service.claimReward(REWARD_ID, AUTH_USER.id);

    expect(result).toEqual({
      ok: false,
      message: "You do not have enough points for this reward yet.",
      code: "POINTS_INSUFFICIENT",
    });
  });
});

// ------------------------------------------------- service.claimReward: suspension
//
// Doc 30 section 2.8 + the brief's requirement 3: a suspended consumer must be
// refused even if the UI screen that would normally redirect them never runs.
// claim_reward's own SQL guards segment='blacklisted', a DIFFERENT mechanism
// (business_customers.segment, per-tenant) from profiles.is_suspended
// (platform-wide) - this gate is the one that closes THAT gap, in TypeScript,
// before the RPC is ever called.
describe("service.claimReward: suspension gate (doc 30 section 2.8)", () => {
  it("CRITICAL: refuses a suspended consumer without ever calling claim_reward", async () => {
    mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: true }, error: null });

    const result = await service.claimReward(REWARD_ID, AUTH_USER.id);

    expect(result).toEqual({
      ok: false,
      message: "Your account is suspended. Contact us if you think this is a mistake.",
      code: "ACCOUNT_SUSPENDED",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not affect an unsuspended consumer (the negative case)", async () => {
    mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: false }, error: null });
    mocks.rpc.mockResolvedValue({ data: CLAIM_ID, error: null });

    const result = await service.claimReward(REWARD_ID, AUTH_USER.id);

    expect(result).toEqual({ ok: true, data: { claimId: CLAIM_ID } });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_reward", { p_reward_id: REWARD_ID });
  });

  it("fails CLOSED (refuses, does not call the RPC) when suspension state cannot be read", async () => {
    mocks.profileMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await service.claimReward(REWARD_ID, AUTH_USER.id);

    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  // Regression for a review finding: this function used to re-derive the
  // caller via its OWN supabase.auth.getUser() call and wrap the whole
  // suspension check in `if (user)`. A transient GoTrue failure on THAT call
  // (distinct from the RPC's own local JWT verification of auth.uid()) made
  // `user` null, which SKIPPED the suspension check entirely while the RPC
  // still succeeded off the same valid cookie. Taking `userId` as a required
  // parameter removed the conditional; this test proves the suspension check
  // runs regardless of what auth.getUser() would have answered.
  it("CRITICAL: checks suspension unconditionally, not gated on its own auth.getUser() call", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } }); // simulates the transient failure
    mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: true }, error: null });

    const result = await service.claimReward(REWARD_ID, AUTH_USER.id);

    expect(result).toEqual({
      ok: false,
      message: "Your account is suspended. Contact us if you think this is a mistake.",
      code: "ACCOUNT_SUSPENDED",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
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

// --------------------------------------------- service.validateRedemption: suspension
//
// Doc 30 section 2.8 + the brief's requirement 3: a suspended party - either
// the BUSINESS or the CLAIMING CONSUMER - must not be able to complete a
// redemption by calling this service function directly. validate_redemption's
// own SQL guards the claim's segment='blacklisted' (a different, per-customer
// mechanism); this gate reads the claim's business_id/consumer_id fresh via
// the service-role client (repo comment: a staff session cannot see another
// user's `profiles.is_suspended` under RLS) and checks both, in TypeScript,
// before the RPC runs.
function mockToken() {
  mocks.consumeRedemptionToken.mockResolvedValue({
    claimId: CLAIM_ID,
    businessId: "biz-1",
    jti: "jti-1",
  });
}

const SUCCESSFUL_RPC_PAYLOAD = {
  data: {
    claim_id: CLAIM_ID,
    reward_name: "Free Coffee",
    consumer_name: "Juan Dela Cruz",
    redeemed_at: "2026-07-25T12:00:00.000Z",
  },
  error: null,
};

describe("service.validateRedemption: suspension gate (doc 30 section 2.8)", () => {
  it("CRITICAL: refuses when the claim's business is suspended, without calling validate_redemption", async () => {
    mockToken();
    mocks.businessMaybeSingle.mockResolvedValue({ data: { status: "suspended" }, error: null });

    const result = await service.validateRedemption("signed.jwt.token");

    expect(result).toEqual({
      ok: false,
      code: "BUSINESS_SUSPENDED",
      message: "Redemptions are paused for this business account.",
    });
    // The token is already burned by this point (see the ordering comment on
    // validateRedemption) - that is intended, not a bug this test is guarding
    // against.
    expect(mocks.consumeRedemptionToken).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  // C1 fix: the claiming consumer's OWN suspension must also refuse the
  // redemption, independent of the business. Without this, a consumer could
  // pre-claim rewards, get suspended, and still have every held claim
  // redeemed by walking into any (unsuspended) store - points already moved
  // at claim time, but the goods had not yet changed hands.
  it("CRITICAL: refuses when the claiming consumer is suspended, without calling validate_redemption", async () => {
    mockToken();
    mocks.claimRowMaybeSingle.mockResolvedValue({
      data: { business_id: "biz-1", consumer_id: "suspended-consumer" },
      error: null,
    });
    mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: true }, error: null });

    const result = await service.validateRedemption("signed.jwt.token");

    expect(result).toEqual({
      ok: false,
      code: "ACCOUNT_SUSPENDED",
      message: "This customer's account is suspended and cannot redeem rewards.",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not affect an active business's redemption by an unsuspended consumer (the negative case)", async () => {
    mockToken();
    mocks.rpc.mockResolvedValue(SUCCESSFUL_RPC_PAYLOAD);

    const result = await service.validateRedemption("signed.jwt.token");

    expect(result.ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("validate_redemption", {
      p_claim_id: CLAIM_ID,
      p_token_jti: "jti-1",
      p_method: "qr",
    });
  });

  it("fails CLOSED (refuses, does not call the RPC) when the business's status cannot be read", async () => {
    mockToken();
    mocks.businessMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await service.validateRedemption("signed.jwt.token");

    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails CLOSED (refuses, does not call the RPC) when the consumer's suspension state cannot be read", async () => {
    mockToken();
    mocks.profileMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await service.validateRedemption("signed.jwt.token");

    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails CLOSED (refuses, does not call the RPC) when the claim itself cannot be read", async () => {
    mockToken();
    mocks.claimRowMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await service.validateRedemption("signed.jwt.token");

    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("skips straight to the RPC (which answers FORBIDDEN) when the claim genuinely does not exist", async () => {
    mockToken();
    mocks.claimRowMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "FORBIDDEN" } });

    const result = await service.validateRedemption("signed.jwt.token");

    expect(result).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "You do not have permission to validate for this business.",
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED when the service-role client is unavailable", async () => {
    mockToken();
    mocks.createServiceRoleClient.mockReturnValue(null);

    const result = await service.validateRedemption("signed.jwt.token");

    expect(result.ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
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

  // THE ASSERTION THAT MATTERS MOST (brief requirement 3): a suspended
  // consumer must be refused by calling this "use server" action directly,
  // with no screen, no redirect, and no UI in the loop at all - the screen at
  // /suspended is a courtesy the consumer layout adds; this is the control.
  it("CRITICAL: refuses a suspended consumer calling the server action directly, with no revalidation", async () => {
    mocks.profileMaybeSingle.mockResolvedValue({ data: { is_suspended: true }, error: null });

    const result = await actions.claimReward({ rewardId: REWARD_ID });

    expect(result).toEqual({
      ok: false,
      message: "Your account is suspended. Contact us if you think this is a mistake.",
      code: "ACCOUNT_SUSPENDED",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
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
      message: "Please sign in to manage your claims.",
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
