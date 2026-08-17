import { type Coordinates } from "./coordinates";
import { projectToWorldPixels, unprojectFromWorldPixels } from "./tiles";

// ===========================================================================
// "These shops" to "this frame".
//
// The single-pin static map is told where to look. A discover map is not: it
// has a set of results and has to work out a centre and a zoom that shows all
// of them. That is the whole of this file, and it is deliberately pure - no
// React, no environment, no tile URLs - so the answer can be checked against
// literals worked out by hand rather than against the code that produced it.
//
// Everything happens in ZOOM 0 WORLD PIXELS, where the whole planet is one
// 256px tile. A span measured there scales by exactly 2^z at zoom z, so
// "largest zoom at which the span still fits" is one logarithm rather than a
// search. The centre comes back out through the inverse projection, which is
// why it is a real coordinate and not a pixel the caller has to interpret.
// ===========================================================================

/** The zoom at which the world is a single tile, and the unit of measurement. */
const REFERENCE_ZOOM = 0;

export interface FitBoundsArgs {
  /** Every point that must be visible. Order is irrelevant. */
  readonly points: readonly Coordinates[];
  readonly width: number;
  readonly height: number;
  /** The furthest out the caller will accept. Clamps a very scattered set. */
  readonly minZoom: number;
  /** The closest in. Also the answer when the points share one location. */
  readonly maxZoom: number;
  /**
   * Pixels reserved at every edge. A pin is drawn at its point but occupies
   * space above and beside it, so a frame fitted exactly to the bounding box
   * slices the outermost pins. Callers pass the pin's size.
   */
  readonly padding?: number;
}

export interface FitBoundsResult {
  readonly center: Coordinates;
  readonly zoom: number;
}

/**
 * The centre and integer zoom at which every point fits inside a
 * `width` x `height` frame, or null when there are no points at all.
 *
 * Null rather than a default centre is the contract that matters: the caller
 * needs to distinguish "no result has a pin" from "the results are near 0,0",
 * because the first means draw no map and the second means draw one.
 *
 * KNOWN LIMIT, stated rather than hidden: the longitude span is measured on the
 * unwrapped projection, so a result set straddling the antimeridian takes the
 * long way round the planet. Measured at lng 179 and -179, two points 2 degrees
 * apart, this returns centre 0.0000, 0.0000 and offsets of 1274.3 and -762.3:
 * a map of the Gulf of Guinea, 180 degrees from both shops, with neither shop
 * in the frame. It is centred in the wrong place, not merely too far out.
 *
 * That is accepted rather than fixed because Giya's catalog is Philippine and
 * sits between 116E and 127E, so the branch that would handle it is unreachable
 * from real data and therefore untestable. If this function is ever pointed at
 * a catalog that crosses the seam, this is the thing to fix first.
 */
export function fitBounds({
  points,
  width,
  height,
  minZoom,
  maxZoom,
  padding = 0,
}: FitBoundsArgs): FitBoundsResult | null {
  if (points.length === 0) return null;

  const projected = points.map((point) => projectToWorldPixels(point, REFERENCE_ZOOM));

  const minX = Math.min(...projected.map((pixel) => pixel.x));
  const maxX = Math.max(...projected.map((pixel) => pixel.x));
  const minY = Math.min(...projected.map((pixel) => pixel.y));
  const maxY = Math.max(...projected.map((pixel) => pixel.y));

  // The midpoint of the PICTURE, not of the numbers. Mercator stretches
  // towards the poles, so averaging two latitudes puts the frame's centre
  // somewhere neither shop is; averaging their projections does not.
  const center = unprojectFromWorldPixels(
    { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    REFERENCE_ZOOM,
  );

  // At least one pixel each way, so a frame smaller than its own padding
  // produces a very close zoom rather than a division by zero.
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);

  const spanX = maxX - minX;
  const spanY = maxY - minY;

  // A zero span fits at every zoom, so it constrains nothing; when both are
  // zero every point is the same point and the answer is `maxZoom`.
  const zoomForWidth = spanX > 0 ? Math.log2(usableWidth / spanX) : Infinity;
  const zoomForHeight = spanY > 0 ? Math.log2(usableHeight / spanY) : Infinity;

  // Floored, not rounded: rounding up doubles the scale and pushes the
  // outermost shops off the frame, which is the one thing this must not do.
  const fitted = Math.floor(Math.min(zoomForWidth, zoomForHeight));

  return {
    center,
    zoom: Math.min(maxZoom, Math.max(minZoom, Number.isFinite(fitted) ? fitted : maxZoom)),
  };
}
