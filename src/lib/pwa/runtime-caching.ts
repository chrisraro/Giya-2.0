import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  StaleWhileRevalidate,
  type RuntimeCaching,
  type Strategy,
} from "serwist";

import { isPublicBucket } from "./buckets";
import { cacheName } from "./cache-names";

/**
 * The runtime caching registry - doc 41 section 1's table, one route per row.
 *
 * FIRST MATCH WINS and the order is load-bearing. A navigation to an API path
 * has to be served as a document with the `/offline` fallback behind it, not as
 * an API GET, and nothing but the order decides that.
 *
 * THE ROW THAT IS NOT HERE IS THE IMPORTANT ONE. Everything under `/api/v1/*`
 * other than `businesses`, `cms` and `banners` gets no route, which makes it
 * NetworkOnly by default. That is what keeps `/api/v1/me/*` - one consumer's
 * points, receipts and notifications - out of Cache Storage. Doc 41's me-cache
 * row is tagged [V1] and comes with a per-user cache name so a second person
 * logging in on the same phone cannot be served the first one's balances; until
 * that machinery lands in T5.3, no route is the only safe state.
 *
 * The registry is plain data, translated into Serwist objects by
 * `toRuntimeCaching` at the bottom. That split is not decoration: a `Request`
 * cannot be constructed with `mode: "navigate"`, and `destination` is read-only
 * and always `""` on a constructed one, so routing decisions are untestable
 * against real Request objects. Expressed as data they are testable as
 * decisions, which for the image row in particular is the difference between
 * checking a security boundary and hoping.
 */

/** What a route matcher needs to see. A structural subset of Serwist's own
 *  `RouteMatchCallbackOptions`, so a real `Request` satisfies it. */
export type GiyaRouteInput = {
  readonly url: URL;
  readonly sameOrigin: boolean;
  readonly request: { readonly mode?: string; readonly destination?: string };
};

export type GiyaStrategyName = "NetworkFirst" | "StaleWhileRevalidate" | "CacheFirst";

export type GiyaExpiration = {
  readonly maxEntries?: number;
  readonly maxAgeSeconds?: number;
  readonly purgeOnQuotaError?: boolean;
};

export type GiyaRouteSpec = {
  readonly cacheName: string;
  readonly strategy: GiyaStrategyName;
  readonly matches: (input: GiyaRouteInput) => boolean;
  readonly networkTimeoutSeconds?: number;
  readonly expiration?: GiyaExpiration;
};

/** `businesses`, `cms` and `banners` only, and only as whole path segments, so
 *  a future `/api/v1/businesses-admin` is not swept in by a prefix match. */
const PUBLIC_API_PATH = /^\/api\/v1\/(?:businesses|cms|banners)(?:\/|$)/;

/** Self-hosted font files, for the case where they are not under /_next/static. */
const FONT_FILE = /\.(?:woff2?|ttf|otf|eot)$/;

export function giyaRouteSpecs(buildId: string): readonly GiyaRouteSpec[] {
  return [
    // 1. Documents. NetworkFirst with a 3s timeout: an RSC page is server
    //    rendered, so the cache is a fallback for a dead connection rather than
    //    the primary path (doc 41's decision log). The `/offline` fallback is
    //    attached by the Serwist `fallbacks` option in sw.ts.
    {
      cacheName: cacheName("pages", buildId),
      strategy: "NetworkFirst",
      networkTimeoutSeconds: 3,
      matches: ({ sameOrigin, request }) => sameOrigin && request.mode === "navigate",
    },
    // 2. Framework chunks and fonts. Content-hashed already, so
    //    StaleWhileRevalidate costs nothing and removes them from the critical
    //    path on a slow connection.
    {
      cacheName: cacheName("static", buildId),
      strategy: "StaleWhileRevalidate",
      matches: ({ url, sameOrigin, request }) =>
        sameOrigin &&
        (url.pathname.startsWith("/_next/static/") ||
          request.destination === "font" ||
          FONT_FILE.test(url.pathname)),
    },
    // 3. Images from PUBLIC buckets only. `isPublicBucket` is the security
    //    boundary here - see buckets.ts. Cross-origin by nature: these are
    //    served from Supabase Storage.
    {
      cacheName: cacheName("images", buildId),
      strategy: "CacheFirst",
      expiration: { maxEntries: 200, maxAgeSeconds: 604800, purgeOnQuotaError: true },
      matches: ({ url, request }) => request.destination === "image" && isPublicBucket(url),
    },
    // 4. Public API collections. Mirrors the server's own
    //    `s-maxage=60, stale-while-revalidate=300` policy; nothing here is
    //    scoped to a user.
    {
      cacheName: cacheName("public-api", buildId),
      strategy: "NetworkFirst",
      expiration: { maxEntries: 50, maxAgeSeconds: 600 },
      matches: ({ url, sameOrigin }) => sameOrigin && PUBLIC_API_PATH.test(url.pathname),
    },
  ];
}

/** The first row that matches, or `null` for "no route" - i.e. NetworkOnly. */
export function matchGiyaRoute(input: GiyaRouteInput, buildId: string): GiyaRouteSpec | null {
  return giyaRouteSpecs(buildId).find((spec) => spec.matches(input)) ?? null;
}

/** The same registry as Serwist's `runtimeCaching` option. */
export function toRuntimeCaching(specs: readonly GiyaRouteSpec[]): RuntimeCaching[] {
  return specs.map((spec) => ({
    matcher: ({ url, request, sameOrigin }) => spec.matches({ url, sameOrigin, request }),
    handler: strategyFor(spec),
  }));
}

function strategyFor(spec: GiyaRouteSpec): Strategy {
  const options = {
    cacheName: spec.cacheName,
    plugins: spec.expiration ? [new ExpirationPlugin(spec.expiration)] : [],
  };

  switch (spec.strategy) {
    case "NetworkFirst":
      return new NetworkFirst({ ...options, networkTimeoutSeconds: spec.networkTimeoutSeconds });
    case "StaleWhileRevalidate":
      return new StaleWhileRevalidate(options);
    case "CacheFirst":
      return new CacheFirst(options);
  }
}
