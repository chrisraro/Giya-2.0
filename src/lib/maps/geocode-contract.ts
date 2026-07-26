// The shape of the geocoding conversation, with no implementation attached.
//
// It is a separate file from ./geocode.ts for one hard reason: that module is
// `server-only`, and the picker that consumes this API is a client component.
// Importing a constant from a server-only module into the browser bundle is a
// build error, so the contract both sides need lives here, where it is pure.

export const MIN_QUERY_LENGTH = 3;
export const MAX_QUERY_LENGTH = 160;
export const MAX_RESULTS = 5;

/**
 * The client-side floor between two address lookups. The real ceiling is the
 * Nominatim policy's one-request-per-second, enforced globally on the server
 * (see ./geocode.ts); this exists so the common case never reaches it, and so a
 * merchant holding down Enter throttles locally instead of collecting 429s.
 */
export const GEOCODE_MIN_INTERVAL_MS = 1_000;

/**
 * How long the pin must sit still before its address is looked up. Applies to
 * DRAGS, not keystrokes - debouncing a drag stream to one request when the
 * finger lifts is one lookup for one gesture, which is not what the policy's
 * autocomplete prohibition is about.
 */
export const REVERSE_GEOCODE_DEBOUNCE_MS = 800;

export interface GeocodeResult {
  /** The provider's place id, as a string. Used only as a React key. */
  readonly id: string;
  /** The full human-readable address, which is what the merchant confirms. */
  readonly label: string;
  readonly lat: number;
  readonly lng: number;
}

/** The body of a successful GET /api/v1/geocode, inside doc 13's envelope. */
export interface GeocodeResponse {
  readonly results: readonly GeocodeResult[];
  /** The reverse-geocoded address, or null when the point has no known one. */
  readonly address: string | null;
}

/**
 * Collapses whitespace and caps length. Returns null for anything too short to
 * be a real query, so a caller can refuse it without spending a request.
 *
 * Nothing here strips punctuation: the geocoder takes free text, and commas,
 * hyphens and hash signs are all load-bearing in Philippine addresses
 * ("Blk 3 Lot 12, Brgy. San Jose"). The value ends up as a query-string
 * parameter that `URLSearchParams` encodes, so there is no injection surface
 * this could usefully defend.
 */
export function sanitiseQuery(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  return collapsed.length >= MIN_QUERY_LENGTH ? collapsed : null;
}
