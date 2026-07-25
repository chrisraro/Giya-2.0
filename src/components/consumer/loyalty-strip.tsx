import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { Card } from "@/components/ui/card";
import type { BalanceDTO } from "@/features/rewards/types";
import { cn } from "@/lib/utils";

/**
 * Horizontal scroll-snap row of the consumer's real per-business balances, one
 * card per `business_customers` row, from the same `getMyBalances()` read that
 * /wallet renders. Mango (tertiary) carries the points figure: points are
 * reward language, which is what mango is reserved for.
 *
 * Stamp progress is not shown. The previous version drew "3 of 5" stamps from a
 * fixture, and there is no stamp card anywhere in the schema to draw them from:
 * `business_customers` tracks points_balance and lifetime_points, so those are
 * what the card states. The Giya stamp mark stays as the brand figure.
 *
 * Each card links to that business's public page, which is where a balance can
 * actually be acted on: `/b/[slug]` lists the shop's claimable rewards and
 * carries a "Scan receipt" CTA already bound to this business. /wallet is the
 * fallback for the one case where the slug is empty, which is a
 * business_customers row whose business is no longer publicly readable
 * (deactivated or soft-deleted) so `getMyBalances` could not resolve it. A
 * `/b/` link there would 404, and the ledger on /wallet is the honest place to
 * see what that balance is.
 */
export function LoyaltyStrip({ balances }: { balances: readonly BalanceDTO[] }) {
  return (
    <div
      className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
      style={{ scrollbarWidth: "none" }}
    >
      {balances.map((balance) => (
        <Link
          key={balance.businessId}
          href={balance.businessSlug ? `/b/${balance.businessSlug}` : "/wallet"}
          className="shrink-0 snap-start rounded-md3-md outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Card
            variant="elevated"
            className={cn(
              "w-[240px] p-4",
              "transition-colors duration-200 ease-standard hover:bg-surface-container",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-title-s text-on-surface">
                {balance.businessName || "This shop"}
              </p>
              {/* Wrapped rather than given aria-hidden directly: the stamp
                  variant carries its own role="img" and label, which would
                  otherwise be announced on every card in the row. */}
              <span aria-hidden className="shrink-0 text-tertiary">
                <Logo variant="stamp" className="size-6" />
              </span>
            </div>

            <p className="mt-3 font-mono text-headline-s text-tertiary">
              {balance.pointsBalance.toLocaleString()}
            </p>
            <p className="mt-0.5 text-label-m text-on-surface-variant">points to spend</p>
            <p className="mt-2 text-body-s text-on-surface-variant">
              {balance.lifetimePoints.toLocaleString()} earned here all time
            </p>
          </Card>
        </Link>
      ))}
    </div>
  );
}
