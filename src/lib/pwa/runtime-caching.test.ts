import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  StaleWhileRevalidate,
  type RouteMatchCallback,
  type RuntimeCaching,
  type Strategy,
} from "serwist";
import { describe, expect, it } from "vitest";

import { giyaRouteSpecs, matchGiyaRoute, toRuntimeCaching } from "./runtime-caching";

// THE RUNTIME CACHING REGISTRY (doc 41 section 1's table).
//
// One route per row, FIRST MATCH WINS, and the order is load-bearing rather
// than incidental - a navigation to an API path has to be handled as a document
// and not as an API GET, and only the order decides that.
//
// The most important row in the table is the one that is not there. Everything
// under `/api/v1/*` that is not `businesses`, `cms` or `banners` gets NO route,
// which makes it NetworkOnly by default. That silence is what keeps
// `/api/v1/me/*` - one consumer's points, receipts and notifications - out of
// Cache Storage on a device doc 41 tells us to treat as shared. It is asserted
// here explicitly, because a missing route is invisible in a code review and a
// new row added in the wrong place would take it away without touching a line
// anyone would think to look at.
//
// The registry is expressed as plain data and translated into Serwist objects
// separately, so the routing decisions can be tested as decisions - a jsdom
// `Request` cannot be given `mode: "navigate"` or `destination: "image"` at
// all, so testing these against real Request objects is not available.

const BUILD = "5aaf2ff";

const ORIGIN = "https://giya.ph";
const SUPABASE = "https://zlfxfzlnklqhajacngxf.supabase.co";

function match(
  href: string,
  request: { mode?: string; destination?: string } = {},
): string | null {
  const url = new URL(href);
  const spec = matchGiyaRoute(
    { url, sameOrigin: url.origin === ORIGIN, request },
    BUILD,
  );
  return spec === null ? null : spec.cacheName;
}

describe("route table order and coverage", () => {
  it("registers exactly the four rows this task owns, in doc 41's order", () => {
    expect(giyaRouteSpecs(BUILD).map((spec) => spec.cacheName)).toEqual([
      "giya-pages-5aaf2ff",
      "giya-static-5aaf2ff",
      "giya-images-5aaf2ff",
      "giya-public-api-5aaf2ff",
    ]);
  });

  it("sends navigations to the pages cache with a 3 second network timeout", () => {
    expect(match(`${ORIGIN}/wallet`, { mode: "navigate" })).toBe("giya-pages-5aaf2ff");
    expect(giyaRouteSpecs(BUILD)[0]?.networkTimeoutSeconds).toBe(3);
    expect(giyaRouteSpecs(BUILD)[0]?.strategy).toBe("NetworkFirst");
  });

  it("CRITICAL: a navigation wins over the API row, because order decides it", () => {
    // Both rows match this: it is a navigation AND it is /api/v1/businesses.
    // First match wins, so it is handled as a document. Reorder the table and
    // this silently becomes an API GET whose fallback is not /offline.
    expect(match(`${ORIGIN}/api/v1/businesses`, { mode: "navigate" })).toBe(
      "giya-pages-5aaf2ff",
    );
  });

  it("sends framework chunks and fonts to the static cache, stale-while-revalidate", () => {
    expect(match(`${ORIGIN}/_next/static/chunks/main-abc.js`)).toBe("giya-static-5aaf2ff");
    expect(match(`${ORIGIN}/_next/static/media/geist-x.woff2`, { destination: "font" })).toBe(
      "giya-static-5aaf2ff",
    );
    expect(match(`${ORIGIN}/fonts/custom.woff2`, { destination: "font" })).toBe(
      "giya-static-5aaf2ff",
    );
    expect(giyaRouteSpecs(BUILD)[1]?.strategy).toBe("StaleWhileRevalidate");
  });

  it("sends public-bucket images to the image cache, cache-first", () => {
    expect(
      match(`${SUPABASE}/storage/v1/object/public/products/a1b2/photo.jpg`, {
        destination: "image",
      }),
    ).toBe("giya-images-5aaf2ff");
    expect(giyaRouteSpecs(BUILD)[2]?.strategy).toBe("CacheFirst");
  });

  it("sends the three public API collections to the public-api cache", () => {
    expect(match(`${ORIGIN}/api/v1/businesses?city=cebu`)).toBe("giya-public-api-5aaf2ff");
    expect(match(`${ORIGIN}/api/v1/cms/pages/terms`)).toBe("giya-public-api-5aaf2ff");
    expect(match(`${ORIGIN}/api/v1/banners`)).toBe("giya-public-api-5aaf2ff");
    expect(giyaRouteSpecs(BUILD)[3]?.strategy).toBe("NetworkFirst");
  });
});

