import { describe, expect, it } from "vitest";

import { groupRewardsByBusiness } from "./reward-groups";
import type { BalanceDTO } from "./types";
import type { ClaimableRewardDTO } from "./types";

// ===========================================================================
// The page-level half of doc 03's Key Finding 3 fix: `/rewards` shows every
// business's catalogue, but the progress anchor and the affordability of
// each card are scoped to ONE business's balance, not a global total. This
// is the pure function that groups the flat catalogue by business and joins
// each group to that business's own balance from `getMyBalances()`, so the
// page component only has to render its output.
//
// Task-5 review's product call: `listClaimableRewards()` is the WHOLE public
// catalogue, so a brand-new consumer with zero `business_customers` rows
// would otherwise see every business's rewards greyed with a 0%-progress
// rail - the exact demotivating wall the anchoring rule exists to prevent.
// The fix: affordability (grey + shortfall + progress) applies ONLY to a
// business where the consumer actually HAS a balance row (`hasBalance`),
// even if that balance happens to be 0 (spent it all - a real, different
// state from "never visited"). A business they have never earned at still
// shows its full catalogue (never hidden), just with no grey and no rail.
// ===========================================================================

function reward(overrides: Partial<ClaimableRewardDTO> = {}): ClaimableRewardDTO {
  return {
    rewardId: "r1",
    campaignId: "c1",
    name: "Free latte",
    description: null,
    pointsCost: 500,
    remaining: null,
    perCustomerLimit: 1,
    businessId: "biz-1",
    businessName: "Kape Diaria",
    businessSlug: "kape-diaria",
    ...overrides,
  };
}

function balance(overrides: Partial<BalanceDTO> = {}): BalanceDTO {
  return {
    businessId: "biz-1",
    businessName: "Kape Diaria",
    businessSlug: "kape-diaria",
    pointsBalance: 1000,
    lifetimePoints: 1000,
    ...overrides,
  };
}

