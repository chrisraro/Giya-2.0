import Link from "next/link";

import { Card } from "@/components/ui/card";
import type { BusinessSummary } from "@/features/businesses/server/public-repo";
import { cn } from "@/lib/utils";

/**
 * Outlined row card for one shop on Giya: logo, name, and the type/city
 * caption, linking to that shop's public page.
 *
 * The whole card is the link. `/b/[slug]` has existed and worked since the
 * catalog slice but nothing in the consumer app pointed at it, so every card on
 * /home was a dead end; this is the route in. It is also the right destination
 * rather than `/scan?business={id}`, because a consumer browsing shops has not
 * decided to scan anything yet, and the business page carries the menu, the
 * claimable rewards and its own "Scan receipt" CTA already bound to this
 * business.
 *
 * Type-only import of BusinessSummary, so this stays a plain component and
 * never drags the server-side Supabase client into a bundle. Distance and
 * points-per-peso are deliberately absent: neither exists in the data model
 * (there is no geolocation in this app and no per-business earn rate on
 * `businesses`), and the previous version printed both from fixtures.
 */
export function BusinessCard({ business }: { business: BusinessSummary }) {
  const caption = [business.businessTypeName, business.cityName].filter(Boolean).join(" · ");

  return (
    <Link
      href={`/b/${business.slug}`}
      className="block rounded-md3-md outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <Card
        variant="outlined"
        className={cn(
          "flex items-center gap-3 p-4",
          "transition-colors duration-200 ease-standard hover:bg-surface-container",
        )}
      >
        <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-container text-title-m text-on-primary-container">
          {business.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- external merchant-hosted image, next/image domain allowlisting not set up for this slice
            <img src={business.logoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            business.name.charAt(0).toUpperCase()
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-title-m text-on-surface">{business.name}</span>
          {caption ? (
            <span className="mt-0.5 block truncate text-body-s text-on-surface-variant">
              {caption}
            </span>
          ) : null}
        </span>

        <span aria-hidden className="material-symbols-rounded shrink-0 text-on-surface-variant">
          chevron_right
        </span>
      </Card>
    </Link>
  );
}