describe("what deliberately gets no route, and is therefore NetworkOnly", () => {
  it("CRITICAL: own-user API GETs are not cached - that is T5.3's me-cache", () => {
    // doc 41 tags the me-cache [V1] and gives it a per-user cache NAME so one
    // user's balances can never be served to the next person to log in on the
    // same phone. Until that machinery exists, the safe interim state is no
    // route at all. A row added here without the per-user name would put one
    // consumer's points in a cache the next consumer reads.
    expect(match(`${ORIGIN}/api/v1/me/points`)).toBeNull();
    expect(match(`${ORIGIN}/api/v1/me/receipts`)).toBeNull();
    expect(match(`${ORIGIN}/api/v1/me/notifications?unread=1`)).toBeNull();
    expect(match(`${ORIGIN}/api/v1/me/loyalty-cards`)).toBeNull();
  });

  it("CRITICAL: no other API path is cached either", () => {
    expect(match(`${ORIGIN}/api/v1/receipts`)).toBeNull();
    expect(match(`${ORIGIN}/api/v1/ai/chat`)).toBeNull();
    expect(match(`${ORIGIN}/api/v1/rewards/claims`)).toBeNull();
    expect(match(`${ORIGIN}/api/v1/health`)).toBeNull();
  });

  it("CRITICAL: a signed receipt image gets no route", () => {
    // The image row's matcher is `destination === 'image' && isPublicBucket`.
    // This is the half that the second condition carries, restated at the
    // routing layer so the two cannot be decoupled by an edit to either one.
    expect(
      match(
        `${SUPABASE}/storage/v1/object/sign/receipts/1111/9f2c.jpg?token=eyJhbGciOiJIUzI1NiJ9.abc`,
        { destination: "image" },
      ),
    ).toBeNull();
    expect(
      match(
        `${SUPABASE}/storage/v1/object/sign/business-documents/7b3e/permit.jpg?token=eyJhbGciOiJIUzI1NiJ9.abc`,
        { destination: "image" },
      ),
    ).toBeNull();
  });

  it("does not cache a public-bucket URL fetched as something other than an image", () => {
    // Same URL, no image destination: a fetch() for the bytes is not the
    // browser painting an <img>, and only the latter is what the LRU is sized
    // for.
    expect(match(`${SUPABASE}/storage/v1/object/public/products/a1b2/photo.jpg`)).toBeNull();
  });

  it("CRITICAL: merchant and admin documents are never written to the pages cache", () => {
    // Doc 41 section 1 row 1 is "consumer route navigations", and the preamble
    // excludes the portals from SW scope entirely.
    //
    // Mounting the registration component only in the consumer layout does NOT
    // bound this. Scope is a property of `register(url, {scope})`, and the scope
    // is "/" - it has to be, because the `/offline` fallback must answer a
    // navigation to any URL. Combined with `clientsClaim`, one consumer page
    // registering puts every navigation on the origin through this worker,
    // including a merchant's. Without this clause, NetworkFirst writes
    // /business/dashboard into giya-pages-{buildId}, and on the >3s connection
    // this whole module exists for, a merchant validating a redemption is shown
    // a stale tenant document. The matcher is the only thing that can prevent
    // it.
    expect(match(`${ORIGIN}/business/dashboard`, { mode: "navigate" })).toBeNull();
    expect(match(`${ORIGIN}/business/receipts/9f2c`, { mode: "navigate" })).toBeNull();
    expect(match(`${ORIGIN}/business/login`, { mode: "navigate" })).toBeNull();
    expect(match(`${ORIGIN}/business`, { mode: "navigate" })).toBeNull();
    expect(match(`${ORIGIN}/admin/receipts`, { mode: "navigate" })).toBeNull();
    expect(match(`${ORIGIN}/admin`, { mode: "navigate" })).toBeNull();
  });

  it("still caches consumer routes whose names merely start like a portal one", () => {
    // The exclusion is on whole path segments. `/businesses` is the public
    // directory a consumer browses, and losing its offline fallback to a prefix
    // match would be a silent regression in the opposite direction.
    expect(match(`${ORIGIN}/businesses`, { mode: "navigate" })).toBe("giya-pages-5aaf2ff");
    expect(match(`${ORIGIN}/administration-guide`, { mode: "navigate" })).toBe(
      "giya-pages-5aaf2ff",
    );
  });

  it("CRITICAL: a cross-origin API path is not treated as ours", () => {
    // `https://evil.example/api/v1/businesses` matches the path pattern and
    // nothing else. Without the same-origin condition it lands in the cache our
    // own pages read from.
    expect(match("https://evil.example/api/v1/businesses")).toBeNull();
    expect(match("https://evil.example/_next/static/chunks/main.js")).toBeNull();
  });

  it("does not route a plain same-origin document fetch that is not a navigation", () => {
    expect(match(`${ORIGIN}/wallet`)).toBeNull();
  });
});

