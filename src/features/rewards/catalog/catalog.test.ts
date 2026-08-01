import { describe, it, expect, vi, beforeEach } from "vitest";

// Same minimal supabase-js query-builder fake as
// src/features/campaigns/campaigns.test.ts: every filter/select method returns
// itself, `single`/`maybeSingle` resolve the configured `__result`, and the
// builder is thenable so a chain that never calls a terminal method still
// resolves when awaited. `single`/`maybeSingle` are overridable per test, which
// is how a repo function that issues two queries against the SAME table
// (updateReward: read the existing row, then write it) gets two answers.
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

  return { makeBuilder, getUser: vi.fn(), from: vi.fn() };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const actions = await import("./actions");
const { REWARD_CATALOG_ROLES } = await import("./roles");
const service = await import("./server/service");

type CampaignRow = import("./types").CampaignRow;
const { revalidatePath } = await import("next/cache");

type Builder = ReturnType<typeof mocks.makeBuilder>;

const AUTH_USER = { id: "user-1" };
const OWN_BUSINESS = "biz-1";
const OTHER_BUSINESS = "biz-2";
const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const REWARD_ID = "33333333-3333-4333-8333-333333333333";

const BUSINESS_ROW = { id: OWN_BUSINESS, slug: "kape-diaria", name: "Kape Diaria", status: "active" };

// Only the columns describeCampaign and the guards read. Cast because the
// generated CampaignRow carries a dozen columns none of this logic touches, and
// spelling them out would obscure which ones the assertions are about.
function campaignRow(overrides: Record<string, unknown> = {}): CampaignRow {
  return {
    id: CAMPAIGN_ID,
    business_id: OWN_BUSINESS,
    type: "reward",
    status: "active",
    name: "Free Drink Friday",
    description: null,
    starts_at: null,
    ends_at: null,
    ...overrides,
  } as unknown as CampaignRow;
}

function rewardRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REWARD_ID,
    business_id: OWN_BUSINESS,
    campaign_id: CAMPAIGN_ID,
    name: "Free iced coffee",
    description: null,
    points_cost: 100,
    claim_kind: "points",
    total_inventory: 50,
    remaining: 40,
    per_customer_limit: 1,
    claim_expiry_days: 30,
    terms: null,
    is_active: true,
    created_at: "2026-07-01T00:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

const VALID_INPUT = {
  campaignId: CAMPAIGN_ID,
  name: "Free iced coffee",
  pointsCost: 100,
  totalInventory: 50,
  perCustomerLimit: 1,
  claimExpiryDays: 30,
};

let builders: Record<string, Builder>;

/**
 * The fake builder stores its methods as `unknown`, so reading a recorded call
 * argument needs one narrowing step. Kept in a helper so the assertions below
 * stay about the patch, not about the mock's typing.
 */
