import "server-only";

import { z } from "zod";

import { checkRateLimit } from "@/lib/rate-limit";
import { get, redisKey, set } from "@/lib/redis";

import { isValidCoordinates, roundCoordinate, type Coordinates } from "./coordinates";
import {
  MAX_RESULTS,
  sanitiseQuery,
  type GeocodeResult,
} from "./geocode-contract";

// ===========================================================================
// GEOCODING: NOMINATIM, AND WHY IT RUNS ON THE SERVER.
//
// Nominatim is the open-source geocoder over OpenStreetMap data. It is free
// and needs no key. It also has a usage policy, and this module exists because
// ONE line of that policy makes a browser-side implementation impossible
// rather than merely impolite:
//
//   "Provide a valid HTTP Referer or User-Agent identifying the application."
//
// `User-Agent` is a forbidden header name in the Fetch standard. Browser code
// physically cannot set it. So a client that calls nominatim.openstreetmap.org
// directly cannot comply, no matter how careful it is about anything else.
// That single fact settles the architecture: the call is proxied through our
// own server, which can identify itself honestly, and the picker talks to
// /api/v1/geocode instead.
//
// Having moved it server-side, the rest of the policy becomes enforceable
// rather than aspirational:
//
//   "An absolute maximum of 1 request per second."
//     Enforced here, on a GLOBAL Redis key - not per user. The policy limits
//     the APPLICATION, so a limiter keyed by caller would multiply the ceiling
//     by the number of merchants online and quietly violate it. The route in
//     front of this also limits per user, but that is abuse control and a
//     different job.
//
//   "Cache results where possible."
//     Every lookup is cached for 24h. Addresses do not move.
//
//   Unacceptable Use: "Auto-complete search ... you must not implement such a
//   service on the client side using the API."
//     This is explicit, and it rules out the per-keystroke box that a debounce
//     is usually the answer to. So the picker does not have one. Search is an
//     EXPLICIT submit - a Search button and the Enter key - with a client-side
//     throttle underneath it so a merchant leaning on Enter cannot outrun the
//     policy either. Debouncing a keystroke stream down to one request a second
//     would still be autocomplete, just a slower one, so it is not what "respect
//     the policy" means here.
//
//     Reverse geocoding IS debounced, because there the event stream is pin
//     drags rather than keystrokes and a single request on drag-END is the
//     whole interaction, not a sampled version of it.
//
//   "Bulk geocoding ... is not permitted."
//     Nothing here loops. One merchant, one address, once, at setup time.
//
// IF PER-KEYSTROKE AUTOCOMPLETE EVER BECOMES A REQUIREMENT: the answer is
// Photon (komoot, open source, same OSM data), which is purpose-built for
// incremental search and whose public instance permits it. It would replace
// this file and nothing else, because the route above it speaks in
// `GeocodeResult`, not in Nominatim's response shape.
// ===========================================================================

const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org";

/**
 * The identification the policy asks for: what the software is, where it lives
 * and who to contact when it misbehaves. A generic string like "MyApp/1.0" is
 * treated as unidentified and gets blocked.
 */
const USER_AGENT = "Giya/1.0 (loyalty platform; +https://giya.ph; teamocsph@gmail.com)";

/** The application-wide ceiling from the policy, not a per-caller one. */
const GLOBAL_REQUESTS_PER_WINDOW = 1;
const GLOBAL_WINDOW_SECONDS = 1;

const CACHE_TTL_SECONDS = 86_400;

/** A network hang must not hold a merchant's Search button hostage. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Results are biased to the Philippines because that is the market, and
 * because "12 Real Street" is otherwise a street in forty countries. This is a
 * search preference and not a validation rule; nothing rejects a coordinate
 * for being outside it (see ./coordinates.ts).
 */
const COUNTRY_CODES = "ph";

export type GeocodeFailure = "throttled" | "unavailable";

export type GeocodeOutcome<T> = { ok: true; data: T } | { ok: false; reason: GeocodeFailure };

const searchResponseSchema = z.array(
  z.object({
    place_id: z.union([z.number(), z.string()]).optional(),
    lat: z.string(),
    lon: z.string(),
    display_name: z.string(),
  }),
);

const reverseResponseSchema = z.union([
  z.object({ display_name: z.string() }),
  z.object({ error: z.unknown() }),
]);

/**
 * The global 1-req/s gate. Note the failure direction: `checkRateLimit` fails
 * OPEN on a Redis outage, which here means "call Nominatim anyway". That is
 * the right call and it is worth naming, because the instinct is the opposite.
 * The traffic this gate shapes is one merchant pressing a button during a
 * one-time setup; there is no burst to contain. Failing closed would take the
 * only address search in the product offline for the duration of an unrelated
 * Redis blip, to protect a rate limit that the button's own client-side
 * throttle and the per-user limiter on the route already keep us far below.
 */
