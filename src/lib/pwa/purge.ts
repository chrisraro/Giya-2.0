import { GIYA_CACHE_PREFIX } from "./cache-names";

/**
 * The logout purge (doc 41 preamble rule 2, section 8).
 *
 * Doc 41's preamble states two non-negotiable rules, the second being that
 * caches are versioned and purged ON DEPLOY AND ON LOGOUT. T5.1 shipped only
 * the deploy half (`isStaleGiyaCache`, run at `activate`). This is the other
 * half, and it exists because of one live data-exposure bug:
 *
 *   Consumer A logs out on a shared phone. Consumer B signs in. B opens /home
 *   on a slow link, the pages route's 3-second NetworkFirst timeout fires, and
 *   the worker serves A's document - A's name, A's points balance.
 *
 * WHY `giya-pages-*` IS ON THIS LIST WHEN DOC 41 SECTION 8 DOES NOT NAME IT.
 * READ THIS BEFORE "CORRECTING" IT BACK TO THE SPEC'S LITERAL LIST.
 *
 * Section 8's purge order names only `giya-me-*`, a per-user API cache that was
 * deferred and never shipped. That list was written for an architecture where
 * pages are shells and user data arrives over `/api/v1/me/*`. Giya's consumer
 * pages are RSC server components with `export const dynamic = "force-dynamic"`:
 * the name, the balance and the claims are IN THE HTML DOCUMENT, and that
 * document is what the pages cache holds. On this architecture the pages cache
 * IS a cache holding authenticated data, so the RULE covers it even though the
 * LIST does not. Following the list instead of the rule leaves the only cache
 * that actually holds user data untouched.
 *
 * `giya-me-*` is kept on the list anyway. It costs one prefix, and the day
 * somebody builds doc 41 section 4's me-cache, the purge that has to cover it
 * already does.
 *
 * WHAT IS DELIBERATELY NOT PURGED. `giya-static-*` (content-hashed chunks and
 * fonts), `giya-images-*` (public-bucket images only - see ./buckets.ts) and
 * `giya-public-api-*` (`businesses`, `cms`, `banners`, none of it scoped to a
 * person) hold nothing about anyone. Nor is Serwist's own precache, which is
 * several megabytes of app shell plus the `/offline` document; eating it on
 * every logout would make the next sign-in re-download the app on exactly the
 * connections this module exists to spare.
 */

/**
 * Cache-class prefixes whose contents are scoped to the signed-in consumer.
 *
 * Whole class names, each ending in the `-` that separates class from build id,
 * so a future `giya-pagesmith-*` or `giya-metrics-*` is not swept in.
 */
export const AUTHENTICATED_CACHE_PREFIXES = [
  `${GIYA_CACHE_PREFIX}me-`,
  `${GIYA_CACHE_PREFIX}pages-`,
] as const;

/** True for a cache whose contents belong to whoever was signed in. */
export function holdsAuthenticatedData(name: string): boolean {
  return AUTHENTICATED_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * The slice of `CacheStorage` this module touches.
 *
 * Structural, so a real `caches` satisfies it, and narrow enough that nothing
 * here can reach `open()` and start reading documents it has no business
 * reading.
 */
export type PurgeableCacheStorage = {
  keys(): Promise<readonly string[]>;
  delete(name: string): Promise<boolean>;
};

/**
 * Deletes every cache holding authenticated data. Never rejects.
 *
 * NEVER REJECTING IS THE POINT, not politeness. This runs on the way out of a
 * session: on an insecure origin, in a Safari private window, or with site data
 * blocked, `caches` is absent or throws. A logout that failed because a cache
 * could not be cleared would strand the consumer signed in, which is strictly
 * worse than the exposure being fixed.
 *
 * Deletions are settled individually rather than through `Promise.all`, so one
 * cache that refuses to go (held open by another client) cannot cancel the
 * others - including the current build's pages cache, which is the one the next
 * consumer's navigation would actually match.
 *
 * @returns the names actually removed, for callers that want to log it. `[]`
 *   covers "nothing to remove", "no Cache Storage" and "storage threw" alike;
 *   no caller may treat the answer as a precondition for anything.
 */
export async function purgeUserCaches(
  storage: PurgeableCacheStorage | undefined | null,
): Promise<readonly string[]> {
  // `storage?.keys()` rather than an early `if (storage == null) return []`.
  // That guard was written first and a mutant deleted it with nothing turning
  // red: `undefined.keys()` throws INSIDE the try below, which returns [] for
  // its own reasons, so the guard was unobservable - dead code wearing a
  // comment about Safari private windows. The absent case is now handled by the
  // `names === undefined` check, whose removal really does break the no-Cache-
  // Storage test, because `.filter` on undefined throws outside the try.
  let names: readonly string[] | undefined;
  try {
    names = await storage?.keys();
  } catch {
    return [];
  }
  if (names === undefined) return [];

  const doomed = names.filter(holdsAuthenticatedData);
  const settled = await Promise.allSettled(doomed.map((name) => storage.delete(name)));

  return doomed.filter((_, index) => {
    const outcome = settled[index];
    return outcome !== undefined && outcome.status === "fulfilled" && outcome.value !== false;
  });
}
