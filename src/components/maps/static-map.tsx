import { type Coordinates } from "@/lib/maps/coordinates";
import { BUSINESS_MAP_ZOOM, isTileSourceConfigured, tileUrlTemplate } from "@/lib/maps/tile-source";
import { buildTileUrl, staticMapLayout, TILE_SIZE } from "@/lib/maps/tiles";
import { cn } from "@/lib/utils";

import { MapAttribution, MapPin } from "./map-chrome";

// ===========================================================================
// A MAP WITH NO JAVASCRIPT.
//
// This is a server component. It ships zero bytes of client script: the tile
// arithmetic runs during the render, and the browser receives a handful of
// <img> tags at absolute pixel offsets with a CSS pin on top.
//
// That is the entire reason it exists. `/b/[slug]` is a public, SEO-relevant,
// ISR'd RSC page with a documented budget of 90KB of JS (doc 33, "Performance
// budgets"), and it currently ships almost none. Mounting an interactive map
// library there would cost more than the whole budget to serve a control that
// most visitors scroll past - and the one thing a visitor actually wants from
// it, directions, is a link that needs no map at all.
//
// So the public page gets a picture of the right piece of the world, and the
// interactive map lives only where someone has come specifically to interact
// with one: the merchant's picker.
//
// The "upgrade on interaction" pattern was considered and rejected in favour of
// something simpler and better: the picture IS the directions link. Tapping it
// hands off to the map app the visitor already has, which can do everything an
// embedded map could and also knows where they are standing.
// ===========================================================================

/**
 * The mosaic is computed for a fixed logical box and then cropped by a
 * responsive frame, rather than measured per viewport - a server component
 * cannot know the viewport, and guessing wrong would leave a bald strip at the
 * edge. 512 is wider than the `max-w-md` (448px) column this renders in, minus
 * padding, on every phone; anything narrower crops symmetrically around the
 * centre, and the pin is at the centre, so the pin is never what gets cropped.
 *
 * 512x224 needs at most three tile columns and two rows: six requests, eight in
 * the worst alignment. That number is what the free-tier budget in
 * src/lib/maps/tile-source.ts is reasoned from.
 */
export const STATIC_MAP_WIDTH = 512;
export const STATIC_MAP_HEIGHT = 224;

export interface StaticMapProps {
  readonly center: Coordinates;
  /** Names the place for assistive technology. The map itself is decorative. */
  readonly label: string;
  readonly zoom?: number;
  readonly className?: string;
}

/**
 * Renders the basemap around `center`, or nothing at all when no tile key is
 * configured. Returning null rather than a placeholder is deliberate: every
 * caller already has an address-text path that stands on its own, and an empty
 * bordered rectangle saying "map unavailable" is worse than no rectangle.
 */
export function StaticMap({ center, label, zoom = BUSINESS_MAP_ZOOM, className }: StaticMapProps) {
  if (!isTileSourceConfigured()) return null;

  const lightTemplate = tileUrlTemplate("light");
  const darkTemplate = tileUrlTemplate("dark");
  if (!lightTemplate || !darkTemplate) return null;

  const layout = staticMapLayout({
    center,
    zoom,
    width: STATIC_MAP_WIDTH,
    height: STATIC_MAP_HEIGHT,
  });

  return (
    <div
      role="img"
      aria-label={`Map showing the location of ${label}`}
      className={cn(
        "relative h-56 w-full overflow-hidden rounded-md3-md border border-outline-variant bg-surface-container",
        className,
      )}
    >
      <div
        // The mosaic sits centred inside whatever width the frame ended up
        // with, so cropping is symmetric and the pin stays on the shop.
        className="absolute left-1/2 top-0 -translate-x-1/2"
        style={{ width: layout.width, height: layout.height }}
      >
        {layout.tiles.map((tile) => (
          <picture key={tile.id}>
            {/*
              THE DARK-THEME DECISION, in one element.

              A raster tile is a photograph; it will not respond to a CSS class
              the way a token-styled surface does. There are three ways to deal
              with that and only one of them belongs on a server-rendered page:

                - `filter: invert(1) hue-rotate(180deg)`, the popular trick.
                  Rejected: it makes parks purple, water orange and label text
                  a grey ghost. It looks broken rather than dark.
                - Render both schemes and toggle with a `dark:` class.
                  Rejected: `display: none` does not stop a browser fetching an
                  image, so every visitor would download both mosaics and burn
                  twice the tile quota to look at one of them.
                - Ask the provider for dark pixels and let the BROWSER choose
                  which set to fetch. That is <picture> with a media condition,
                  and it downloads exactly one.

              The cost, stated plainly: this follows the OS colour scheme, while
              the surrounding chrome follows next-themes. Those agree by default
              (next-themes' default is `system`) and disagree only for a visitor
              who has explicitly overridden the theme inside the app. For that
              visitor the map is a light photograph in a dark frame - which is
              how every photograph on a dark page already looks, and is why the
              frame carries a token border and a token background: it reads as a
              framed image, not as a theme failure.
            */}
            <source
              media="(prefers-color-scheme: dark)"
              srcSet={buildTileUrl(darkTemplate, tile)}
            />
            {/* A bare <img> and not next/image, on purpose: next/image would
                proxy every tile through our own optimizer, which defeats the
                immutable shared CDN caching that makes the free tier viable
                (see src/lib/maps/tile-source.ts) and adds a serverless
                invocation per tile to re-encode an image that is already
                exactly 256x256. It is also the <picture> fallback, which
                next/image cannot be. */}
            <img
              src={buildTileUrl(lightTemplate, tile)}
              alt=""
              width={TILE_SIZE}
              height={TILE_SIZE}
              // Below the fold on the business page; never block the LCP for it.
              loading="lazy"
              decoding="async"
              className="absolute max-w-none"
              style={{ left: tile.left, top: tile.top }}
            />
          </picture>
        ))}

        {/* Bottom-centre of the pin's box is its point; see MAP_PIN_CLASS. */}
        <span
          className="absolute"
          style={{
            left: layout.pinLeft,
            top: layout.pinTop,
            transform: "translate(-50%, -100%)",
          }}
        >
          <MapPin />
        </span>
      </div>

      <MapAttribution className="absolute bottom-1 right-1" />
    </div>
  );
}
