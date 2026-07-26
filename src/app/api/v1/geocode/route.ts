import { z } from "zod";

import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import { defineHandler } from "@/lib/api/handler";
import {
  isValidLatitude,
  isValidLongitude,
  roundCoordinate,
  type Coordinates,
} from "@/lib/maps/coordinates";
import { reverseGeocode, searchAddress, type GeocodeFailure } from "@/lib/maps/geocode";
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  sanitiseQuery,
  type GeocodeResponse,
} from "@/lib/maps/geocode-contract";

// GET /api/v1/geocode
//
// The server side of the merchant's location picker. Two modes on one route:
//
//   ?q=<address>        forward geocode  -> a list of candidate places
//   ?lat=&lng=          reverse geocode  -> the address at a point
//
// WHY THIS ROUTE EXISTS AT ALL, rather than the picker calling Nominatim: the
// usage policy requires a descriptive `User-Agent`, and `User-Agent` is a
// forbidden header name in the Fetch standard, so browser code cannot comply.
// The full reasoning, and the rest of the policy this route is built to keep,
// is in src/lib/maps/geocode.ts.
//
// `requireSession: true` is part of that compliance and not only access
// control. The policy limits the application, so the smaller and more
// accountable the set of callers, the easier the ceiling is to hold. Address
// search is a merchant setup task with no consumer-facing use, so there is no
// cost to closing it: an anonymous caller would only ever be someone spending
// our Nominatim budget.

/**
 * Per-user abuse control, a separate concern from the global 1 req/s ceiling
 * that src/lib/maps/geocode.ts enforces on the application as a whole. Setting
 * a shop's pin involves a handful of searches and a few pin drags; 30 a minute
 * is generous for that and still bounded.
 */
const GEOCODE_RATE_LIMIT = 30;
const GEOCODE_RATE_LIMIT_WINDOW_SECONDS = 60;

type GeocodeQuery =
  | { readonly mode: "search"; readonly query: string }
  | { readonly mode: "reverse"; readonly coordinates: Coordinates };

function numeric(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const geocodeQuerySchema = z
  .object({
    q: z.string().max(MAX_QUERY_LENGTH).optional(),
    lat: z.string().optional(),
    lng: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const wantsSearch = value.q !== undefined && value.q.trim() !== "";
    const wantsReverse = value.lat !== undefined || value.lng !== undefined;

    if (wantsSearch && wantsReverse) {
      ctx.addIssue({
        code: "custom",
        path: ["q"],
        message: "Provide either a search term or a coordinate pair, not both.",
      });
      return;
    }

    if (wantsSearch) {
      if (sanitiseQuery(value.q ?? "") === null) {
        ctx.addIssue({
          code: "custom",
          path: ["q"],
          message: `Enter at least ${MIN_QUERY_LENGTH} characters to search.`,
        });
      }
      return;
    }

    if (!wantsReverse) {
      ctx.addIssue({
        code: "custom",
        path: ["q"],
        message: "Provide a search term, or a lat and lng pair.",
      });
      return;
    }

    const lat = numeric(value.lat);
    const lng = numeric(value.lng);
    // Range is checked here rather than only in the geocoder so a nonsense
    // coordinate is refused before it can spend a request from the global
    // Nominatim budget.
    if (lat === null || !isValidLatitude(lat)) {
      ctx.addIssue({ code: "custom", path: ["lat"], message: "lat must be between -90 and 90." });
    }
    if (lng === null || !isValidLongitude(lng)) {
      ctx.addIssue({ code: "custom", path: ["lng"], message: "lng must be between -180 and 180." });
    }
  })
  .transform((value): GeocodeQuery => {
    if (value.q !== undefined && value.q.trim() !== "") {
      return { mode: "search", query: value.q };
    }
    return {
      mode: "reverse",
      coordinates: { lat: Number(value.lat), lng: Number(value.lng) },
    };
  });

/**
 * The two ways an upstream lookup can decline, mapped to the registered codes.
 * `throttled` is 429 rather than 503 because it is our own global limiter
 * saying "not this second", and the honest instruction is to retry shortly.
 */
function upstreamError(reason: GeocodeFailure): ApiError {
  if (reason === "throttled") {
    return new ApiError(
      429,
      API_ERROR_CODES.RATE_LIMITED,
      "Address lookup is busy. Try again in a second.",
      undefined,
      { "Retry-After": "1" },
    );
  }

  return new ApiError(
    503,
    API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
    "Address lookup is unavailable right now. You can still drag the pin on the map.",
  );
}

export const GET = defineHandler<
  GeocodeResponse,
  undefined,
  Record<string, string>,
  GeocodeQuery,
  true
>({
  route: "geocode",
  requireSession: true,
  querySchema: geocodeQuerySchema,
  rateLimit: { limit: GEOCODE_RATE_LIMIT, windowSeconds: GEOCODE_RATE_LIMIT_WINDOW_SECONDS },
  handler: async ({ query }) => {
    if (query.mode === "search") {
      const outcome = await searchAddress(query.query);
      if (!outcome.ok) throw upstreamError(outcome.reason);

      return {
        data: { results: outcome.data, address: null },
        // Doc 13: authenticated GETs are private and uncached by default. The
        // saving a browser cache would win here is already won upstream - every
        // lookup is memoised in Redis for 24h - so there is no reason to weaken
        // the default.
        headers: { "Cache-Control": "private, no-store" },
      };
    }

    const outcome = await reverseGeocode({
      lat: roundCoordinate(query.coordinates.lat),
      lng: roundCoordinate(query.coordinates.lng),
    });
    if (!outcome.ok) throw upstreamError(outcome.reason);

    return {
      data: { results: [], address: outcome.data },
      headers: { "Cache-Control": "private, no-store" },
    };
  },
});
