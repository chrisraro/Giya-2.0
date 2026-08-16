import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { PublicPromotion } from "../server/repo";

/**
 * HOW A PROMOTION IS REDEEMED, stated on every card.
 *
 * Doc 34's surface table settles this for both offer families it covers:
 * `promotion` [MVP] is "Card on business page + home 'Promos'; no in-app claim,
 * shown at counter", and `discount` [V1] is "Like promotion but rendered as an
 * explicit price cut; counter-honored". There is no claim button anywhere in
 * this app and none is planned for either, so the absence of one is a fact
 * about the platform, not an omission a merchant might fill in.
 *
 * It therefore does NOT live behind `redemptionHint`. That column is the
 * merchant's own detail ("mention the code", "dine-in only"), it is null on
 * most rows, and a consumer looking at one of those rows was previously told
 * nothing at all about how to use the offer they were being shown.
 *
 * Wording notes, both load-bearing:
 *  - No em-dash. The house rule bans them in consumer copy (see
 *    receipt-copy.test.ts and four other suites); doc 34's own phrasing uses
 *    one, so the sentence is restructured rather than transcribed.
 *  - It says what to do, not what the reader may not do. "You cannot claim
 *    this in the app" states the identical fact while blaming the consumer for
 *    having looked for the button.
 */
export const PROMOTION_COUNTER_CONTRACT =
  "No claim needed. Show this offer at the counter and the shop applies it.";

export function PromotionCard({ promotion }: { promotion: PublicPromotion }) {
  const getOfferBadgeText = () => {
    if (promotion.offerKind === "percent_off" && promotion.percentOff) {
      return `${promotion.percentOff}% OFF`;
    }
    if (promotion.offerKind === "amount_off" && promotion.amountOffCentavos) {
      return `₱${(promotion.amountOffCentavos / 100).toFixed(2)} OFF`;
    }
    if (promotion.offerKind === "freebie" && promotion.freebieText) {
      return `FREE: ${promotion.freebieText}`;
    }
    return "PROMO";
  };

  return (
    <div className="rounded-md3-md border border-outline-variant bg-surface p-4 text-on-surface">
      <div className="flex items-start justify-between gap-3">
        <div>
          {promotion.businessName && promotion.businessSlug ? (
            <Link
              href={`/b/${promotion.businessSlug}`}
              className="text-label-s text-primary hover:underline"
            >
              {promotion.businessName}
            </Link>
          ) : null}
          <h3 className="text-title-m font-semibold">{promotion.name}</h3>
        </div>
        <Badge className="shrink-0 bg-primary-container text-on-primary-container">
          {getOfferBadgeText()}
        </Badge>
      </div>

      {promotion.description ? (
        <p className="mt-1 text-body-s text-on-surface-variant">{promotion.description}</p>
      ) : null}

      {promotion.terms ? (
        <p className="mt-2 text-label-s text-on-surface-variant/80">
          Terms: {promotion.terms}
        </p>
      ) : null}

      {/* Unconditional. See PROMOTION_COUNTER_CONTRACT: this is the platform's
          statement about how promotions work, and the merchant's hint below is
          additional detail on top of it, never a substitute for it. */}
      <p className="mt-3 flex items-start gap-1.5 text-label-s text-on-surface-variant">
        <span aria-hidden className="material-symbols-rounded text-base leading-none">
          storefront
        </span>
        {/* The test id sits on the TEXT, not on the row: the decorative glyph
            renders as the ligature name "storefront" in textContent, and the
            assertion on this copy is a full-string toBe. */}
        <span data-testid="promotion-counter-contract">{PROMOTION_COUNTER_CONTRACT}</span>
      </p>

      {promotion.redemptionHint ? (
        <p className="mt-1 text-label-s text-secondary">
          💡 {promotion.redemptionHint}
        </p>
      ) : null}
    </div>
  );
}
