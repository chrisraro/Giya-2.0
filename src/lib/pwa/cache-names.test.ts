import { describe, expect, it } from "vitest";

import { CACHE_CLASSES, GIYA_CACHE_PREFIX, cacheName, isStaleGiyaCache } from "./cache-names";

// "CACHES ARE VERSIONED AND PURGED ON DEPLOY" (doc 41 sections 1, 7, 8).
//
// Every cache name embeds the build id, so a deploy cannot leave a stale shell
// reachable: the new worker's names simply do not collide with the old one's,
// and on `activate` it deletes everything that carries a different id.
//
// The delete step is the one with teeth, and it has to be narrow twice over.
// Too narrow and old shells survive a deploy, which is the bug the versioning
// exists to prevent. Too wide and it eats Serwist's own precache on every
// activate, turning each launch into a full refetch of the app shell on a
// connection this whole module exists to be kind to.

const BUILD = "5aaf2ff";

describe("cacheName", () => {
  it("names each cache class giya-{class}-{buildId}", () => {
    // Literals on the right. The format is a contract with the purge below and
    // with doc 41 section 7, not an implementation detail to be re-derived.
    expect(cacheName("pages", "5aaf2ff")).toBe("giya-pages-5aaf2ff");
    expect(cacheName("static", "5aaf2ff")).toBe("giya-static-5aaf2ff");
    expect(cacheName("images", "5aaf2ff")).toBe("giya-images-5aaf2ff");
    expect(cacheName("public-api", "5aaf2ff")).toBe("giya-public-api-5aaf2ff");
  });

  it("declares the four cache classes this task registers a route for", () => {
    // Not five: doc 41's `me` row is tagged [V1] and belongs to T5.3, which
    // adds "me" here along with the per-user suffix it needs.
    expect([...CACHE_CLASSES]).toEqual(["pages", "static", "images", "public-api"]);
  });

  it("exports the prefix the purge matches on", () => {
    expect(GIYA_CACHE_PREFIX).toBe("giya-");
  });

  it("refuses an empty build id rather than minting an unversioned cache", () => {
    // `giya-pages-` would be a name every deploy agrees on, which is exactly
    // the stale-shell failure the build id exists to make impossible. Failing
    // the build is better than shipping a worker that can never rotate.
    expect(() => cacheName("pages", "")).toThrow(/build id/i);
  });
});

describe("isStaleGiyaCache", () => {
  it("marks a cache from a previous build stale", () => {
    expect(isStaleGiyaCache("giya-pages-49967d3", BUILD)).toBe(true);
    expect(isStaleGiyaCache("giya-images-49967d3", BUILD)).toBe(true);
  });

  it("leaves this build's own caches alone", () => {
    expect(isStaleGiyaCache("giya-pages-5aaf2ff", BUILD)).toBe(false);
    expect(isStaleGiyaCache("giya-public-api-5aaf2ff", BUILD)).toBe(false);
  });

  it("CRITICAL: leaves Serwist's precache alone", () => {
    // The precache holds the app shell and `/offline`. Deleting it on every
    // activate would refetch several megabytes on a connection this module
    // exists to spare, and would leave the offline fallback missing in the
    // window before the refetch lands.
    expect(isStaleGiyaCache("serwist-precache-v2-https://giya.ph/", BUILD)).toBe(false);
    expect(isStaleGiyaCache("workbox-runtime", BUILD)).toBe(false);
    expect(isStaleGiyaCache("supabase-auth-token", BUILD)).toBe(false);
  });

  it("keeps T5.3's per-user me-cache, which carries the build id mid-name", () => {
    // doc 41 section 1: `giya-me-{buildId}-{userIdHash}`. The build id is not a
    // suffix there, so a suffix test would delete a live user's wallet cache on
    // every activate.
    expect(isStaleGiyaCache("giya-me-5aaf2ff-9f2c1a", BUILD)).toBe(false);
    expect(isStaleGiyaCache("giya-me-49967d3-9f2c1a", BUILD)).toBe(true);
  });

  it("does not mistake a longer build id for this one", () => {
    // "5aaf2ff" is a prefix of "5aaf2ffab". A substring test would let the
    // older build's shell survive the deploy that replaced it.
    expect(isStaleGiyaCache("giya-pages-5aaf2ffab", BUILD)).toBe(true);
  });

  it("treats every giya cache as stale when the build id is missing", () => {
    // An empty build id means the worker was built wrong. Purging costs a
    // refetch; keeping costs a shell nobody can rotate. Doc 41 section 8 says
    // every cache is safe to lose, so we lose them.
    expect(isStaleGiyaCache("giya-pages-5aaf2ff", "")).toBe(true);
    expect(isStaleGiyaCache("serwist-precache-v2-https://giya.ph/", "")).toBe(false);
  });
});
