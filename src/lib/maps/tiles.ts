import { LATITUDE_MAX, LATITUDE_MIN, type Coordinates } from "./coordinates";

// ===========================================================================
// Web Mercator slippy-map arithmetic, and nothing else. No imports beyond the
// coordinate primitives, no environment access, no React: this file is the
// part of the map that a test can reason about completely.
//
// The layout function below is what lets the PUBLIC business page render a map
// with zero client JavaScript. Given a centre, a zoom and a frame size it
// returns the exact list of <img> tiles and their pixel offsets, computed on
// the server. The browser downloads a handful of images and paints them; there
// is no map library on that route at all.
// ===========================================================================

/** Every raster basemap in common use serves 256px tiles. */
export const TILE_SIZE = 256;

/**
 * The Mercator projection is undefined at the poles (tan goes to infinity), so
 * the slippy-map convention clamps to the latitude whose projection is exactly
 * square with the longitude range. Every implementation uses this number.
 */
export const MERCATOR_LATITUDE_LIMIT = 85.0511287798;

export interface TileRef {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A tile placed in the frame: which tile, and where its top-left corner goes. */
export interface PlacedTile extends TileRef {
  /** Stable React key. Tile coordinates are unique within one layout. */
  readonly id: string;
  readonly left: number;
  readonly top: number;
}

export interface StaticMapLayout {
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  readonly tiles: readonly PlacedTile[];
  /** Where the pin's point sits inside the frame. Always the exact centre. */
  readonly pinLeft: number;
  readonly pinTop: number;
  /**
   * World-pixel coordinates of the frame's top-left corner, at `zoom`.
   *
   * Exposed because a map of a RESULT SET has to place shops at arbitrary
   * offsets, not just one at the centre. Computing it a second time in the
   * component would work today and drift the pins off the tiles the first time
   * either copy of `centerPixel - size / 2` changed; `offsetWithinFrame` below
   * reads it from here so there is only ever one copy.
   */
  readonly originX: number;
  readonly originY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Total width of the world in pixels at this zoom. */
export function worldSize(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

/**
 * Longitude/latitude to absolute world pixels at a given zoom, origin at the
 * north-west corner. Latitude is clamped to the Mercator limit first, because
 * the log below diverges beyond it and would emit Infinity into a style
 * attribute.
 */
export function projectToWorldPixels(value: Coordinates, zoom: number): { x: number; y: number } {
  const size = worldSize(zoom);
  const lat = clamp(value.lat, -MERCATOR_LATITUDE_LIMIT, MERCATOR_LATITUDE_LIMIT);
  const sinLat = Math.sin((lat * Math.PI) / 180);

  return {
    x: ((value.lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * size,
  };
}

/** The inverse, used by the tests to prove the projection round-trips. */
export function unprojectFromWorldPixels(
  point: { x: number; y: number },
  zoom: number,
): Coordinates {
  const size = worldSize(zoom);
  const lng = (point.x / size) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (point.y / size);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat: clamp(lat, LATITUDE_MIN, LATITUDE_MAX), lng };
}

export interface StaticMapLayoutArgs {
  readonly center: Coordinates;
  readonly zoom: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Which tiles cover a `width` x `height` frame centred on `center`, and where
 * each one goes.
 *
 * Two edge cases are handled rather than hoped away:
 *
 *   Longitude wraps. A frame straddling the antimeridian needs tile column
 *   -1, which does not exist; it is the same imagery as column 2^z - 1. The
 *   REQUESTED column is wrapped into range while the PLACED offset keeps using
 *   the unwrapped index, so the seam paints continuously.
 *
 *   Latitude does not wrap. A frame near the poles asks for rows above 0 or
 *   below 2^z - 1, and those tiles genuinely do not exist. They are dropped,
 *   leaving the frame's own background showing rather than a grid of broken
 *   image icons.
 */
export function staticMapLayout({
  center,
  zoom,
  width,
  height,
}: StaticMapLayoutArgs): StaticMapLayout {
  const z = Math.max(0, Math.round(zoom));
  const columns = 2 ** z;
  const centerPixel = projectToWorldPixels(center, z);

  // World-pixel coordinates of the frame's top-left corner.
  const originX = centerPixel.x - width / 2;
  const originY = centerPixel.y - height / 2;

  const firstColumn = Math.floor(originX / TILE_SIZE);
  const lastColumn = Math.floor((originX + width - 1) / TILE_SIZE);
  const firstRow = Math.floor(originY / TILE_SIZE);
  const lastRow = Math.floor((originY + height - 1) / TILE_SIZE);

  const tiles: PlacedTile[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    if (row < 0 || row >= columns) continue;

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      // `%` keeps the sign of the dividend in JS, so a negative column needs
      // the extra `+ columns` before the second modulo.
      const wrappedColumn = ((column % columns) + columns) % columns;

      tiles.push({
        id: `${z}/${column}/${row}`,
        x: wrappedColumn,
        y: row,
        z,
        left: column * TILE_SIZE - originX,
        top: row * TILE_SIZE - originY,
      });
    }
  }

  return {
    width,
    height,
    zoom: z,
    tiles,
    pinLeft: width / 2,
    pinTop: height / 2,
    originX,
    originY,
  };
}

/**
 * Where inside a frame a given coordinate falls, in frame pixels from its
 * top-left corner. The result can be negative or larger than the frame: that
 * means the point is outside it, and the caller decides whether to clip.
 */
export function offsetWithinFrame(
  point: Coordinates,
  layout: StaticMapLayout,
): { left: number; top: number } {
  const pixel = projectToWorldPixels(point, layout.zoom);
  return { left: pixel.x - layout.originX, top: pixel.y - layout.originY };
}

/**
 * Fills an `{z}/{x}/{y}` template. Kept separate from the layout so swapping
 * tile providers is a string change and touches no geometry.
 */
export function buildTileUrl(template: string, tile: TileRef): string {
  return template
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}
