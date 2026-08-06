import { describe, expect, it } from "vitest";

import { groupRewardsByBusiness } from "./reward-groups";
import type { BalanceDTO } from "./types";
import type { ClaimableRewardDTO } from "./types";

// ===========================================================================
// The page-level half of doc 03's Key Finding 3 fix: `/rewards` shows every
// business's catalogue, but the progress anchor and the affordability of
// each card are scoped to ONE business's balance, not a global total. This
// is the pure function that groups the flat catalogue by business and joins
// each group to that business's own balance (defaulting to 0 when the
// caller has no business_customers row there yet) - unit-tested here so the
// page component only has to render its output.
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

  it("defaults balance to 0 when the caller has no business_customers row at this business", () => {
    const rewards = [reward({ rewardId: "a", businessId: "biz-1", pointsCost: 500 })];

    const groups = groupRewardsByBusiness(rewards, []);

    expect(groups[0]?.balance).toBe(0);
    expect(groups[0]?.affordabilityByRewardId.get("a")).toEqual({
      rewardId: "a",
      affordable: false,
      shortfall: 500,
    });
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
});
