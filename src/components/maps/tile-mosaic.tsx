import type * as React from "react";

import { type TileTemplates } from "@/lib/maps/tile-source";
import { buildTileUrl, type StaticMapLayout, TILE_SIZE } from "@/lib/maps/tiles";

// ===========================================================================
// The basemap itself: a grid of <img> tags at absolute offsets, and nothing
// else. No state, no client JavaScript, no knowledge of what is drawn on top.
//
// It lives in its own file because there are now two surfaces that draw a
// basemap on the server - the single-pin map on /b/[slug] and the result-set
// map on /discover - and the alternative was a second copy of the <picture>
// element below. That element is not boilerplate: it encodes the dark-theme
// decision and the tile-budget reasoning, and two copies of it would be two
// places for the licence-relevant and quota-relevant choices to drift apart.
//
// `children` are drawn INSIDE the mosaic's own positioned box, so anything
// placed with `offsetWithinFrame` lines up with the tiles by construction.
// ===========================================================================

export interface TileMosaicProps {
  readonly layout: StaticMapLayout;
  readonly templates: TileTemplates;
  readonly children?: React.ReactNode;
}

export function TileMosaic({ layout, templates, children }: TileMosaicProps) {
  return (
    <div
      // The mosaic sits centred inside whatever width the frame ended up
      // with, so cropping is symmetric and the centre stays the centre.
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
          <source media="(prefers-color-scheme: dark)" srcSet={buildTileUrl(templates.dark, tile)} />
          {/* A bare <img> and not next/image, on purpose: next/image would
              proxy every tile through our own optimizer, which defeats the
              immutable shared CDN caching that makes the free tier viable
              (see src/lib/maps/tile-source.ts) and adds a serverless
              invocation per tile to re-encode an image that is already
              exactly 256x256. It is also the <picture> fallback, which
              next/image cannot be. */}
          <img
            src={buildTileUrl(templates.light, tile)}
            alt=""
            width={TILE_SIZE}
            height={TILE_SIZE}
            // Below the fold on both surfaces; never block the LCP for it.
            loading="lazy"
            decoding="async"
            className="absolute max-w-none"
            style={{ left: tile.left, top: tile.top }}
          />
        </picture>
      ))}

      {children}
    </div>
  );
}
