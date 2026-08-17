import Link from "next/link";

import { MapAttribution, MAP_PIN_CLASS, MAP_PIN_SIZE } from "@/components/maps/map-chrome";
import { TileMosaic } from "@/components/maps/tile-mosaic";
import type { BusinessSummary } from "@/features/businesses/server/public-repo";
import { type Coordinates } from "@/lib/maps/coordinates";
import { fitBounds } from "@/lib/maps/bounds";
import { tileTemplates } from "@/lib/maps/tile-source";
import { offsetWithinFrame, staticMapLayout } from "@/lib/maps/tiles";
import { cn } from "@/lib/utils";

// ===========================================================================
// A MAP OF THE RESULT SET, STILL WITH NO JAVASCRIPT.
//
// Same server component, same zero client bytes, same <img> mosaic as
// /b/[slug]. What changes is that the frame is DERIVED from the results
// instead of given, and that it carries one pin per shop instead of one pin.
//
// WHY STATIC AND NOT INTERACTIVE, on a browse screen where panning is the
// obvious thing to want:
//
//   Tile budget. src/lib/maps/tile-source.ts reasons from MapTiler's ~100,000
//   requests a month. A static frame costs at most eight tiles per render and
//   those tiles are immutable, CDN-cached and shared between shops on the same
//   street. An interactive map costs a fresh set on every pan and every zoom,
//   from every browsing consumer, and none of that is shared. The ceiling is
//   genuinely reachable.
//
//   The connection. A GL or Leaflet bundle plus its tiles, on Philippine
//   mobile data, to serve a control most people glance at once.
//
//   What the map is for HERE. On /discover it answers "where are these,
//   roughly" and hands off to a shop page. Panning around a city is what
//   /b/[slug]'s directions link and the phone's own map app are for.
//
// WHAT THE CONSUMER LOSES, stated rather than glossed: they cannot pan, zoom,
// or see a shop that sits outside the fitted frame. The third is the real one,
// and it is why the fit is computed over the whole filtered set with padding
// for the pin rather than over an arbitrary head of it.
// ===========================================================================

/**
 * How wide a picture is PAINTED. The same 512x224 box the single-pin map uses,
 * for the same reason: it is wider than the max-w-md column on every phone, so
 * the responsive frame crops it symmetrically rather than leaving a bald strip
 * at the edge. Sharing the number also means the tile-budget arithmetic in
 * tile-source.ts covers both surfaces without a second calculation.
 *
 * This is NOT the width the shops are fitted into. See DISCOVER_MAP_FIT_WIDTH.
 */
export const DISCOVER_MAP_WIDTH = 512;
export const DISCOVER_MAP_HEIGHT = 224;

/**
 * How wide a picture is SEEN, and therefore the box every pin has to land in.
 *
 * These are two different numbers and conflating them was a real bug. The
 * mosaic is centred with `absolute left-1/2 -translate-x-1/2` inside an
 * `overflow-hidden` section, so the column crops it symmetrically and only the
 * middle slice is ever painted. /discover is `max-w-md px-4`, and max-w-md is
 * 448px with no --container-md override in globals.css, so the column is
 * min(viewport, 448) - 32:
 *
 *   448px viewport and up -> 416px column, visible slice x in [48, 464]
 *   320px viewport        -> 288px column, visible slice x in [112, 400]
 *
 * Fitting to 512 put pins as far out as x = 24, which is 88px outside the left
 * edge of even the WIDEST column: a result set spread more than about 2.4x
 * wider than tall lost its outermost shops off both sides. That is a direct
 * contradiction of the only promise this map makes.
 *
 * 288 is the narrowest column a supported phone can produce, so fitting to it
 * means every pin is visible on every device rather than on a good one. The
 * cost is at most one zoom level on a large screen (log2(416/288) = 0.53, and
 * the fit floors to an integer), which is a cheap price for the promise being
 * true. The bleed either side is still painted, so nothing looks cropped.
 */
export const DISCOVER_MAP_FIT_WIDTH = 288;

/**
 * The closest this map ever gets, which is also what a single result gets.
 *
 * Deliberately below BUSINESS_MAP_ZOOM (17). That zoom exists to show one
 * shopfront's block and street name, because /b/[slug] is about that shop. A
 * consumer on /discover is asking which part of town, so the neighbourhood is
 * the honest answer and a street-level frame around a lone result would imply
 * a precision the browse screen does not have.
 */
export const DISCOVER_MAP_MAX_ZOOM = 15;

