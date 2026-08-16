import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { isStampGridProgram, progressUnitLabel } from "@/features/loyalty/display";
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

  const unit = progressUnitLabel(card.programType);
  // Only count-based programs are drawn as slots. A points_target program
  // with a target of 500 is a progress bar, not 500 circles.
  const showGrid = isStampGridProgram(card.programType);
  const stampSlots = showGrid
    ? Array.from({ length: card.stampsTarget }, (_, i) => i < card.stampsCount)
    : [];
  // Math.min is load-bearing: decision (b) in 0078 completes a card once per
  // receipt and keeps the whole carryover, so a 350-point receipt against a
  // 100-point target leaves progress at 250 and the bar at 250%.
  const pct = Math.min(100, Math.round((card.stampsCount / card.stampsTarget) * 100));
  // No clamp on `remaining`: it renders only in the `!isCompleted` branch and
  // `isCompleted` IS `progress >= target`, so it cannot be negative here.
  const remaining = card.stampsTarget - card.stampsCount;
  const stampGlyph = card.stampIcon ?? "verified";

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
        <div className="flex items-center justify-between gap-3">
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
        {card.completedCount > 0 ? (
          <p className="mt-0.5 text-label-s text-on-surface-variant">
            {card.completedCount === 1
              ? "You have completed this card once."
              : `You have completed this card ${card.completedCount} times.`}
          </p>
        ) : null}
      </header>

      <Card variant="filled" className="p-6 bg-surface-container border border-outline-variant">
        <div className="text-center mb-6">
          <h2 className="text-title-m font-bold text-on-surface">
            {card.stampsCount} / {card.stampsTarget} {unit} collected
          </h2>
          <p className="text-label-s text-on-surface-variant mt-0.5">
            {card.isCompleted
              ? "Your prize is ready. Show this card at the counter."
              : `${remaining} more ${unit} to go.`}
          </p>
        </div>

        {showGrid ? (
          <div className="grid grid-cols-5 gap-3">
            {stampSlots.map((isStamped, idx) => (
              <div
                key={idx}
                data-testid="stamp-slot"
                className={`aspect-square flex items-center justify-center rounded-full border-2 transition-all ${
                  isStamped
                    ? "border-primary bg-primary text-on-primary shadow-sm"
                    : "border-dashed border-outline-variant bg-surface text-on-surface-variant/40"
                }`}
              >
                <span aria-hidden className="material-symbols-rounded text-2xl font-bold">
                  {isStamped ? stampGlyph : "local_offer"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="h-3 w-full overflow-hidden rounded-full bg-surface-variant"
            role="progressbar"
            aria-valuenow={card.stampsCount}
            aria-valuemin={0}
            aria-valuemax={card.stampsTarget}
            aria-label={`${unit} collected`}
          >
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </Card>
    </main>
  );
}