describe("cache configuration doc 41 section 1 specifies", () => {
  it("caps the image cache at 200 entries for 7 days and sacrifices it under quota pressure", () => {
    // Literals: 604800 is seven days. Doc 41 section 8 budgets this cache at
    // ~40MB and says images are what gets sacrificed first when storage runs
    // out, which is what purgeOnQuotaError buys.
    expect(giyaRouteSpecs(BUILD)[2]?.expiration).toEqual({
      maxEntries: 200,
      maxAgeSeconds: 604800,
      purgeOnQuotaError: true,
    });
  });

  it("caps the public API cache at 50 entries for 10 minutes", () => {
    expect(giyaRouteSpecs(BUILD)[3]?.expiration).toEqual({
      maxEntries: 50,
      maxAgeSeconds: 600,
    });
  });
});

describe("translation into Serwist strategies", () => {
  const runtimeCaching = toRuntimeCaching(giyaRouteSpecs(BUILD));

  /** `handler` is `Strategy | RouteHandlerCallback` in Serwist's types; ours is
   *  always the former, and that is itself part of what is asserted. */
  function strategyOf(route: RuntimeCaching | undefined): Strategy {
    const handler = route?.handler;
    if (typeof handler !== "object") throw new Error("expected a Strategy instance");
    return handler as Strategy;
  }

  /** The matcher's argument names `ExtendableEvent`, which lives in TS's
   *  webworker lib and is not in this project's `lib`. Derived from the
   *  callback's own signature instead of written out. */
  type MatchArgs = Parameters<RouteMatchCallback>[0];

  function matches(route: RuntimeCaching | undefined, url: URL): unknown {
    const matcher = route?.matcher;
    if (typeof matcher !== "function") throw new Error("expected a matcher function");
    return matcher({ url, sameOrigin: false, request: { destination: "image" } } as MatchArgs);
  }

  it("produces one Serwist route per row, with the strategy each row names", () => {
    expect(runtimeCaching).toHaveLength(4);
    expect(strategyOf(runtimeCaching[0])).toBeInstanceOf(NetworkFirst);
    expect(strategyOf(runtimeCaching[1])).toBeInstanceOf(StaleWhileRevalidate);
    expect(strategyOf(runtimeCaching[2])).toBeInstanceOf(CacheFirst);
    expect(strategyOf(runtimeCaching[3])).toBeInstanceOf(NetworkFirst);
  });

  it("carries the build-id cache name onto the strategy that writes it", () => {
    expect(runtimeCaching.map((route) => strategyOf(route).cacheName)).toEqual([
      "giya-pages-5aaf2ff",
      "giya-static-5aaf2ff",
      "giya-images-5aaf2ff",
      "giya-public-api-5aaf2ff",
    ]);
  });

  it("CRITICAL: the expiration numbers reach the plugin that enforces them", () => {
    // `_config` is Serwist's private field, reached into deliberately. The
    // alternative is asserting the numbers on our own data structure and never
    // proving they were handed to anything - which is exactly how a cache with
    // no LRU at all would pass a test suite.
    const configOf = (route: RuntimeCaching | undefined): Record<string, unknown> | undefined =>
      (
        strategyOf(route).plugins.find((plugin) => plugin instanceof ExpirationPlugin) as
          | { _config?: Record<string, unknown> }
          | undefined
      )?._config;

    expect(configOf(runtimeCaching[2])).toMatchObject({
      maxEntries: 200,
      maxAgeSeconds: 604800,
      purgeOnQuotaError: true,
    });
    expect(configOf(runtimeCaching[3])).toMatchObject({ maxEntries: 50, maxAgeSeconds: 600 });
  });

  it("keeps the routing decision intact through the translation", () => {
    // The Serwist matcher takes the same shape the spec's does; this proves the
    // adapter forwards rather than reinterprets.
    expect(
      matches(
        runtimeCaching[2],
        new URL(`${SUPABASE}/storage/v1/object/public/products/a1b2/photo.jpg`),
      ),
    ).toBe(true);
    expect(
      matches(
        runtimeCaching[2],
        new URL(`${SUPABASE}/storage/v1/object/sign/receipts/1111/9f2c.jpg?token=abc`),
      ),
    ).toBe(false);
  });
});