describe("groupRewardsByBusiness", () => {
  it("returns no groups for an empty catalogue", () => {
    expect(groupRewardsByBusiness([], [])).toEqual([]);
  });

  it("groups rewards under their owning business, in first-seen order", () => {
    const rewards = [
      reward({ rewardId: "a", businessId: "biz-1", businessName: "Kape Diaria" }),
      reward({ rewardId: "b", businessId: "biz-2", businessName: "Milk Tea Co" }),
      reward({ rewardId: "c", businessId: "biz-1", businessName: "Kape Diaria" }),
    ];

    const groups = groupRewardsByBusiness(rewards, [balance()]);

    expect(groups.map((g) => g.businessId)).toEqual(["biz-1", "biz-2"]);
    expect(groups[0]?.rewards.map((r) => r.rewardId)).toEqual(["a", "c"]);
    expect(groups[1]?.rewards.map((r) => r.rewardId)).toEqual(["b"]);
  });

  it("joins each group to that business's own balance", () => {
    const rewards = [
      reward({ rewardId: "a", businessId: "biz-1", pointsCost: 500 }),
      reward({ rewardId: "b", businessId: "biz-2", pointsCost: 500 }),
    ];
    const balances = [
      balance({ businessId: "biz-1", pointsBalance: 1000 }),
      balance({ businessId: "biz-2", pointsBalance: 100 }),
    ];

    const groups = groupRewardsByBusiness(rewards, balances);

    expect(groups[0]?.balance).toBe(1000);
    expect(groups[0]?.affordabilityByRewardId.get("a")?.affordable).toBe(true);
    expect(groups[1]?.balance).toBe(100);
    expect(groups[1]?.affordabilityByRewardId.get("b")?.affordable).toBe(false);
  });

  it("carries the group's progress anchor from the affordability presenter", () => {
    const rewards = [
      reward({ rewardId: "cheap", businessId: "biz-1", name: "Iced tea", pointsCost: 900 }),
      reward({ rewardId: "expensive", businessId: "biz-1", name: "Combo", pointsCost: 6000 }),
    ];

    const groups = groupRewardsByBusiness(rewards, [balance({ businessId: "biz-1", pointsBalance: 850 })]);

    expect(groups[0]?.progress).toEqual({
      rewardId: "cheap",
      rewardName: "Iced tea",
      current: 850,
      target: 900,
    });
  });

  it("has no progress anchor for a group where everything is affordable", () => {
    const rewards = [reward({ rewardId: "a", businessId: "biz-1", pointsCost: 500 })];

    const groups = groupRewardsByBusiness(rewards, [balance({ businessId: "biz-1", pointsBalance: 5000 })]);

    expect(groups[0]?.progress).toBeNull();
  });

  describe("a business the consumer has never earned at (no business_customers row)", () => {
    it("marks hasBalance false and applies NO affordability treatment, even to a reward costing more than 0", () => {
      const rewards = [reward({ rewardId: "a", businessId: "biz-1", pointsCost: 500 })];

      const groups = groupRewardsByBusiness(rewards, []);

      expect(groups[0]?.hasBalance).toBe(false);
      // Not "unaffordable with a 500-point shortfall" - no row means no
      // affordability fact to render at all, so the map has nothing for it
      // and RewardCard's default (omitted affordability => affordable) applies.
      expect(groups[0]?.affordabilityByRewardId.get("a")).toBeUndefined();
    });

    it("has no progress anchor even though every reward is technically unaffordable at 0 points", () => {
      const rewards = [reward({ rewardId: "a", businessId: "biz-1", pointsCost: 500 })];

      const groups = groupRewardsByBusiness(rewards, []);

      expect(groups[0]?.progress).toBeNull();
    });

    it("still shows the full catalogue - the group is not hidden or dropped", () => {
      const rewards = [reward({ rewardId: "a", businessId: "biz-1", pointsCost: 500 })];

      const groups = groupRewardsByBusiness(rewards, []);

      expect(groups).toHaveLength(1);
      expect(groups[0]?.rewards.map((r) => r.rewardId)).toEqual(["a"]);
    });
  });

  it("marks hasBalance true and applies affordability even at a real balance of exactly 0", () => {
    // Distinct from "never visited": this consumer HAS a business_customers
    // row, they have just spent everything. That is a real, different state
    // and should still show the grey/shortfall/progress treatment.
    const rewards = [reward({ rewardId: "a", businessId: "biz-1", pointsCost: 500 })];

    const groups = groupRewardsByBusiness(rewards, [balance({ businessId: "biz-1", pointsBalance: 0 })]);

    expect(groups[0]?.hasBalance).toBe(true);
    expect(groups[0]?.affordabilityByRewardId.get("a")).toEqual({
      rewardId: "a",
      affordable: false,
      shortfall: 500,
    });
    expect(groups[0]?.progress).toEqual({
      rewardId: "a",
      rewardName: "Free latte",
      current: 0,
      target: 500,
    });
  });

  it("breaks a tie between two equally-priced unaffordable rewards by first-seen order", () => {
    const rewards = [
      reward({ rewardId: "first", businessId: "biz-1", name: "Iced tea", pointsCost: 900 }),
      reward({ rewardId: "second", businessId: "biz-1", name: "Milk tea", pointsCost: 900 }),
    ];

    const groups = groupRewardsByBusiness(rewards, [balance({ businessId: "biz-1", pointsBalance: 100 })]);

    expect(groups[0]?.progress?.rewardId).toBe("first");
  });

  it("ignores a balance entry for a business absent from the reward catalogue", () => {
    const rewards = [reward({ rewardId: "a", businessId: "biz-1", pointsCost: 500 })];
    const balances = [
      balance({ businessId: "biz-1", pointsBalance: 1000 }),
      balance({ businessId: "biz-99", businessName: "Never Rendered Co", pointsBalance: 50 }),
    ];

    const groups = groupRewardsByBusiness(rewards, balances);

    expect(groups).toHaveLength(1);
    expect(groups.map((g) => g.businessId)).toEqual(["biz-1"]);
  });
});
