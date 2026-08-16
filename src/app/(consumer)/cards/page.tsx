import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/consumer/empty-state";
import { progressUnitLabel } from "@/features/loyalty/display";
import { listMyLoyaltyCards } from "@/features/loyalty/server/repo";

export const dynamic = "force-dynamic";

export default async function CardsPage() {
  const cards = await listMyLoyaltyCards();

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-24">
      <header className="mb-6">
        <h1 className="text-headline-s text-on-surface">Loyalty Stamp Cards</h1>
        <p className="mt-1 text-body-s text-on-surface-variant">
          Collect stamps on every visit to unlock free prizes.
        </p>
      </header>

      {cards.length === 0 ? (
        <EmptyState
          icon="verified"
          title="No stamp cards yet"
          body="Scan receipts at participating shops to start collecting stamps."
          action={{ label: "Discover shops", href: "/discover" }}
          className="mt-6"
        />
      ) : (
        <div className="space-y-4">
          {cards.map((card) => {
            const pct = Math.min(100, Math.round((card.stampsCount / card.stampsTarget) * 100));
            const unit = progressUnitLabel(card.programType);

            return (
              <Link key={card.id} href={`/cards/${card.id}`}>
                <Card variant="outlined" className="p-4 hover:border-primary transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-title-m font-bold text-on-surface">{card.businessName}</h2>
                      <p className="text-body-s text-on-surface-variant">
                        Prize: {card.prizeRewardName}
                      </p>
                      {card.completedCount > 0 ? (
                        <p className="mt-0.5 text-label-s text-on-surface-variant">
                          {card.completedCount === 1
                            ? "Completed once"
                            : `Completed ${card.completedCount} times`}
                        </p>
                      ) : null}
                    </div>
                    <Badge
                      className={
                        card.isCompleted
                          ? "bg-primary text-on-primary"
                          : "bg-surface-variant text-on-surface-variant"
                      }
                    >
                      {card.isCompleted
                        ? "COMPLETED"
                        : `${card.stampsCount} / ${card.stampsTarget} ${unit}`}
                    </Badge>
                  </div>

                  {/* Progress bar */}
                  <div className="mt-4">
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-variant">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
