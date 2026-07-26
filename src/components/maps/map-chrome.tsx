import * as React from "react";

import { MAP_ATTRIBUTION } from "@/lib/maps/tile-source";
import { cn } from "@/lib/utils";

// Shared, framework-neutral map furniture: the pin and the attribution strip.
// Both the server-rendered static map and the client-side picker draw from
// here, so the two surfaces cannot drift into looking like different products.

/**
 * The pin, as a class string rather than a component, because it has to be
 * usable twice in two incompatible ways: as JSX on the server-rendered map,
 * and as raw markup inside a Leaflet `divIcon` on the picker.
 *
 * A CSS teardrop rather than an image: Leaflet's default marker is a PNG whose
 * path breaks under every bundler, and an <img> pin would be one more request
 * plus a shape that cannot take a theme token. This one is a circle with its
 * bottom-right corner squared off and the whole thing rotated 45 degrees, so
 * the squared corner becomes the point.
 *
 * ANCHORING: after the rotation the visual point is the bottom-centre of the
 * element's box. Both callers position accordingly - do not "fix" one of them
 * to centre the box on the coordinate, or the pin will indicate a spot roughly
 * one pin-height north of the shop.
 */
export const MAP_PIN_SIZE = 24;

export const MAP_PIN_CLASS =
  "block size-6 rotate-45 rounded-full rounded-br-none border-2 border-on-primary bg-primary shadow-md";

/** The same pin as JSX, for surfaces that render React rather than a string. */
export function MapPin({ className }: { className?: string }) {
  return <span aria-hidden className={cn(MAP_PIN_CLASS, className)} />;
}

/**
 * ATTRIBUTION IS A LICENCE CONDITION, not a courtesy: ODbL 4.3 requires the
 * OpenStreetMap credit wherever the data is shown, and the tile host requires
 * its own. So this renders on every surface that draws a tile, visibly, as real
 * links, and it is never collapsed behind an "i" affordance.
 *
 * Solid `surface-container` rather than a translucent overlay: the backdrop is
 * arbitrary tile imagery, and a semi-transparent chip that reads fine over a
 * park is unreadable over a motorway junction.
 */
export function MapAttribution({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "pointer-events-auto rounded-md3-xs bg-surface-container px-1.5 py-0.5",
        "text-label-s text-on-surface-variant",
        className,
      )}
    >
      {MAP_ATTRIBUTION.map((entry, index) => (
        <React.Fragment key={entry.href}>
          {index > 0 ? " " : null}
          <a
            href={entry.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-outline underline-offset-2 hover:text-on-surface"
          >
            &copy; {entry.label}
          </a>
        </React.Fragment>
      ))}
    </p>
  );
}
