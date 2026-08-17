/**
 * Which media URLs the service worker is allowed to put on disk.
 *
 * This is a security boundary, not a convenience. The image route in
 * `runtime-caching.ts` is CacheFirst with a seven-day TTL, so a URL that passes
 * this predicate is written to `giya-images-{buildId}` and served from there
 * without a network check for a week - on a device doc 41 section 1 tells us to
 * treat as shared by default.
 *
 * Supabase's `receipts` and `business-documents` buckets are private
 * (`supabase/migrations/0019_receipts_storage.sql` sets `public=false`) and are
 * read through `createSignedUrl` with a five-minute TTL. The expiry IS the
 * access control: caching those bytes keeps them readable long after the
 * signature that authorised them stopped working. Doc 41 requires this
 * exclusion be "enforced by a unit test on the matcher, not by convention" -
 * see `buckets.test.ts`.
 *
 * The predicate is therefore an ALLOWLIST. A bucket created in Supabase later
 * is not cached until someone adds it here deliberately, so the failure mode of
 * forgetting is "this image is fetched from the network every time", never "a
 * receipt is on disk".
 */

/** The public buckets doc 41 section 1 names. Order is the doc's order. */
export const PUBLIC_MEDIA_BUCKETS = [
  "products",
  "promotions",
  "rewards",
  "menus",
  "avatars",
  "announcements",
] as const;

export type PublicMediaBucket = (typeof PUBLIC_MEDIA_BUCKETS)[number];

/**
 * The two path shapes Supabase serves unsigned public objects under: the plain
 * object endpoint and the image-transformation endpoint. Both carry the bucket
 * as the segment straight after the prefix.
 */
const PUBLIC_OBJECT_PREFIXES = [
  "/storage/v1/object/public/",
  "/storage/v1/render/image/public/",
] as const;

/** Next's image optimiser proxies a remote URL behind a same-origin path. */
const NEXT_IMAGE_PATHNAME = "/_next/image";

/**
 * The one origin whose storage paths mean anything to us.
 *
 * Derived from `NEXT_PUBLIC_SUPABASE_URL` rather than hardcoded, so a project
 * behind a custom storage domain stays cached and a project pointed at a
 * different Supabase instance cannot be cached by accident. Next inlines
 * `NEXT_PUBLIC_*` at build time, and next.config.ts substitutes this one into
 * the service worker bundle explicitly.
 *
 * WHY THE PATH ALLOWLIST IS NOT ENOUGH ON ITS OWN. Bucket names say which paths
 * are cacheable and nothing about whose server answers them, so without this,
 * `https://evil.example.com/storage/v1/object/public/avatars/x.jpg` is a
 * perfectly good cache key. Nothing of Giya's leaks - the attacker's bytes
 * cache under the attacker's URL - but any URL that reaches an `<img>` (a
 * merchant's banner field, a CMS row) can be pinned CacheFirst on a consumer's
 * phone for seven days with no revalidation, surviving moderation and takedown.
 *
 * The comparison is on the whole parsed ORIGIN, which is the only form that
 * survives the two shapes a string test loses to: a suffix match accepts
 * `project.supabase.co.evil.com`, and any check on raw text accepts
 * `https://project.supabase.co@evil.com/...`, which fetches from evil.com.
 */
function storageOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) return null;
  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

/**
 * True only for an unsigned object in one of the public buckets, on OUR
 * Supabase Storage origin, optionally wrapped once in a `/_next/image`
 * optimiser request.
 *
 * Accepts the `URL` a Serwist matcher is handed, or a string. A relative string
 * is refused: storage is never same-origin, so a relative path can never be one
 * of these objects, and refusing is the safe answer for input we cannot resolve.
 */
export function isPublicBucket(url: URL | string | null | undefined): boolean {
  return check(url, 1);
}

function check(url: URL | string | null | undefined, unwrapsLeft: number): boolean {
  const parsed = parse(url);
  if (!parsed) return false;

  // http(s) only. data:, blob: and friends are not fetched from storage and
  // must never be routed to a cache on the strength of their text.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;

  if (parsed.pathname === NEXT_IMAGE_PATHNAME) {
    // The outer URL is on our own origin and says nothing about what it wraps,
    // so the decision has to be made on the proxied URL. One unwrap only: that
    // is all next/image ever emits, and it bounds the recursion.
    if (unwrapsLeft <= 0) return false;
    const inner = parsed.searchParams.get("url");
    if (!inner) return false;
    return check(resolve(inner, parsed), unwrapsLeft - 1);
  }

  // Our storage, or nobody's. Fails closed when the URL is unconfigured: not
  // knowing whose server this is costs a refetch, and guessing costs a
  // seven-day pin of someone else's bytes.
  const allowed = storageOrigin();
  if (allowed === null || parsed.origin !== allowed) return false;

  // A `token` query is what `createSignedUrl` appends, and its presence means
  // the URL was minted with an expiry. Caching outlives the expiry, so refuse
  // regardless of which bucket it names.
  if (parsed.searchParams.has("token")) return false;

  const prefix = PUBLIC_OBJECT_PREFIXES.find((candidate) => parsed.pathname.startsWith(candidate));
  if (!prefix) return false;

  const rest = parsed.pathname.slice(prefix.length);
  const separator = rest.indexOf("/");
  // No separator means a bucket root with nothing after it; a leading separator
  // means an empty bucket name. Neither is an object.
  if (separator <= 0) return false;

  const bucket = safeDecode(rest.slice(0, separator));
  const object = rest.slice(separator + 1);
  if (object.length === 0) return false;

  return (PUBLIC_MEDIA_BUCKETS as readonly string[]).includes(bucket);
}

function parse(url: URL | string | null | undefined): URL | null {
  if (!url) return null;
  if (typeof url !== "string") return url;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function resolve(inner: string, outer: URL): URL | null {
  try {
    return new URL(inner, outer.origin);
  } catch {
    return null;
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
