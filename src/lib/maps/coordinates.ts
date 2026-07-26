// ===========================================================================
// Coordinate primitives. Pure, no imports, safe on both sides of the network
// boundary - the merchant's picker, the settings server action and the public
// business page all agree on what a coordinate is by importing this file
// rather than by re-deriving the same three constants three times.
// ===========================================================================

export interface Coordinates {
  readonly lat: number;
  readonly lng: number;
}

export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;

/**
 * Six decimal places is about 11cm at the equator, which is finer than any
 * consumer GPS fix and far finer than a shop front. Storing the raw double a
 * map click produces would persist 15 digits of float noise that no one can
 * act on and that makes two saves of the same pin look like two locations.
 */
export const COORDINATE_PRECISION = 6;

/**
 * A generous box around the Philippine archipelago, deliberately looser than
 * the land area: it reaches past Batanes in the north and past Tawi-Tawi in
 * the south, and wide enough east and west to include every inhabited island
 * plus a margin of sea. It is a SANITY hint, not a border - see
 * `isInsidePhilippines` for why nothing rejects on it.
 */
export const PHILIPPINES_BOUNDS = {
  south: 4.0,
  north: 21.5,
  west: 116.0,
  east: 127.0,
} as const;

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= LATITUDE_MIN && value <= LATITUDE_MAX;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= LONGITUDE_MIN && value <= LONGITUDE_MAX;
}

export function isValidCoordinates(value: Coordinates): boolean {
  return isValidLatitude(value.lat) && isValidLongitude(value.lng);
}

/**
 * Rounds to `COORDINATE_PRECISION`. `Number(...toFixed())` rather than a
 * multiply/divide pair because the latter reintroduces the float noise the
 * rounding exists to remove (10.3156 * 1e6 is 10315599.999999998).
 */
export function roundCoordinate(value: number): number {
  return Number(value.toFixed(COORDINATE_PRECISION));
}

/**
 * WHY THIS WARNS AND NEVER REJECTS.
 *
 * Giya sells in the Philippines, so a pin in the Atlantic is almost certainly
 * a mistake and the merchant deserves to be told before they save. But a
 * bounding box is a market assumption, not a data-integrity rule, and the two
 * fail very differently. A range check catches a corrupt value; a country box
 * catches a value that is merely surprising, and the cost of being wrong about
 * "surprising" is a merchant who physically cannot save their own address -
 * with no workaround, because the whole point of this screen is that it is the
 * only place the pin can be set.
 *
 * The genuinely dangerous mistake, transposed lat/lng, is already caught by the
 * hard range check without any help from this box: every Philippine longitude
 * is greater than 116, so a transposed pair always lands a latitude outside
 * [-90, 90] and is refused outright by `isValidLatitude`.
 *
 * So: out of range is refused server-side; outside this box is surfaced to the
 * merchant as a warning next to the Save button and logged server-side, and
 * saved if they mean it.
 */
export function isInsidePhilippines(value: Coordinates): boolean {
  return (
    value.lat >= PHILIPPINES_BOUNDS.south &&
    value.lat <= PHILIPPINES_BOUNDS.north &&
    value.lng >= PHILIPPINES_BOUNDS.west &&
    value.lng <= PHILIPPINES_BOUNDS.east
  );
}

/** Fixed decimals, so the two numbers line up in a monospace column. */
export function formatCoordinates(value: Coordinates): string {
  return `${value.lat.toFixed(COORDINATE_PRECISION)}, ${value.lng.toFixed(COORDINATE_PRECISION)}`;
}

// ===========================================================================
// THE DIRECTIONS LINK.
//
// A plain https Google Maps universal link, and deliberately NOT a platform
// switch. The three obvious candidates behave like this:
//
//   geo:14.55,121.02          Android resolves it and offers an app chooser.
//                             iOS Safari does nothing at all. Desktop browsers
//                             do nothing at all. Two dead platforms.
//   maps://... / maps.apple   iOS and macOS only. Dead on Android and on every
//                             non-Apple desktop.
//   https://google.com/maps   Registered as an App Link on Android and a
//                             Universal Link on iOS, so an installed Google
//                             Maps app intercepts it and opens natively on
//                             BOTH phone platforms. With no app installed it
//                             is still a working web page that gives
//                             directions. Never dead, anywhere.
//
// The alternative is sniffing the user agent and emitting a different scheme
// per platform. That trades a link that always works for a link that works
// when the sniff is right - and a wrong sniff produces a button that does
// nothing, which is strictly worse than a button that opens a web map. UA
// strings are also the least reliable input a browser offers (iPadOS reports
// itself as macOS by default). So: one link, one behaviour, no detection.
//
// `api=1` is Google's documented, stable URL contract - the form that is
// guaranteed not to change - and the destination is coordinates rather than a
// name because coordinates cannot be resolved to the wrong branch of a chain.
// ===========================================================================

export const DIRECTIONS_BASE_URL = "https://www.google.com/maps/dir/";

export function directionsUrl(value: Coordinates): string {
  const destination = `${roundCoordinate(value.lat)},${roundCoordinate(value.lng)}`;
  return `${DIRECTIONS_BASE_URL}?api=1&destination=${encodeURIComponent(destination)}`;
}
