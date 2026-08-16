/**
 * Cache naming and the deploy purge (doc 41 sections 1, 7 and 8).
 *
 * Every runtime cache is named `giya-{class}-{buildId}`. A deploy changes the
 * build id, so the new worker's caches cannot collide with the old worker's,
 * and on `activate` it deletes every `giya-` cache carrying a different id.
 * That is the mechanism behind "caches are versioned and purged on deploy".
 *
 * The purge has to be narrow in both directions. Too narrow and a stale shell
 * survives the deploy meant to replace it. Too wide and it eats Serwist's own
 * precache - several megabytes of app shell plus the `/offline` document -
 * every single activate, on the exact connections this module exists to spare.
 * Hence the `giya-` prefix: our caches, and only ours.
 */

/**
 * The cache classes this task registers a route for. Doc 41's `me` row is
 * tagged [V1] and belongs to T5.3, which adds "me" here together with the
 * per-user name suffix it needs.
 */
export const CACHE_CLASSES = ["pages", "static", "images", "public-api"] as const;

export type CacheClass = (typeof CACHE_CLASSES)[number];

/** Everything this app owns in Cache Storage starts with this. */
export const GIYA_CACHE_PREFIX = "giya-";

/** `giya-{class}-{buildId}` (doc 41 section 1). */
export function cacheName(cacheClass: CacheClass, buildId: string): string {
  if (buildId.length === 0) {
    // `giya-pages-` is a name every build would agree on, which is precisely
    // the stale-shell failure the build id exists to make impossible. Better to
    // fail the build than to ship a worker whose caches can never rotate.
    throw new Error("cacheName: build id is empty; caches would never rotate on deploy");
  }
  return `${GIYA_CACHE_PREFIX}${cacheClass}-${buildId}`;
}

/**
 * True for a cache this app owns that belongs to some OTHER build - the set the
 * new worker deletes on `activate`.
 *
 * The build id must appear as a whole dash-delimited run, not merely as a
 * substring, so `giya-pages-5aaf2ffab` is not mistaken for build `5aaf2ff`.
 * It is matched anywhere in the name rather than only at the end, because
 * T5.3's per-user cache is `giya-me-{buildId}-{userIdHash}` and the id sits in
 * the middle there.
 */
export function isStaleGiyaCache(name: string, buildId: string): boolean {
  if (!name.startsWith(GIYA_CACHE_PREFIX)) return false;
  if (buildId.length === 0) return true;
  return !carriesBuildId(name, buildId);
}

function carriesBuildId(name: string, buildId: string): boolean {
  const needle = `-${buildId}`;
  let at = name.indexOf(needle);
  while (at !== -1) {
    const after = name.charAt(at + needle.length);
    if (after === "" || after === "-") return true;
    at = name.indexOf(needle, at + 1);
  }
  return false;
}
