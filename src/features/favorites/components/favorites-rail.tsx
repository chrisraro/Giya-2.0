import Link from "next/link";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Horizontal scroll-snap row of the shops the consumer has hearted, for /home.
 *
 * Deliberately the same shape as `LoyaltyStrip` (the section directly above it):
 * `-mx-4` bleed, `snap-x snap-mandatory`, fixed-width elevated cards, whole card
 * is the link. Two rails on one screen that scroll and focus differently is a
 * worse screen than either.
 *
 * Narrower than `BusinessCard` on purpose. This is not discovery: the consumer
 * already chose these shops, so the type/city caption that helps tell two
 * unfamiliar shops apart is noise here, and the row is for getting back to a
 * known shop in one tap. The full list, with the caption, is one tap away at
 * /favorites.
 *
 * No "use client": nothing here is interactive beyond a link, so this stays in
 * the server component tree and /home stays an RSC.
 */
export interface FavoriteRailItem {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly logoUrl: string | null;
}

export function FavoritesRail({ favorites }: { favorites: readonly FavoriteRailItem[] }) {
  return (
    <div
      className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1"
      style={{ scrollbarWidth: "none" }}
    >
      {favorites.map((favorite) => (
        <Link
          key={favorite.id}
          href={`/b/${favorite.slug}`}
          className="shrink-0 snap-start rounded-md3-md outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Card
            variant="elevated"
            className={cn(
              "flex w-[168px] items-center gap-3 p-3",
              "transition-colors duration-200 ease-standard hover:bg-surface-container",
            )}
          >
            <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-container text-title-s text-on-primary-container">
              {favorite.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- external merchant-hosted image, next/image domain allowlisting not set up for this slice
                <img src={favorite.logoUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                favorite.name.charAt(0).toUpperCase()
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-title-s text-on-surface">
              {favorite.name}
            </span>
          </Card>
        </Link>
      ))}
    </div>
  );
}
