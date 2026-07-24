import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/consumer/empty-state";
import { MOCK_REWARDS } from "@/lib/mock/consumer"; // TODO(api): replace mock

export default function RewardsPage() {
  // TODO(api): replace mock — fetch available and claimed rewards from the API
  const available = MOCK_REWARDS.filter((reward) => reward.status === "available");
  const claimed = MOCK_REWARDS.filter((reward) => reward.status === "claimed");

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <h1 className="text-headline-m text-on-surface">Rewards</h1>

      <section className="mt-6">
        <h2 className="text-title-m text-on-surface">Available</h2>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {available.map((reward) => (
            <Card key={reward.id} variant="filled" className="flex flex-col gap-2 p-4">
              <p className="text-title-s text-on-surface">{reward.name}</p>
              <p className="text-body-s text-on-surface-variant">{reward.businessName}</p>
              <Badge className="w-fit">{reward.pointsCost} pts</Badge>
              <Button variant="tonal" size="touch" disabled className="mt-1 w-full">
                Claim
              </Button>
              <p className="text-label-s text-on-surface-variant">Claiming opens after launch</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-title-m text-on-surface">Claimed</h2>
        {claimed.length === 0 ? (
          <EmptyState
            icon="redeem"
            title="Nothing claimed yet"
            body="Rewards you claim will appear here with their QR codes."
            className="mt-3"
          />
        ) : (
          <div className="mt-3 space-y-2">
            {claimed.map((reward) => (
              <Card
                key={reward.id}
                variant="outlined"
                className="flex items-center justify-between gap-3 p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-title-s text-on-surface">{reward.name}</p>
                  <p className="text-body-s text-on-surface-variant">{reward.businessName}</p>
                </div>
                <Badge>{reward.pointsCost} pts</Badge>
              </Card>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