function firstCallArg(builder: Builder, method: string): Record<string, unknown> {
  const fn = builder[method] as { mock: { calls: unknown[][] } };
  return (fn.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

function table(name: string): Builder {
  const b = builders[name];
  if (!b) throw new Error(`no mock builder registered for table "${name}"`);
  return b;
}

function mockAuthed() {
  mocks.getUser.mockResolvedValue({ data: { user: AUTH_USER } });
}

/** A base earning rule exists, so a points-priced reward is reachable. */
function mockBaseRuleExists() {
  table("points_rules").__result = { data: { id: "rule-1", kind: "base" }, error: null };
}

function mockNoBaseRule() {
  table("points_rules").__result = { data: null, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();

  builders = {
    business_staff: mocks.makeBuilder(),
    businesses: mocks.makeBuilder(),
    campaigns: mocks.makeBuilder(),
    rewards: mocks.makeBuilder(),
    points_rules: mocks.makeBuilder(),
  };
  table("business_staff").__result = { data: { business_id: OWN_BUSINESS, role: "owner" }, error: null };
  table("businesses").__result = { data: BUSINESS_ROW, error: null };
  table("campaigns").__result = { data: campaignRow(), error: null };
  mockBaseRuleExists();

  mocks.from.mockImplementation((name: string) => table(name));
  mockAuthed();
});

// ---------------------------------------------------------------- pure logic

describe("describeCampaign: claim_reward's campaign guard, restated", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");

  it("an active campaign inside its window is claimable and not terminal", () => {
    const described = service.describeCampaign(
      campaignRow({ starts_at: "2026-07-01T00:00:00.000Z", ends_at: "2026-08-01T00:00:00.000Z" }),
      now,
    );
    expect(described.claimable).toBe(true);
    expect(described.terminal).toBe(false);
  });

  it("a draft campaign is not claimable yet, but is not terminal either", () => {
    const described = service.describeCampaign(campaignRow({ status: "draft" }), now);
    expect(described.claimable).toBe(false);
    expect(described.terminal).toBe(false);
  });

  it.each(["ended", "archived"])("a %s campaign is terminal", (status) => {
    expect(service.describeCampaign(campaignRow({ status }), now).terminal).toBe(true);
  });

  it("a campaign whose window has closed is terminal even while status says active", () => {
    const described = service.describeCampaign(
      campaignRow({ ends_at: "2026-07-01T00:00:00.000Z" }),
      now,
    );
    expect(described.claimable).toBe(false);
    expect(described.terminal).toBe(true);
  });
});

describe("nextRemaining: inventory edits keep remaining <= total and >= 0", () => {
  it("moving to unlimited clears remaining", () => {
    expect(service.nextRemaining({ total_inventory: 50, remaining: 10 }, null)).toEqual({
      ok: true,
      remaining: null,
    });
  });

  it("moving from unlimited to a number seeds remaining at that number", () => {
    expect(service.nextRemaining({ total_inventory: null, remaining: null }, 25)).toEqual({
      ok: true,
      remaining: 25,
    });
  });

  it("raising stock adds the difference rather than resetting it", () => {
    // 50 total, 40 left => 10 already claimed. New total 80 => 70 left.
    expect(service.nextRemaining({ total_inventory: 50, remaining: 40 }, 80)).toEqual({
      ok: true,
      remaining: 70,
    });
  });

  it("refuses a total below what customers have already claimed", () => {
    expect(service.nextRemaining({ total_inventory: 50, remaining: 40 }, 5)).toEqual({
      ok: false,
      alreadyClaimed: 10,
    });
  });
});

// ------------------------------------------------------------- role gating

describe("actions: role gating", () => {
  it("refuses a caller with no session and touches nothing", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const result = await actions.createReward(VALID_INPUT);

    expect(result.ok).toBe(false);
    expect(table("rewards").insert).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses an active member whose role is not owner/manager/marketing", async () => {
    // resolveStaffContext filters on role in the query, so a `staff` member's
    // membership row simply does not come back.
    table("business_staff").__result = { data: null, error: null };

    const result = await actions.createReward(VALID_INPUT);

    expect(result.ok).toBe(false);
    expect(table("rewards").insert).not.toHaveBeenCalled();
  });

  it("asks the database for the three roles doc 01 allows, and no others", async () => {
    await actions.createReward(VALID_INPUT);

    expect(table("business_staff").in).toHaveBeenCalledWith("role", [
      "owner",
      "manager",
      "marketing",
    ]);
    expect(REWARD_CATALOG_ROLES).toEqual(["owner", "manager", "marketing"]);
  });
});

// ----------------------------------------------------------------- tenancy

describe("tenancy", () => {
  it("scopes the campaign lookup and the insert to the business resolved from business_staff", async () => {
    const result = await actions.createReward(VALID_INPUT);

    expect(result.ok).toBe(true);
    expect(table("campaigns").eq).toHaveBeenCalledWith("business_id", OWN_BUSINESS);
    const inserted = firstCallArg(table("rewards"), "insert");
    expect(inserted.business_id).toBe(OWN_BUSINESS);
  });

  it("ignores a business id smuggled in with the form payload", async () => {
    await actions.createReward({ ...VALID_INPUT, businessId: OTHER_BUSINESS });

    const inserted = firstCallArg(table("rewards"), "insert");
    expect(inserted.business_id).toBe(OWN_BUSINESS);
    expect(table("campaigns").eq).not.toHaveBeenCalledWith("business_id", OTHER_BUSINESS);
  });

  it("refuses a campaign that does not resolve inside the caller's tenant", async () => {
    table("campaigns").__result = { data: null, error: null };

    const result = await actions.createReward({ ...VALID_INPUT, campaignId: OTHER_CAMPAIGN_ID });

    expect(result).toEqual({ ok: false, message: "That campaign is not one of yours." });
    expect(table("rewards").insert).not.toHaveBeenCalled();
  });

  it("scopes every reward update by id AND business_id", async () => {
    table("rewards").maybeSingle = vi.fn(async () => ({ data: rewardRow(), error: null }));
    table("rewards").single = vi.fn(async () => ({ data: rewardRow(), error: null }));

    await actions.updateReward({ rewardId: REWARD_ID, ...VALID_INPUT, campaignId: undefined });

    expect(table("rewards").eq).toHaveBeenCalledWith("business_id", OWN_BUSINESS);
  });
});