async function claimGlobalBudget(): Promise<boolean> {
  const result = await checkRateLimit({
    key: redisKey("nominatim", "global"),
    limit: GLOBAL_REQUESTS_PER_WINDOW,
    windowSeconds: GLOBAL_WINDOW_SECONDS,
  });
  return result.ok;
}

async function readCache(key: string): Promise<unknown | undefined> {
  try {
    const raw = await get(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    // A cache that cannot be read is a cache miss, never an error: the whole
    // point of caching here is to be kind to Nominatim, not to be correct.
    return undefined;
  }
}

async function writeCache(key: string, value: unknown): Promise<void> {
  try {
    await set(key, JSON.stringify(value), CACHE_TTL_SECONDS);
  } catch (error) {
    console.warn("[geocode] could not cache result", error);
  }
}

async function fetchNominatim(path: string, params: URLSearchParams): Promise<unknown | null> {
  try {
    const response = await fetch(`${NOMINATIM_BASE_URL}${path}?${params.toString()}`, {
      headers: {
        // The policy's requirement, and the reason this call is not in the
        // browser. See the header comment.
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Nominatim is a third party; Next's fetch cache would hold a copy we
      // cannot invalidate and would double up with the Redis cache above.
      cache: "no-store",
    });

    if (!response.ok) {
      console.warn(`[geocode] nominatim answered ${response.status} for ${path}`);
      return null;
    }

    return (await response.json()) as unknown;
  } catch (error) {
    console.warn(`[geocode] nominatim request failed for ${path}`, error);
    return null;
  }
}

/**
 * Free-text address search. Returns at most `MAX_RESULTS` places, each already
 * reduced to the four fields the picker needs, so no part of Nominatim's
 * response shape escapes this module.
 */
export async function searchAddress(query: string): Promise<GeocodeOutcome<GeocodeResult[]>> {
  const clean = sanitiseQuery(query);
  if (!clean) return { ok: true, data: [] };

  const cacheKey = redisKey("geo", "search", clean.toLowerCase());
  const cached = await readCache(cacheKey);
  if (cached !== undefined) {
    const parsed = z.array(z.custom<GeocodeResult>()).safeParse(cached);
    if (parsed.success) return { ok: true, data: parsed.data };
  }

  if (!(await claimGlobalBudget())) return { ok: false, reason: "throttled" };

  const raw = await fetchNominatim(
    "/search",
    new URLSearchParams({
      q: clean,
      format: "jsonv2",
      limit: String(MAX_RESULTS),
      addressdetails: "0",
      countrycodes: COUNTRY_CODES,
    }),
  );
  if (raw === null) return { ok: false, reason: "unavailable" };

  const parsed = searchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("[geocode] unexpected nominatim search payload");
    return { ok: false, reason: "unavailable" };
  }

  const results: GeocodeResult[] = [];
  for (const [index, place] of parsed.data.entries()) {
    const lat = Number(place.lat);
    const lng = Number(place.lon);
    // A place whose coordinates do not parse is dropped rather than surfaced:
    // picking it would write a NaN into the form.
    if (!isValidCoordinates({ lat, lng })) continue;

    results.push({
      id: String(place.place_id ?? `${index}`),
      label: place.display_name,
      lat: roundCoordinate(lat),
      lng: roundCoordinate(lng),
    });
  }

  await writeCache(cacheKey, results);
  return { ok: true, data: results };
}

/**
 * Coordinates to an address string, for the "you dropped the pin here, is this
 * right?" readout. `null` data means Nominatim knows of no address at that
 * point (the middle of a field, a new subdivision), which is not a failure -
 * the pin is still valid and still saveable, it just has no name.
 *
 * The cache key rounds to four decimals, roughly 11 metres: two drags of the
 * same pin an inch apart are the same address and must not be two requests.
 */
export async function reverseGeocode(value: Coordinates): Promise<GeocodeOutcome<string | null>> {
  if (!isValidCoordinates(value)) return { ok: true, data: null };

  const cacheKey = redisKey("geo", "reverse", `${value.lat.toFixed(4)},${value.lng.toFixed(4)}`);
  const cached = await readCache(cacheKey);
  if (cached !== undefined) {
    const parsed = z.string().nullable().safeParse(cached);
    if (parsed.success) return { ok: true, data: parsed.data };
  }

  if (!(await claimGlobalBudget())) return { ok: false, reason: "throttled" };

  const raw = await fetchNominatim(
    "/reverse",
    new URLSearchParams({
      lat: String(value.lat),
      lon: String(value.lng),
      format: "jsonv2",
      zoom: "18",
      addressdetails: "0",
    }),
  );
  if (raw === null) return { ok: false, reason: "unavailable" };

  const parsed = reverseResponseSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("[geocode] unexpected nominatim reverse payload");
    return { ok: false, reason: "unavailable" };
  }

  const label = "display_name" in parsed.data ? parsed.data.display_name : null;
  await writeCache(cacheKey, label);
  return { ok: true, data: label };
}
