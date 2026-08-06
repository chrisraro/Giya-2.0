import { ClaimList } from "@/features/rewards/components/claim-list";
import { RewardCard } from "@/features/rewards/components/reward-card";
import { RewardProgress } from "@/features/rewards/components/reward-progress";
import { groupRewardsByBusiness } from "@/features/rewards/reward-groups";
import { getMyBalances, listClaimableRewards, listMyClaims } from "@/features/rewards/server/repo";
import { EmptyState } from "@/components/consumer/empty-state";

// Three RLS-scoped reads, all safe to run concurrently (none depends on
// another's result): listMyClaims and getMyBalances are scoped to the
// signed-in consumer, listClaimableRewards is the public catalog. Rendered
// per-request so a fresh claim - via revalidatePath("/rewards") in
// actions.ts's claimReward - always shows up immediately.
export const dynamic = "force-dynamic";

export default async function RewardsPage() {
  const [available, claimed, balances] = await Promise.all([
    listClaimableRewards(),
    listMyClaims(),
    getMyBalances(),
  ]);

  // Doc 03's Key Finding 3: the catalogue used to render an unaffordable
  // reward identically to an affordable one. Grouping by business joins each
  // reward to the balance that actually decides whether it is affordable -
  // a global "total points" figure would be meaningless across businesses
  // that do not share a ledger.
  const groups = groupRewardsByBusiness(available, balances);

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <h1 className="text-headline-m text-on-surface">Rewards</h1>

      <section className="mt-6">
        <h2 className="text-title-m text-on-surface">Available</h2>
        {groups.length === 0 ? (
          <EmptyState
            icon="loyalty"
            title="No rewards yet"
            body="Check back soon - businesses you follow will post rewards here."
            className="mt-3"
          />
        ) : (
          <div className="mt-3 flex flex-col gap-6">
            {groups.map((group) => (
              <div key={group.businessId}>
                {/* Omitted, not an empty heading, when the businesses lookup
                    missed (mirrors RewardCard's analogous slug-empty guard):
                    a heading with no accessible name is worse than none. */}
                {group.businessName ? (
                  <h3 className="text-title-s text-on-surface">{group.businessName}</h3>
                ) : null}
                {group.progress ? (
                  <RewardProgress
                    current={group.progress.current}
                    target={group.progress.target}
                    rewardName={group.progress.rewardName}
                    className="mt-2"
                  />
                ) : null}
                <div className="mt-3 grid grid-cols-2 gap-3">
                  {group.rewards.map((reward) => (
                    <RewardCard
                      key={reward.rewardId}
                      reward={reward}
                      affordability={group.affordabilityByRewardId.get(reward.rewardId)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-title-m text-on-surface">Claimed</h2>
        <div className="mt-3">
          <ClaimList claims={claimed} />
        </div>
      </section>
    </main>
  );
}