// ------------------------------------- refusing what claim_reward always refuses

describe("the form cannot create a reward claim_reward would always refuse", () => {
  it("refuses stock of zero, which is REWARD_OUT_OF_STOCK from birth", async () => {
    const result = await actions.createReward({ ...VALID_INPUT, totalInventory: 0 });

    expect(result.ok).toBe(false);
    expect(table("rewards").insert).not.toHaveBeenCalled();
  });

  it("accepts a blank inventory as unlimited, and seeds remaining as null", async () => {
    const result = await actions.createReward({ ...VALID_INPUT, totalInventory: null });

    expect(result.ok).toBe(true);
    const inserted = firstCallArg(table("rewards"), "insert");
    expect(inserted.total_inventory).toBeNull();
    expect(inserted.remaining).toBeNull();
  });

  it("seeds remaining from total_inventory so the RPC's decrement has stock to take", async () => {
    await actions.createReward(VALID_INPUT);

    const inserted = firstCallArg(table("rewards"), "insert");
    expect(inserted.remaining).toBe(50);
    expect(inserted.total_inventory).toBe(50);
  });

  it("refuses a per-customer limit of zero, which is REWARD_LIMIT_REACHED on attempt one", async () => {
    const result = await actions.createReward({ ...VALID_INPUT, perCustomerLimit: 0 });

    expect(result.ok).toBe(false);
    expect(table("rewards").insert).not.toHaveBeenCalled();
  });

  it("refuses a claim expiry outside the 1-365 day check constraint", async () => {
    expect((await actions.createReward({ ...VALID_INPUT, claimExpiryDays: 0 })).ok).toBe(false);
    expect((await actions.createReward({ ...VALID_INPUT, claimExpiryDays: 400 })).ok).toBe(false);
    expect(table("rewards").insert).not.toHaveBeenCalled();
  });

  it("refuses a points cost above the largest balance an integer column can hold", async () => {
    const result = await actions.createReward({ ...VALID_INPUT, pointsCost: 2_147_483_648 });

    expect(result.ok).toBe(false);
    expect(table("rewards").insert).not.toHaveBeenCalled();
  });

  it("refuses a points cost when the business has no earning rule, so nobody can reach it", async () => {
    mockNoBaseRule();

    const result = await actions.createReward(VALID_INPUT);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("earning rule");
    expect(table("rewards").insert).not.toHaveBeenCalled();
  });

  it("still allows a FREE reward when there is no earning rule: zero points is always reachable", async () => {
    mockNoBaseRule();

    const result = await actions.createReward({ ...VALID_INPUT, pointsCost: 0 });

    expect(result.ok).toBe(true);
    expect(table("rewards").insert).toHaveBeenCalled();
  });

  it.each(["ended", "archived"])(
    "refuses a reward parented to a %s campaign, which can never be claimable again",
    async (status) => {
      table("campaigns").__result = { data: campaignRow({ status }), error: null };

      const result = await actions.createReward(VALID_INPUT);

      expect(result.ok).toBe(false);
      expect(table("rewards").insert).not.toHaveBeenCalled();
    },
  );

  it("allows a draft campaign as a parent: it can still be activated later", async () => {
    table("campaigns").__result = { data: campaignRow({ status: "draft" }), error: null };

    const result = await actions.createReward(VALID_INPUT);

    expect(result.ok).toBe(true);
  });

  it("refuses an edit that drops stock below what has already been claimed", async () => {
    table("rewards").maybeSingle = vi.fn(async () => ({
      data: rewardRow({ total_inventory: 50, remaining: 40 }),
      error: null,
    }));

    const result = await actions.updateReward({
      rewardId: REWARD_ID,
      name: "Free iced coffee",
      pointsCost: 100,
      totalInventory: 5,
      perCustomerLimit: 1,
      claimExpiryDays: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("10");
    expect(table("rewards").update).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------- writes

describe("writes", () => {
  it("createReward revalidates the rewards route on success", async () => {
    table("rewards").single = vi.fn(async () => ({ data: rewardRow(), error: null }));

    const result = await actions.createReward(VALID_INPUT);

    expect(result.ok).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith("/business/rewards");
  });

  it("updateReward writes the recomputed remaining, not the raw total", async () => {
    table("rewards").maybeSingle = vi.fn(async () => ({
      data: rewardRow({ total_inventory: 50, remaining: 40 }),
      error: null,
    }));
    table("rewards").single = vi.fn(async () => ({ data: rewardRow(), error: null }));

    await actions.updateReward({
      rewardId: REWARD_ID,
      name: "Free iced coffee",
      pointsCost: 100,
      totalInventory: 80,
      perCustomerLimit: 1,
      claimExpiryDays: 30,
    });

    const patch = firstCallArg(table("rewards"), "update");
    expect(patch.total_inventory).toBe(80);
    expect(patch.remaining).toBe(70);
  });

  it("setRewardActive toggles is_active and nothing else", async () => {
    table("rewards").single = vi.fn(async () => ({ data: rewardRow({ is_active: false }), error: null }));

    const result = await actions.setRewardActive({ rewardId: REWARD_ID, isActive: false });

    expect(result.ok).toBe(true);
    expect(table("rewards").update).toHaveBeenCalledWith({ is_active: false });
  });
});

// -------------------------------------------------------------------- reads

describe("loadCatalog", () => {
  it("reports a read failure rather than an empty catalog", async () => {
    table("rewards").__result = { data: null, error: { message: "boom" } };

    const result = await service.loadCatalog(OWN_BUSINESS);

    expect(result.ok).toBe(false);
  });

  it("distinguishes a genuinely empty catalog from a failed read", async () => {
    table("rewards").__result = { data: [], error: null };
    table("campaigns").__result = { data: [], error: null };

    const result = await service.loadCatalog(OWN_BUSINESS);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.rewards).toEqual([]);
  });

  it("attaches each reward's campaign and scopes both reads to the tenant", async () => {
    table("rewards").__result = { data: [rewardRow()], error: null };
    table("campaigns").__result = { data: [campaignRow()], error: null };

    const result = await service.loadCatalog(OWN_BUSINESS);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.rewards[0]?.campaign?.name).toBe("Free Drink Friday");
    expect(table("rewards").eq).toHaveBeenCalledWith("business_id", OWN_BUSINESS);
    expect(table("campaigns").eq).toHaveBeenCalledWith("business_id", OWN_BUSINESS);
  });

  // The catalog screen states what each points cost implies in spend
  // (../economics.ts), which it cannot do without the active base rule.
  it("carries the active earning rule, reduced to what the spend sentence reads", async () => {
    table("rewards").__result = { data: [], error: null };
    table("campaigns").__result = { data: [], error: null };
    table("points_rules").__result = {
      data: {
        id: "rule-1",
        kind: "base",
        rule_type: "amount_rate",
        rate_centavos_per_point: 50,
        fixed_points: null,
        rounding: "floor",
        tiers: null,
        conditions: {},
      },
      error: null,
    };

    const result = await service.loadCatalog(OWN_BUSINESS);

    expect(result.ok && result.data?.earningRule).toEqual({
      ruleType: "amount_rate",
      rateCentavosPerPoint: 50,
      fixedPoints: null,
      rounding: "floor",
      hasTiers: false,
      gated: false,
    });
    expect(table("points_rules").eq).toHaveBeenCalledWith("business_id", OWN_BUSINESS);
  });

  it("reads a missing earning rule as null, not as a failed catalog", async () => {
    table("rewards").__result = { data: [rewardRow()], error: null };
    table("campaigns").__result = { data: [campaignRow()], error: null };
    mockNoBaseRule();

    const result = await service.loadCatalog(OWN_BUSINESS);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.earningRule).toBeNull();
    expect(result.ok && result.data?.rewards).toHaveLength(1);
  });
});
