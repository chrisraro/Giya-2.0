import { Card } from "@/components/ui/card";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";
import type { MockBalance } from "@/lib/mock/consumer";

/**
 * Horizontal scroll-snap row of per-business stamp progress cards.
 * Mango (tertiary) is reserved for the stamp row: it's the reward figure here.
 */
export function LoyaltyStrip({ balances }: { balances: MockBalance[] }) {
  return (
    <div
      className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
      style={{ scrollbarWidth: "none" }}
    >
      {balances.map((balance) => (
        <Card
          key={balance.businessId}
          variant="elevated"
          className="w-[240px] shrink-0 snap-start p-4"
        >
          <p className="truncate text-title-s text-on-surface">{balance.businessName}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1 text-tertiary">
            {Array.from({ length: balance.stampsTarget }).map((_, i) => (
              <Logo
                key={i}
                variant="stamp"
                className={cn("size-5", i >= balance.stampsEarned && "opacity-25")}
              />
            ))}
          </div>
          <p className="mt-2 text-label-m text-on-surface-variant">
            {balance.stampsEarned} of {balance.stampsTarget}
          </p>
          <p className="mt-1 text-body-s text-on-surface-variant">Next: {balance.nextReward}</p>
        </Card>
      ))}
    </div>
  );
}
