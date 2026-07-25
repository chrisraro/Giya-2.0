import { ClaimList } from "@/features/rewards/components/claim-list";
import { RewardCard } from "@/features/rewards/components/reward-card";
import { listClaimableRewards, listMyClaims } from "@/features/rewards/server/repo";
import { EmptyState } from "@/components/consumer/empty-state";

// Both reads are RLS-scoped to the signed-in consumer (listMyClaims) or
// public (listClaimableRewards); rendered per-request so a fresh claim -
// via revalidatePath("/rewards") in actions.ts's claimReward - always shows
// up immediately.
export const dynamic = "force-dynamic";

export default async function RewardsPage() {
  const [available, claimed] = await Promise.all([listClaimableRewards(), listMyClaims()]);

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <h1 className="text-headline-m text-on-surface">Rewards</h1>

      <section className="mt-6">
        <h2 className="text-title-m text-on-surface">Available</h2>
        {available.length === 0 ? (
          <EmptyState
            icon="loyalty"
            title="No rewards yet"
            body="Check back soon - businesses you follow will post rewards here."
            className="mt-3"
          />
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {available.map((reward) => (
              <RewardCard key={reward.rewardId} reward={reward} />
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
