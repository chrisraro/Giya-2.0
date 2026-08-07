import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { PublicPromotion } from "../server/repo";

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

      {promotion.redemptionHint ? (
        <p className="mt-1 text-label-s text-secondary">
          💡 {promotion.redemptionHint}
        </p>
      ) : null}
    </div>
  );
}
