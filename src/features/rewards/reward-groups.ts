import { affordability, type ProgressAnchor, type RewardAffordability } from "./affordability";
import type { BalanceDTO, ClaimableRewardDTO } from "./types";

// `/rewards` shows the consumer's whole catalogue across every business they
// have earned at, but affordability and the progress anchor are per-business
// facts (doc 03's Key Finding 3: never anchor progress to the catalogue
// maximum). This groups the flat `listClaimableRewards()` result by
// `businessId` and joins each group to that business's own balance from
// `getMyBalances()`, so the page only has to render one group at a time.
//
// `listClaimableRewards()` is the WHOLE public catalogue, not just businesses
// the consumer has a relationship with. Without the `hasBalance` gate below,
// a brand-new consumer with zero `business_customers` rows would see every
// business's catalogue greyed out with a 0%-progress rail - precisely the
// demotivating wall doc 03's anchoring rule exists to prevent. So affordability
// (grey + shortfall + progress) only applies when the consumer actually HAS a
// balance row at that business, even if its value is 0 (spent everything - a
// real, different state from "never visited"). A business they have never
// earned at still shows its full catalogue (never hidden), just with no grey
// and no rail: there is no progress to show someone who hasn't started.

export interface BusinessRewardGroup {
  readonly businessId: string;
  readonly businessName: string;
  readonly businessSlug: string;
  /** The caller's points_balance at this business. Only meaningful when
   * `hasBalance` is true; 0 otherwise (informational, not used to grey
   * anything). */
  readonly balance: number;
  /** True only when the caller has a real `business_customers` row at this
   * business. Gates whether affordability is even computed - see the file
   * doc above. */
  readonly hasBalance: boolean;
  readonly rewards: readonly ClaimableRewardDTO[];
  /** Empty when `hasBalance` is false: there is deliberately no affordability
   * fact for any reward in that case, and RewardCard's default for an
   * omitted lookup (`.get()` returning undefined) is exactly "render as
   * affordable", the same as this business's catalogue looked before this
   * task. */
  readonly affordabilityByRewardId: ReadonlyMap<string, RewardAffordability>;
  readonly progress: ProgressAnchor | null;
}

export function groupRewardsByBusiness(
  rewards: readonly ClaimableRewardDTO[],
  balances: readonly BalanceDTO[],
): BusinessRewardGroup[] {
  const balanceByBusinessId = new Map(balances.map((b) => [b.businessId, b.pointsBalance]));

  const order: string[] = [];
  const rewardsByBusiness = new Map<string, ClaimableRewardDTO[]>();
  for (const reward of rewards) {
    const bucket = rewardsByBusiness.get(reward.businessId);
    if (bucket) {
      bucket.push(reward);
    } else {
      order.push(reward.businessId);
      rewardsByBusiness.set(reward.businessId, [reward]);
    }
  }

  return order.map((businessId) => {
    const businessRewards = rewardsByBusiness.get(businessId) ?? [];
    const first = businessRewards[0];
    const hasBalance = balanceByBusinessId.has(businessId);
    const balance = balanceByBusinessId.get(businessId) ?? 0;

    const { rewards: results, progress } = hasBalance
      ? affordability(
          balance,
          businessRewards.map((r) => ({ rewardId: r.rewardId, name: r.name, pointsCost: r.pointsCost })),
        )
      : { rewards: [], progress: null };

    return {
      businessId,
      businessName: first?.businessName ?? "",
      businessSlug: first?.businessSlug ?? "",
      balance,
      hasBalance,
      rewards: businessRewards,
      affordabilityByRewardId: new Map(results.map((r) => [r.rewardId, r])),
      progress,
    };
  });
}
