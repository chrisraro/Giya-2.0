import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal fake of the supabase-js query builder, same shape as
// src/features/menu/menu.test.ts's: every filter/select method returns
// itself, `single`/`maybeSingle` resolve the configured `__result`, and the
// builder is itself thenable so a chain that never calls a terminal method
// (e.g. a bare `.insert().eq()`) still resolves correctly when awaited
// directly. `maybeSingle`/`single` are overridable per-test (via
// `table(...).maybeSingle = vi.fn(...)`) so a single repo function that
// issues two sequential queries against the same table (upsertBaseRule's
// "check for an existing row, then insert-or-update") can be given two
// different results.
const mocks = vi.hoisted(() => {
  function makeBuilder() {
    const builder: Record<string, unknown> = {
      __result: { data: null, error: null } as { data: unknown; error: unknown },
    };
    for (const method of ["select", "insert", "update", "delete", "eq", "in", "is", "order", "limit"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.single = vi.fn(async () => builder.__result);
    builder.maybeSingle = vi.fn(async () => builder.__result);
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(builder.__result).then(resolve, reject);
    return builder;
  }

  return {
    makeBuilder,
    getUser: vi.fn(),
    from: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const actions = await import("./actions");
const { revalidatePath } = await import("next/cache");

type Builder = ReturnType<typeof mocks.makeBuilder>;

const AUTH_USER = { id: "user-1" };
const BUSINESS_STAFF_ROW = { business_id: "biz-1" };
const BUSINESS_ROW = { id: "biz-1", slug: "kape-diaria", name: "Kape Diaria", status: "active" };
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

let builders: Record<string, Builder>;

function table(name: string): Builder {
  const b = builders[name];
  if (!b) throw new Error(`no mock builder registered for table "${name}"`);
  return b;
}

function mockAuthed() {
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });
}

function mockUnauthenticated() {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
}

function mockNoActiveMembership() {
  table("business_staff").__result = { data: null, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();

  builders = {
    business_staff: mocks.makeBuilder(),
    businesses: mocks.makeBuilder(),
    campaigns: mocks.makeBuilder(),
    promotions: mocks.makeBuilder(),
    rewards: mocks.makeBuilder(),
    loyalty_programs: mocks.makeBuilder(),
    points_rules: mocks.makeBuilder(),
  };
  table("business_staff").__result = { data: BUSINESS_STAFF_ROW, error: null };
  table("businesses").__result = { data: BUSINESS_ROW, error: null };

  mocks.from.mockImplementation((name: string) => table(name));

  mockAuthed();
});

// -------------------------------------------------------------- auth gating

describe("actions: auth gating", () => {
  it("createPromotionCampaign returns ok:false and touches nothing when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await actions.createPromotionCampaign({
      name: "Happy Hour",
      promotion: { offerKind: "percent_off", percentOff: 20 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("activateCampaign returns ok:false when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await actions.activateCampaign({ campaignId: CAMPAIGN_ID });

    expect(result.ok).toBe(false);
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });

  it("upsertBaseRule returns ok:false when unauthenticated", async () => {
    mockUnauthenticated();

    const result = await actions.upsertBaseRule({
      ruleType: "amount_rate",
      rateCentavosPerPoint: 100,
      rounding: "floor",
    });

    expect(result.ok).toBe(false);
    expect(table("points_rules").insert).not.toHaveBeenCalled();
  });

  it("returns ok:false when the caller has no active business membership", async () => {
    mockNoActiveMembership();

    const result = await actions.createPromotionCampaign({
      name: "Happy Hour",
      promotion: { offerKind: "percent_off", percentOff: 20 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------- createPromotionCampaign

describe("actions: createPromotionCampaign", () => {
  it("parses input and inserts the campaign then the promotion payload", async () => {
    table("campaigns").__result = {
      data: { id: "camp-1", business_id: "biz-1", type: "promotion", name: "Happy Hour" },
      error: null,
    };

    const result = await actions.createPromotionCampaign({
      name: "Happy Hour",
      promotion: { offerKind: "percent_off", percentOff: 20 },
    });

    expect(result.ok).toBe(true);
    expect(table("campaigns").insert).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: "biz-1", type: "promotion", name: "Happy Hour" }),
    );
    expect(table("promotions").insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        campaign_id: "camp-1",
        offer_kind: "percent_off",
        percent_off: 20,
        amount_off_centavos: null,
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/business/campaigns");
  });

  it("rejects a name under 2 characters", async () => {
    const result = await actions.createPromotionCampaign({
      name: "H",
      promotion: { offerKind: "percent_off", percentOff: 20 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });

  it("rejects percentOff set alongside offerKind 'amount_off'", async () => {
    const result = await actions.createPromotionCampaign({
      name: "Happy Hour",
      promotion: { offerKind: "amount_off", amountOffCentavos: 5000, percentOff: 10 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });

  it("rejects a percent_off offer missing percentOff", async () => {
    const result = await actions.createPromotionCampaign({
      name: "Happy Hour",
      promotion: { offerKind: "percent_off" },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });

  it("rejects percentOff out of range (0-100)", async () => {
    const result = await actions.createPromotionCampaign({
      name: "Happy Hour",
      promotion: { offerKind: "percent_off", percentOff: 150 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });

  it("rejects endsAt at or before startsAt with a friendly message instead of hitting the DB", async () => {
    const result = await actions.createPromotionCampaign({
      name: "Happy Hour",
      startsAt: new Date("2026-08-01T00:00:00Z"),
      endsAt: new Date("2026-07-01T00:00:00Z"),
      promotion: { offerKind: "percent_off", percentOff: 20 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.toLowerCase()).toContain("endsat");
    }
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });

  it("soft-deletes the campaign and returns ok:false when the promotion insert fails", async () => {
    table("campaigns").__result = { data: { id: "camp-1" }, error: null };
    table("promotions").__result = { data: null, error: { message: "db error" } };

    const result = await actions.createPromotionCampaign({
      name: "Happy Hour",
      promotion: { offerKind: "percent_off", percentOff: 20 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
  });
});

// ------------------------------------------------------- createRewardCampaign

describe("actions: createRewardCampaign", () => {
  const VALID_INPUT = {
    name: "Free Coffee Wednesdays",
    reward: {
      name: "Free Coffee",
      pointsCost: 100,
      perCustomerLimit: 1,
      claimExpiryDays: 30,
    },
  };

  it("parses input and inserts the campaign then the reward payload", async () => {
    table("campaigns").__result = { data: { id: "camp-2", type: "reward" }, error: null };

    const result = await actions.createRewardCampaign(VALID_INPUT);

    expect(result.ok).toBe(true);
    expect(table("campaigns").insert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reward", name: "Free Coffee Wednesdays" }),
    );
    expect(table("rewards").insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        campaign_id: "camp-2",
        name: "Free Coffee",
        points_cost: 100,
        per_customer_limit: 1,
        claim_expiry_days: 30,
        total_inventory: null,
      }),
    );
  });

  it("rejects perCustomerLimit of 0", async () => {
    const result = await actions.createRewardCampaign({
      ...VALID_INPUT,
      reward: { ...VALID_INPUT.reward, perCustomerLimit: 0 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });

  it("rejects claimExpiryDays over 365", async () => {
    const result = await actions.createRewardCampaign({
      ...VALID_INPUT,
      reward: { ...VALID_INPUT.reward, claimExpiryDays: 400 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------ createLoyaltyCampaign

describe("actions: createLoyaltyCampaign", () => {
  const VALID_INPUT = {
    name: "Coffee Club",
    loyaltyProgram: {
      programType: "visit_count",
      targetValue: 10,
      prizeReward: { name: "Free Coffee" },
    },
  };

  it("parses input and inserts the campaign, prize reward, then the program", async () => {
    table("campaigns").__result = { data: { id: "camp-3", type: "loyalty" }, error: null };
    table("rewards").__result = { data: { id: "reward-1" }, error: null };

    const result = await actions.createLoyaltyCampaign(VALID_INPUT);

    expect(result.ok).toBe(true);
    expect(table("rewards").insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        campaign_id: "camp-3",
        name: "Free Coffee",
        claim_kind: "loyalty_completion",
        points_cost: 0,
      }),
    );
    expect(table("loyalty_programs").insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        campaign_id: "camp-3",
        program_type: "visit_count",
        target_value: 10,
        reward_id: "reward-1",
      }),
    );
  });

  it("rejects targetValue of 0", async () => {
    const result = await actions.createLoyaltyCampaign({
      ...VALID_INPUT,
      loyaltyProgram: { ...VALID_INPUT.loyaltyProgram, targetValue: 0 },
    });

    expect(result.ok).toBe(false);
    expect(table("campaigns").insert).not.toHaveBeenCalled();
  });

  it("soft-deletes the campaign and the prize reward when the loyalty_programs insert fails", async () => {
    table("campaigns").__result = { data: { id: "camp-3" }, error: null };
    table("rewards").__result = { data: { id: "reward-1" }, error: null };
    table("loyalty_programs").__result = { data: null, error: { message: "db error" } };

    const result = await actions.createLoyaltyCampaign(VALID_INPUT);

    expect(result.ok).toBe(false);
    expect(table("rewards").update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
    expect(table("campaigns").update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }),
    );
  });
});

// ------------------------------------------------------------ activateCampaign

describe("actions: activateCampaign gate enforcement", () => {
  it("returns ok:false with CAMPAIGN_PAYLOAD_INCOMPLETE when a promotion campaign has no promotions row", async () => {
    table("campaigns").__result = {
      data: {
        id: CAMPAIGN_ID,
        business_id: "biz-1",
        type: "promotion",
        status: "draft",
        starts_at: null,
        ends_at: null,
        timezone: "Asia/Manila",
        budget: {},
        deleted_at: null,
      },
      error: null,
    };
    // No promotions row for this campaign (G2 payload-incomplete).
    table("promotions").__result = { data: null, error: null };

    const result = await actions.activateCampaign({ campaignId: CAMPAIGN_ID });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, code: "CAMPAIGN_PAYLOAD_INCOMPLETE" }),
    );
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });

  it("returns ok:false with BUSINESS_NOT_VERIFIED when the business is not active", async () => {
    table("campaigns").__result = {
      data: {
        id: CAMPAIGN_ID,
        business_id: "biz-1",
        type: "promotion",
        status: "draft",
        starts_at: null,
        ends_at: null,
        timezone: "Asia/Manila",
        budget: {},
        deleted_at: null,
      },
      error: null,
    };
    table("promotions").__result = { data: { id: "promo-1" }, error: null };
    table("businesses").__result = { data: { status: "pending_verification" }, error: null };

    const result = await actions.activateCampaign({ campaignId: CAMPAIGN_ID });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: "BUSINESS_NOT_VERIFIED" }));
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });

  it("activates a draft campaign with a complete payload and stamps starts_at when null", async () => {
    table("campaigns").__result = {
      data: {
        id: CAMPAIGN_ID,
        business_id: "biz-1",
        type: "promotion",
        status: "draft",
        starts_at: null,
        ends_at: null,
        timezone: "Asia/Manila",
        budget: {},
        deleted_at: null,
      },
      error: null,
    };
    table("promotions").__result = { data: { id: "promo-1" }, error: null };

    const result = await actions.activateCampaign({ campaignId: CAMPAIGN_ID });

    expect(result.ok).toBe(true);
    expect(table("campaigns").update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", starts_at: expect.any(String) }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/business/campaigns");
  });

  it("returns ok:false when the campaign is not found", async () => {
    table("campaigns").__result = { data: null, error: null };

    const result = await actions.activateCampaign({ campaignId: CAMPAIGN_ID });

    expect(result.ok).toBe(false);
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid campaignId", async () => {
    const result = await actions.activateCampaign({ campaignId: "nope" });

    expect(result.ok).toBe(false);
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });

  it("returns ok:false with CAMPAIGN_INVALID_STATE when activating an already-archived campaign", async () => {
    table("campaigns").__result = {
      data: {
        id: CAMPAIGN_ID,
        business_id: "biz-1",
        type: "promotion",
        status: "archived",
        starts_at: null,
        ends_at: null,
        timezone: "Asia/Manila",
        budget: {},
        deleted_at: null,
      },
      error: null,
    };
    // Gates (payload/business) are satisfied so only the transition check fails.
    table("promotions").__result = { data: { id: "promo-1" }, error: null };

    const result = await actions.activateCampaign({ campaignId: CAMPAIGN_ID });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: "CAMPAIGN_INVALID_STATE" }));
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });

  it("returns ok:false with CAMPAIGN_INVALID_STATE when activating an ended campaign", async () => {
    table("campaigns").__result = {
      data: {
        id: CAMPAIGN_ID,
        business_id: "biz-1",
        type: "promotion",
        status: "ended",
        starts_at: null,
        ends_at: null,
        timezone: "Asia/Manila",
        budget: {},
        deleted_at: null,
      },
      error: null,
    };
    table("promotions").__result = { data: { id: "promo-1" }, error: null };

    const result = await actions.activateCampaign({ campaignId: CAMPAIGN_ID });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: "CAMPAIGN_INVALID_STATE" }));
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------- pauseCampaign / archive

describe("actions: pauseCampaign / archiveCampaign", () => {
  it("pauses an active campaign", async () => {
    table("campaigns").__result = { data: { id: CAMPAIGN_ID, status: "active" }, error: null };

    const result = await actions.pauseCampaign({ campaignId: CAMPAIGN_ID });

    expect(result.ok).toBe(true);
    expect(table("campaigns").update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
  });

  it("rejects pausing a draft campaign (invalid transition)", async () => {
    table("campaigns").__result = { data: { id: CAMPAIGN_ID, status: "draft" }, error: null };

    const result = await actions.pauseCampaign({ campaignId: CAMPAIGN_ID });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: "CAMPAIGN_INVALID_STATE" }));
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });

  it("archives an ended campaign and stamps archived_at", async () => {
    table("campaigns").__result = { data: { id: CAMPAIGN_ID, status: "ended" }, error: null };

    const result = await actions.archiveCampaign({ campaignId: CAMPAIGN_ID });

    expect(result.ok).toBe(true);
    expect(table("campaigns").update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "archived", archived_at: expect.any(String) }),
    );
  });

  it("rejects archiving an active campaign (invalid transition)", async () => {
    table("campaigns").__result = { data: { id: CAMPAIGN_ID, status: "active" }, error: null };

    const result = await actions.archiveCampaign({ campaignId: CAMPAIGN_ID });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: "CAMPAIGN_INVALID_STATE" }));
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ resumeCampaign

describe("actions: resumeCampaign", () => {
  it("resumes a paused campaign", async () => {
    table("campaigns").__result = { data: { id: CAMPAIGN_ID, status: "paused" }, error: null };

    const result = await actions.resumeCampaign({ campaignId: CAMPAIGN_ID });

    expect(result.ok).toBe(true);
    expect(table("campaigns").update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("rejects resuming a draft campaign (invalid transition)", async () => {
    table("campaigns").__result = { data: { id: CAMPAIGN_ID, status: "draft" }, error: null };

    const result = await actions.resumeCampaign({ campaignId: CAMPAIGN_ID });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: "CAMPAIGN_INVALID_STATE" }));
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });

  it("rejects resuming an already-active campaign (invalid transition)", async () => {
    table("campaigns").__result = { data: { id: CAMPAIGN_ID, status: "active" }, error: null };

    const result = await actions.resumeCampaign({ campaignId: CAMPAIGN_ID });

    expect(result).toEqual(expect.objectContaining({ ok: false, code: "CAMPAIGN_INVALID_STATE" }));
    expect(table("campaigns").update).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------- upsertBaseRule

describe("actions: upsertBaseRule", () => {
  it("inserts a new base rule when none exists yet", async () => {
    table("points_rules").maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    table("points_rules").__result = {
      data: { id: "rule-1", business_id: "biz-1", kind: "base", rule_type: "amount_rate" },
      error: null,
    };

    const result = await actions.upsertBaseRule({
      ruleType: "amount_rate",
      rateCentavosPerPoint: 100,
      rounding: "floor",
    });

    expect(result.ok).toBe(true);
    expect(table("points_rules").insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: "biz-1",
        kind: "base",
        campaign_id: null,
        rule_type: "amount_rate",
        rate_centavos_per_point: 100,
        rounding: "floor",
      }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/business/campaigns");
  });

  it("updates the existing base rule instead of inserting a second one", async () => {
    table("points_rules").maybeSingle = vi.fn(async () => ({ data: { id: "rule-1" }, error: null }));
    table("points_rules").__result = { data: { id: "rule-1", rule_type: "fixed_per_visit" }, error: null };

    const result = await actions.upsertBaseRule({
      ruleType: "fixed_per_visit",
      fixedPoints: 5,
      rounding: "floor",
    });

    expect(result.ok).toBe(true);
    expect(table("points_rules").insert).not.toHaveBeenCalled();
    expect(table("points_rules").update).toHaveBeenCalledWith(
      expect.objectContaining({ rule_type: "fixed_per_visit", fixed_points: 5 }),
    );
    expect(table("points_rules").eq).toHaveBeenCalledWith("id", "rule-1");
  });

  it("returns the friendly 'A base earning rule already exists' message on a 23505 unique violation", async () => {
    table("points_rules").maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    table("points_rules").__result = {
      data: null,
      error: { message: "duplicate key value violates unique constraint \"points_rules_one_base\"", code: "23505" },
    };

    const result = await actions.upsertBaseRule({
      ruleType: "amount_rate",
      rateCentavosPerPoint: 100,
      rounding: "floor",
    });

    expect(result).toEqual({ ok: false, message: "A base earning rule already exists" });
  });

  it("rejects a base rule missing rateCentavosPerPoint for amount_rate", async () => {
    const result = await actions.upsertBaseRule({
      ruleType: "amount_rate",
      rounding: "floor",
    });

    expect(result.ok).toBe(false);
    expect(table("points_rules").insert).not.toHaveBeenCalled();
  });

  it("rejects an unknown ruleType", async () => {
    const result = await actions.upsertBaseRule({
      ruleType: "tiered_amount",
      rounding: "floor",
    });

    expect(result.ok).toBe(false);
    expect(table("points_rules").insert).not.toHaveBeenCalled();
  });
});

// -------------------------------------------- repo.getCampaignPayloadPresence

describe("repo.getCampaignPayloadPresence", () => {
  it("scopes the points_rules count to active, non-deleted rows", async () => {
    const repo = await import("./server/repo");
    table("points_rules").__result = { data: [{ id: "rule-1" }], error: null };

    const presence = await repo.getCampaignPayloadPresence("biz-1", CAMPAIGN_ID);

    expect(presence.pointsRuleCount).toBe(1);
    expect(table("points_rules").eq).toHaveBeenCalledWith("is_active", true);
    expect(table("points_rules").is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("does not count an inactive points rule toward presence", async () => {
    const repo = await import("./server/repo");
    // Simulates the filtered query correctly excluding the inactive row.
    table("points_rules").__result = { data: [], error: null };

    const presence = await repo.getCampaignPayloadPresence("biz-1", CAMPAIGN_ID);

    expect(presence.pointsRuleCount).toBe(0);
  });
});

describe("service.emitLifecycleEvent", () => {
  it("logs without throwing", async () => {
    const { emitLifecycleEvent } = await import("./server/service");
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    expect(() => emitLifecycleEvent("biz-1", "camp-1", "activate")).not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("biz-1"));

    spy.mockRestore();
  });
});
