// ===========================================================================
// THE BASEMAP, AND WHY THIS ONE.
//
// Requirement: open-source maps, no paid key. That splits into two separate
// questions, and conflating them is how apps end up violating a licence:
//
//   The DATA is OpenStreetMap, which is open (ODbL) and requires attribution.
//   The TILES are a hosting service, which is somebody's bandwidth bill.
//
// `tile.openstreetmap.org` is the obvious tempting answer and it is the wrong
// one. The OSMF Tile Usage Policy explicitly names "heavy use (e.g. distributing
// an app that uses tiles from openstreetmap.org)" as forbidden, and the
// foundation blocks apps that do it. Pointing production at it would work in
// development and fail in the field, which is the worst possible failure shape.
//
// So the tiles come from MapTiler's free tier, which serves OSM-derived raster
// tiles under a key you can get without a card.
//
//   LIMITS (free tier, as published):
//     ~100,000 tile requests per month.
//     ~1,000 geocoding requests per month, which we do not use at all - see
//     ./geocode.ts, the geocoder is Nominatim and independent of this budget.
//     Attribution to MapTiler AND to OpenStreetMap is a condition of use.
//     A public browser key is expected; restrict it by HTTP referrer in the
//     MapTiler console per deployment origin.
//
//   WHAT THAT BUYS. The public business page draws its map as a static tile
//   mosaic sized to a 512x224 frame, which is 6 tiles in the common case and
//   never more than 8. Call it 6: roughly 16,000 business-page views a month
//   before the free tier is the constraint, and that is a floor rather than a
//   ceiling because tiles are immutable, CDN-cached and SHARED - two shops on
//   the same street are largely the same six images, and a returning visitor
//   fetches none of them.
//
//   WHAT CHANGES IF TRAFFIC GROWS, in the order we would actually do it:
//     1. Raise the zoom cache hit rate before paying anyone: the mosaic is
//        already deterministic per (lat, lng, zoom, scheme), so putting the
//        tile URLs behind our own CDN route with a long immutable cache is a
//        pure win and needs no provider change.
//     2. MapTiler's paid tiers, which is a billing change and no code change.
//     3. Self-host. Protomaps ships the whole planet as one PMTiles file on
//        object storage with no per-request quota at all; that swaps this
//        module's URL template and the picker's tile layer, and nothing else,
//        because every consumer of a basemap in this codebase goes through
//        `tileUrlTemplate` below.
//
//   WHAT HAPPENS WITH NO KEY AT ALL, which is the state this branch ships in:
//     `isTileSourceConfigured()` answers false, no map renders anywhere, and
//     every surface degrades to the path it already had. The public page still
//     shows the address text and - this is the part that matters - the "Get
//     directions" link still works, because a directions link is a URL built
//     from two numbers and needs no basemap. The merchant's picker still
//     searches addresses and still auto-detects position, because the geocoder
//     is a different service; only the picture is missing. Nothing anywhere
//     renders an empty grey frame.
//
// Why raster and not vector: see ../../features/businesses/settings/components
// /location-picker.tsx for the library decision. Short version - vector tiles
// need a GL renderer whose bundle is five times the whole page budget of the
// routes we are adding a map to, and raster tiles are the portable primitive
// that keeps swapping providers to a one-line change.
// ===========================================================================

export type MapColorScheme = "light" | "dark";

/**
 * MapTiler style ids. Two of them, because a raster tile is a photograph and
 * will not respect a CSS theme: the only honest way to have a dark map is to
 * ask the provider for dark pixels. A CSS `filter: invert()` is the usual
 * shortcut and it is wrong - it turns parks purple, water orange, and road
 * labels into unreadable ghosts.
 */
const STYLE_IDS: Record<MapColorScheme, string> = {
  light: "streets-v2",
  dark: "streets-v2-dark",
};

/**
 * Deliberately 1x and not `@2x`. Retina tiles are four times the bytes and
 * four times... no, the same number of requests, but four times the transfer
 * on a market that is mostly mobile data. A basemap is context, not a photo.
 */
const TILE_EXTENSION = "png";

export const MAP_MAX_ZOOM = 19;

/** The zoom a shopfront reads best at: the block is visible, the street is named. */
export const BUSINESS_MAP_ZOOM = 17;

export interface AttributionLink {
  readonly label: string;
  readonly href: string;
}

/**
 * ATTRIBUTION IS A LICENCE CONDITION. ODbL section 4.3 requires the OpenStreetMap
 * credit wherever the data is shown, and MapTiler's terms require theirs. Both
 * are rendered visibly on every surface that draws a tile; neither is behind a
 * tooltip, an "i" button or a hover.
 */
export const MAP_ATTRIBUTION: readonly AttributionLink[] = [
  { label: "MapTiler", href: "https://www.maptiler.com/copyright/" },
  { label: "OpenStreetMap", href: "https://www.openstreetmap.org/copyright" },
];

/**
 * `NEXT_PUBLIC_MAPTILER_KEY`, read straight from `process.env` rather than
 * through src/lib/env.ts, for two reasons that both matter:
 *
 *   1. That module validates the whole public surface as a unit and THROWS when
 *      any of it is missing. Everything below is built on "no key means no
 *      basemap, and every caller falls back to the address text" - a graceful
 *      absence. Routing it through a schema that can throw would turn a missing
 *      Supabase URL into a broken map, which is both wrong and confusing.
 *   2. There is nothing to validate. Any non-empty string is a candidate key;
 *      the only two states this file can distinguish are present and absent.
 *
 * The direct property access is also what Next requires: `NEXT_PUBLIC_*` values
 * are inlined at build time by literal substitution, so the read cannot be a
 * dynamic lookup. Same rule src/lib/env.ts documents for its own reads.
 */
function tileKey(): string | undefined {
  const key = process.env.NEXT_PUBLIC_MAPTILER_KEY;
  return key && key.trim().length > 0 ? key.trim() : undefined;
}

/**
 * True when a basemap can be drawn. Every map surface checks this and renders
 * its no-map fallback instead, so a missing key is a documented degradation
 * rather than a grid of broken images.
 */
export function isTileSourceConfigured(): boolean {
  return tileKey() !== undefined;
}

/**
 * An `{z}/{x}/{y}` template for the given scheme, or null when unconfigured.
 * The one place in the codebase that knows the provider's URL shape.
 */
export function tileUrlTemplate(scheme: MapColorScheme): string | null {
  const key = tileKey();
  if (!key) return null;

  return `https://api.maptiler.com/maps/${STYLE_IDS[scheme]}/256/{z}/{x}/{y}.${TILE_EXTENSION}?key=${encodeURIComponent(key)}`;
}

export interface TileTemplates {
  readonly light: string;
  readonly dark: string;
}

/**
 * Both templates, or null when there is no key. Every map surface starts with
 * this and returns null on null, BEFORE it renders any frame, border or
 * heading: that is what "no key means no map, not an empty grey rectangle"
 * amounts to in practice. One call rather than an `isTileSourceConfigured()`
 * check followed by two template reads, so there is a single guard to test
 * instead of three that cannot disagree.
 */
export function tileTemplates(): TileTemplates | null {
  const light = tileUrlTemplate("light");
  const dark = tileUrlTemplate("dark");
  return light !== null && dark !== null ? { light, dark } : null;
}
