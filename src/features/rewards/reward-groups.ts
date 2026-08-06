import { affordability, type ProgressAnchor, type RewardAffordability } from "./affordability";
import type { BalanceDTO, ClaimableRewardDTO } from "./types";

// `/rewards` shows the consumer's whole catalogue across every business they
// have earned at, but affordability and the progress anchor are per-business
// facts (doc 03's Key Finding 3: never anchor progress to the catalogue
// maximum). This groups the flat `listClaimableRewards()` result by
// `businessId` and joins each group to that business's own balance from
// `getMyBalances()`, so the page only has to render one group at a time.

export interface BusinessRewardGroup {
  readonly businessId: string;
  readonly businessName: string;
  readonly businessSlug: string;
  /** The caller's points_balance at this business; 0 when they have no
   * business_customers row here yet (never earned, so no relationship row
   * exists) - same default doc 03 asks for: most users spend most of their
   * time unable to afford anything, and that is still worth rendering. */
  readonly balance: number;
  readonly rewards: readonly ClaimableRewardDTO[];
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
    const balance = balanceByBusinessId.get(businessId) ?? 0;
    const { rewards: results, progress } = affordability(
      balance,
      businessRewards.map((r) => ({ rewardId: r.rewardId, name: r.name, pointsCost: r.pointsCost })),
    );

    return {
      businessId,
      businessName: first?.businessName ?? "",
      businessSlug: first?.businessSlug ?? "",
      balance,
      rewards: businessRewards,
      affordabilityByRewardId: new Map(results.map((r) => [r.rewardId, r])),
      progress,
    };
  });
}