/**
 * The furthest out. A Philippine catalog spanning Batanes to Tawi-Tawi still
 * fits well inside this, so it never clips a real result set.
 *
 * WHAT IT DOES AND DOES NOT BUY, since the earlier comment here claimed more
 * than the code delivers. It bounds the basemap, and nothing else. It does not
 * rescue a result set containing a mis-geocoded outlier: `toPublicCoordinates`
 * validates only that a pair is inside +/-90 and +/-180, so a merchant typo
 * lands anywhere on Earth and passes, and Cebu plus a row typed into London
 * renders a basemap of eastern Iran with both pins off-frame. The floor stops
 * that being the whole globe as a smear; it does not make it a useful picture.
 *
 * That is survivable only because the map is decoration and the LIST is what
 * the consumer reads: both shops are still in the results, including the
 * mis-geocoded one. Fixing it properly means outlier rejection, which would
 * hide a shop from the map on a heuristic and is a worse trade at this size.
 */
export const DISCOVER_MAP_MIN_ZOOM = 3;

type PinnedBusiness = BusinessSummary & { coordinates: Coordinates };

function hasPin(business: BusinessSummary): business is PinnedBusiness {
  return business.coordinates !== null;
}

export interface DiscoverMapProps {
  /**
   * The CURRENT filtered results, in full. The map is derived from exactly
   * what the list shows, so a search or a city change cannot leave a map of
   * the previous result set behind.
   */
  readonly businesses: readonly BusinessSummary[];
  readonly className?: string;
}

export function DiscoverMap({ businesses, className }: DiscoverMapProps) {
  // The no-key path, and it comes first for a reason: NEXT_PUBLIC_MAPTILER_KEY
  // is not configured yet, so this is what ships. Returning null before any
  // frame, border or heading is rendered is what makes /discover fully usable
  // with no map and silent about the fact that there could have been one.
  const templates = tileTemplates();
  if (!templates) return null;

  // Ungeocoded shops are dropped HERE and nowhere else. They stay in the
  // result list the caller renders; they are simply not on the picture.
  const pinned = businesses.filter(hasPin);

  const frame = fitBounds({
    // The width SEEN, not the width painted: a pin fitted into the part of the
    // mosaic the column crops away is a pin nobody can see or tap.
    points: pinned.map((business) => business.coordinates),
    width: DISCOVER_MAP_FIT_WIDTH,
    height: DISCOVER_MAP_HEIGHT,
    minZoom: DISCOVER_MAP_MIN_ZOOM,
    maxZoom: DISCOVER_MAP_MAX_ZOOM,
    // A pin is drawn at its point but occupies space above and beside it, so
    // an exactly-fitted frame slices the outermost ones in half.
    padding: MAP_PIN_SIZE,
  });

  // Null means no result carries a pin. A basemap centred on nothing, showing
  // nothing, is worse than no basemap, and it would also be the one thing on
  // the page implying the results have locations when they do not.
  if (!frame) return null;

  const layout = staticMapLayout({
    center: frame.center,
    zoom: frame.zoom,
    width: DISCOVER_MAP_WIDTH,
    height: DISCOVER_MAP_HEIGHT,
  });

  return (
    <section
      aria-label="Shops in these results, on a map"
      className={cn(
        "relative h-56 w-full overflow-hidden rounded-md3-md border border-outline-variant bg-surface-container",
        className,
      )}
    >
      <TileMosaic layout={layout} templates={templates}>
        {/* A list rather than loose spans: the pins are the map's content, and
            a screen reader should be able to walk them as the set of shops
            they are. The tiles underneath stay decorative. */}
        <ul>
          {pinned.map((business) => {
            const offset = offsetWithinFrame(business.coordinates, layout);

            return (
              <li
                key={business.id}
                className="absolute"
                // Bottom-centre of the pin's box is its point; see MAP_PIN_CLASS.
                style={{ left: offset.left, top: offset.top, transform: "translate(-50%, -100%)" }}
              >
                <Link
                  href={`/b/${business.slug}`}
                  className={cn(
                    "relative block rounded-full",
                    // A 24px pin is a 24px target. The pseudo-element grows the
                    // tappable area to 48px without moving the pin off the shop,
                    // which padding on the link would.
                    "after:absolute after:-inset-3 after:content-['']",
                    "hover:z-10 focus-visible:z-10",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  )}
                >
                  <span aria-hidden className={MAP_PIN_CLASS} />
                  <span className="sr-only">{business.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </TileMosaic>

      <MapAttribution className="absolute bottom-1 right-1" />
    </section>
  );
}
