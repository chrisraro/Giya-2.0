// Pure presenter for "can the caller actually afford this reward?" - doc
// 03's Key Finding 3. `/rewards` and `/b/[slug]` both call this with a
// consumer's real balance at ONE business and that business's reward list;
// neither page nor component does the arithmetic itself, so the one place
// this logic can be wrong is this file, and it is exhaustively unit-tested
// here rather than through a rendered component.
//
// Deliberately typed against a minimal shape (`rewardId`/`name`/`pointsCost`)
// rather than `ClaimableRewardDTO` or `PublicReward` directly: `/rewards`
// groups the full consumer catalogue by business, `/b/[slug]` has its own
// narrower public reward shape, and this function should not care which DTO
// a caller happens to have.

export interface AffordabilityInput {
  readonly rewardId: string;
  readonly name: string;
  readonly pointsCost: number;
}

export interface RewardAffordability {
  readonly rewardId: string;
  readonly affordable: boolean;
  /** 0 when affordable; otherwise the points still needed to reach pointsCost. */
  readonly shortfall: number;
}

export interface ProgressAnchor {
  readonly rewardId: string;
  readonly rewardName: string;
  readonly current: number;
  readonly target: number;
}

export interface AffordabilityResult {
  readonly rewards: readonly RewardAffordability[];
  /**
   * Anchored to the CHEAPEST reward the caller cannot yet afford - never the
   * catalogue maximum. McDonald's anchors its progress rail to the top tier,
   * so a consumer with 278 of 6,000 points sees a 4% bar; it was publicly
   * mocked (doc 03, Key Finding 3). Null when every reward is already
   * affordable, or there are no rewards to anchor to at all.
   */
  readonly progress: ProgressAnchor | null;
}

/**
 * balance >= pointsCost is affordable (the boundary case: a reward costing
 * exactly the caller's balance is affordable, not "1 point of shortfall").
 */
export function affordability(
  balance: number,
  rewards: readonly AffordabilityInput[],
): AffordabilityResult {
  const results: RewardAffordability[] = rewards.map((reward) => {
    const affordable = balance >= reward.pointsCost;
    return {
      rewardId: reward.rewardId,
      affordable,
      shortfall: affordable ? 0 : reward.pointsCost - balance,
    };
  });

  let cheapestUnaffordable: AffordabilityInput | null = null;
  for (const reward of rewards) {
    if (balance >= reward.pointsCost) continue;
    if (cheapestUnaffordable === null || reward.pointsCost < cheapestUnaffordable.pointsCost) {
      cheapestUnaffordable = reward;
    }
  }

  return {
    rewards: results,
    progress:
      cheapestUnaffordable === null
        ? null
        : {
            rewardId: cheapestUnaffordable.rewardId,
            rewardName: cheapestUnaffordable.name,
            current: balance,
            target: cheapestUnaffordable.pointsCost,
          },
  };
}
