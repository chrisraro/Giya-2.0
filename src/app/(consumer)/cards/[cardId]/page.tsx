import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getLoyaltyCard } from "@/features/loyalty/server/repo";

export const dynamic = "force-dynamic";

export default async function CardDetailPage({
  params,
}: {
  params: Promise<{ cardId: string }>;
}) {
  const { cardId } = await params;
  const card = await getLoyaltyCard(cardId);

  if (!card) notFound();

  const stampSlots = Array.from({ length: card.stampsTarget }, (_, i) => i < card.stampsCount);

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-24">
      <header className="mb-6">
        <Link
          href="/cards"
          className="inline-flex items-center gap-1 text-label-s text-primary hover:underline mb-2"
        >
          <span aria-hidden className="material-symbols-rounded text-sm">
            arrow_back
          </span>
          Back to Cards
        </Link>
        <div className="flex items-center justify-between">
          <h1 className="text-headline-s text-on-surface">{card.businessName}</h1>
          <Badge
            className={
              card.isCompleted
                ? "bg-primary text-on-primary"
                : "bg-surface-variant text-on-surface-variant"
            }
          >
            {card.isCompleted ? "COMPLETED" : `${card.stampsCount} / ${card.stampsTarget}`}
          </Badge>
        </div>
        <p className="mt-1 text-body-s text-on-surface-variant">
          Prize: <strong className="text-on-surface">{card.prizeRewardName}</strong>
        </p>
      </header>

      {/* Visual Stamp Card Grid */}
      <Card variant="filled" className="p-6 bg-surface-container border border-outline-variant">
        <div className="text-center mb-6">
          <h2 className="text-title-m font-bold text-on-surface">
            {card.stampsCount} / {card.stampsTarget} Stamps Collected
          </h2>
          <p className="text-label-s text-on-surface-variant mt-0.5">
            {card.isCompleted
              ? "Congratulations! Your prize is ready."
              : `Collect ${card.stampsTarget - card.stampsCount} more stamps to complete!`}
          </p>
        </div>

        <div className="grid grid-cols-5 gap-3">
          {stampSlots.map((isStamped, idx) => (
            <div
              key={idx}
              className={`aspect-square flex items-center justify-center rounded-full border-2 transition-all ${
                isStamped
                  ? "border-primary bg-primary text-on-primary shadow-sm"
                  : "border-dashed border-outline-variant bg-surface text-on-surface-variant/40"
              }`}
            >
              <span aria-hidden className="material-symbols-rounded text-2xl font-bold">
                {isStamped ? "verified" : "local_offer"}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </main>
  );
}
