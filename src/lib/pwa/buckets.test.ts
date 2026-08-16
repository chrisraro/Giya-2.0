import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_MEDIA_BUCKETS, isPublicBucket } from "./buckets";

// THE ONE PREDICATE THAT DECIDES WHAT LANDS ON DISK.
//
// The service worker's image route is CacheFirst: whatever this function says
// yes to is written into `giya-images-{buildId}` and served from there for up
// to seven days, on a device doc 41 tells us to treat as SHARED by default.
//
// Two Supabase buckets must never reach it. `receipts` holds photographs of
// people's purchases and `business-documents` holds merchant permits and IDs;
// both are private buckets reached through five-minute signed URLs
// (supabase/migrations/0019_receipts_storage.sql sets `receipts` public=false).
// A signed URL that gets cached outlives its own signature - the whole point of
// a 5-minute TTL is that the bytes stop being reachable, and a CacheFirst entry
// makes them reachable for a week to anyone who picks the phone up.
//
// Doc 41 section 1 says this exclusion is "enforced by a unit test on the
// matcher, not by convention". This file is that test. The predicate is an
// ALLOWLIST of the six public buckets, so a bucket added to Supabase later is
// excluded until someone edits this list on purpose - the failure mode of an
// omission is "an image is not cached", never "a receipt is".

const PROJECT = "https://zlfxfzlnklqhajacngxf.supabase.co";
const publicObject = (bucket: string, object = "a1b2/photo.jpg") =>
  `${PROJECT}/storage/v1/object/public/${bucket}/${object}`;
const signedObject = (bucket: string, object = "a1b2/photo.jpg") =>
  `${PROJECT}/storage/v1/object/sign/${bucket}/${object}?token=eyJhbGciOiJIUzI1NiJ9.signature`;

// The allowed origin is derived from NEXT_PUBLIC_SUPABASE_URL, which Next
// inlines at build time and next.config.ts also substitutes into the service
// worker bundle explicitly.
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROJECT);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isPublicBucket - private buckets", () => {
  it("CRITICAL: a signed receipts URL is not cacheable", () => {
    // The exact shape createSignedUrl() produces for a receipt photo. If this
    // ever returns true, every receipt a consumer views is written to disk for
    // seven days and survives the signature that was supposed to expire.
    expect(
      isPublicBucket(
        "https://zlfxfzlnklqhajacngxf.supabase.co/storage/v1/object/sign/receipts/11111111-1111-4111-8111-111111111111/9f2c.jpg?token=eyJhbGciOiJIUzI1NiJ9.abc",
      ),
    ).toBe(false);
  });

  it("CRITICAL: a signed business-documents URL is not cacheable", () => {
    expect(
      isPublicBucket(
        "https://zlfxfzlnklqhajacngxf.supabase.co/storage/v1/object/sign/business-documents/7b3e/permit.jpg?token=eyJhbGciOiJIUzI1NiJ9.abc",
      ),
    ).toBe(false);
  });

  it("CRITICAL: a receipts URL written in the PUBLIC path shape is still not cacheable", () => {
    // Belt and braces: the allowlist is on the bucket name, so even a URL that
    // claims the unsigned public shape for a private bucket is refused. This is
    // the case a "just exclude /object/sign/" implementation would let through.
    expect(isPublicBucket(publicObject("receipts"))).toBe(false);
    expect(isPublicBucket(publicObject("business-documents"))).toBe(false);
  });

  it("CRITICAL: a token-bearing URL is refused even on the public path, in a public bucket", () => {
    // The independent half of the defence. The allowlist alone already refuses
    // `/object/sign/...` because that prefix is not a public one - so this
    // asserts the OTHER guard, on the one shape the allowlist would wave
    // through: an unsigned public path carrying an expiring `token`. A `token`
    // query means the URL was minted with an expiry, and a CacheFirst entry
    // outlives the expiry whatever bucket it names.
    expect(
      isPublicBucket(
        `${PROJECT}/storage/v1/object/public/avatars/a1b2/photo.jpg?token=eyJhbGciOiJIUzI1NiJ9.abc`,
      ),
    ).toBe(false);
    // The /object/sign/ shape is refused too, by the allowlist above it.
    expect(isPublicBucket(signedObject("avatars"))).toBe(false);
  });

  it("CRITICAL: a signed receipts URL smuggled through next/image is not cacheable", () => {
    // /_next/image is a same-origin proxy: the URL the browser requests is on
    // giya.ph and says nothing about receipts until you decode `url`. A matcher
    // that looks only at the outer URL caches every optimized receipt.
    const inner = encodeURIComponent(signedObject("receipts"));
    expect(isPublicBucket(`https://giya.ph/_next/image?url=${inner}&w=640&q=75`)).toBe(false);
  });
});

describe("isPublicBucket - public buckets", () => {
  it("accepts an object in each of the six public buckets", () => {
    // Asserted against literals, not against PUBLIC_MEDIA_BUCKETS, so the list
    // and the expectation cannot agree by construction.
    for (const bucket of ["products", "promotions", "rewards", "menus", "avatars", "announcements"]) {
      expect(isPublicBucket(publicObject(bucket))).toBe(true);
    }
  });

  it("exports exactly the six public buckets doc 41 names", () => {
    expect([...PUBLIC_MEDIA_BUCKETS]).toEqual([
      "products",
      "promotions",
      "rewards",
      "menus",
      "avatars",
      "announcements",
    ]);
  });

  it("accepts a transformed (render/image) public URL", () => {
    expect(
      isPublicBucket(`${PROJECT}/storage/v1/render/image/public/avatars/a1b2/photo.jpg?width=96`),
    ).toBe(true);
  });

  it("accepts a public bucket object proxied through next/image", () => {
    const inner = encodeURIComponent(publicObject("products"));
    expect(isPublicBucket(`https://giya.ph/_next/image?url=${inner}&w=640&q=75`)).toBe(true);
  });

  it("accepts a URL object as well as a string, because Serwist matchers get URLs", () => {
    expect(isPublicBucket(new URL(publicObject("menus")))).toBe(true);
  });

  it("keeps a cache-busting query on a public URL cacheable", () => {
    expect(isPublicBucket(`${publicObject("avatars")}?t=1723800000`)).toBe(true);
  });
});

describe("isPublicBucket - the URL has to be OUR storage", () => {
  // The bucket allowlist says which PATHS are cacheable and says nothing about
  // whose server answers them. Without an origin check, anyone who can get a
  // URL in front of the app - a merchant filling in a banner image field, a CMS
  // field, a review body - can pin arbitrary bytes CacheFirst on a consumer's
  // device for seven days with no revalidation, outliving moderation or a
  // takedown. No Giya data leaks: the attacker's bytes cache under the
  // attacker's URL. What leaks is the app's storage budget and its ability to
  // ever stop showing that image.

  it("CRITICAL: refuses an unrelated origin serving the same path shape", () => {
    expect(
      isPublicBucket("https://evil.example.com/storage/v1/object/public/avatars/a1b2/photo.jpg"),
    ).toBe(false);
  });

  it("CRITICAL: refuses a lookalike host that BEGINS with our project host", () => {
    // "zlfxfzlnklqhajacngxf.supabase.co.evil.com" is evil.com. Any check done
    // with `includes` or `startsWith` on the host takes it.
    expect(
      isPublicBucket(
        "https://zlfxfzlnklqhajacngxf.supabase.co.evil.com/storage/v1/object/public/products/a1b2/photo.jpg",
      ),
    ).toBe(false);
  });

  it("CRITICAL: refuses a DIFFERENT Supabase project on the same domain", () => {
    // The one a `.supabase.co` suffix check waves straight through, and the
    // easiest attack of the lot: anyone can create a Supabase project, make a
    // bucket public, and hand us a URL that is genuinely hosted on
    // supabase.co. The comparison has to be the whole origin, project
    // subdomain included.
    expect(
      isPublicBucket("https://attacker.supabase.co/storage/v1/object/public/avatars/a1b2/photo.jpg"),
    ).toBe(false);
  });

  it("CRITICAL: refuses a userinfo prefix that reads like our host", () => {
    // `https://host@evil.com/...` fetches from evil.com. It is the oldest
    // phishing shape there is and it beats any check done on the raw string
    // rather than on the parsed origin.
    expect(
      isPublicBucket(
        "https://zlfxfzlnklqhajacngxf.supabase.co@evil.com/storage/v1/object/public/avatars/a1b2/photo.jpg",
      ),
    ).toBe(false);
  });

  it("CRITICAL: refuses plain http on our own host", () => {
    // The one place a whole-ORIGIN comparison differs from a host comparison,
    // and the reason to prefer it. Same host, same path, downgraded scheme: the
    // response is attacker-modifiable in transit, and CacheFirst would pin
    // whatever came back for seven days. `host.endsWith(ourHost)` accepts this.
    expect(
      isPublicBucket(
        "http://zlfxfzlnklqhajacngxf.supabase.co/storage/v1/object/public/avatars/a1b2/photo.jpg",
      ),
    ).toBe(false);
  });

  it("CRITICAL: refuses a hostile origin smuggled through next/image", () => {
    const inner = encodeURIComponent(
      "https://evil.example.com/storage/v1/object/public/avatars/a1b2/photo.jpg",
    );
    expect(isPublicBucket(`https://giya.ph/_next/image?url=${inner}&w=640`)).toBe(false);
  });

  it("CRITICAL: caches nothing at all when the storage URL is not configured", () => {
    // Fail closed. An unset NEXT_PUBLIC_SUPABASE_URL means we cannot say whose
    // server this is, and "cache nothing" costs a refetch while "cache
    // anything" is the whole problem above.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(isPublicBucket(publicObject("avatars"))).toBe(false);
  });

  it("keeps working when the storage URL is a custom domain", () => {
    // Derived from the env var rather than hardcoded to `.supabase.co`, so a
    // project behind its own storage hostname is not silently uncached.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://cdn.giya.ph");
    expect(
      isPublicBucket("https://cdn.giya.ph/storage/v1/object/public/products/a1b2/photo.jpg"),
    ).toBe(true);
    expect(isPublicBucket(publicObject("products"))).toBe(false);
  });
});

describe("isPublicBucket - refusals that are not about buckets", () => {
  it("refuses a bucket whose name merely starts with a public one", () => {
    expect(isPublicBucket(publicObject("avatarsx"))).toBe(false);
    expect(isPublicBucket(publicObject("rewards-private"))).toBe(false);
  });

  it("compares the bucket name after percent-decoding it", () => {
    // Decoding BEFORE the allowlist comparison is the safe direction: it is
    // what makes `%72eceipts` resolve to `receipts` and be refused, rather than
    // sailing past a list that only knows the literal spelling. The accepted
    // case is what proves the decode actually runs.
    expect(isPublicBucket(publicObject("%61vatars"))).toBe(true);
    expect(isPublicBucket(publicObject("%72eceipts"))).toBe(false);
  });

  it("refuses a malformed percent-escape instead of throwing on it", () => {
    // decodeURIComponent("%zz") throws a URIError. A matcher that throws takes
    // the worker's whole fetch handler down with it.
    expect(() => isPublicBucket(publicObject("%zz"))).not.toThrow();
    expect(isPublicBucket(publicObject("%zz"))).toBe(false);
  });

  it("refuses a bucket root with no object after it", () => {
    expect(isPublicBucket(`${PROJECT}/storage/v1/object/public/avatars/`)).toBe(false);
    expect(isPublicBucket(`${PROJECT}/storage/v1/object/public/avatars`)).toBe(false);
  });

  it("refuses anything that is not a Supabase storage object", () => {
    expect(isPublicBucket("https://lh3.googleusercontent.com/a/photo.jpg")).toBe(false);
    expect(isPublicBucket("https://giya.ph/brand/icon.png")).toBe(false);
    expect(isPublicBucket(`${PROJECT}/rest/v1/rewards?select=*`)).toBe(false);
  });

  it("refuses a next/image request with no url to unwrap, and refuses to unwrap twice", () => {
    expect(isPublicBucket("https://giya.ph/_next/image?w=640")).toBe(false);
    // One unwrap only. A nested wrap is not something next/image emits, so
    // treating it as unrecognised costs nothing and bounds the recursion.
    const once = encodeURIComponent(
      `https://giya.ph/_next/image?url=${encodeURIComponent(publicObject("products"))}`,
    );
    expect(isPublicBucket(`https://giya.ph/_next/image?url=${once}`)).toBe(false);
  });

  it("refuses a non-http scheme that carries a storage-looking path", () => {
    // `data:` is not a special scheme, so the WHATWG parser hands back
    // pathname "/storage/v1/object/public/avatars/a/b.jpg" verbatim - a prefix
    // check alone says yes to it. Only the scheme allowlist says no.
    expect(isPublicBucket("data:/storage/v1/object/public/avatars/a1b2/photo.jpg")).toBe(false);
    expect(isPublicBucket("blob:https://giya.ph/8b1c")).toBe(false);
  });

  it("refuses a relative path, because storage is never same-origin", () => {
    expect(isPublicBucket("/storage/v1/object/public/avatars/a1b2/photo.jpg")).toBe(false);
  });

  it("returns false rather than throwing on empty or absent input", () => {
    // A matcher that throws takes the whole fetch handler down with it.
    expect(isPublicBucket("")).toBe(false);
    expect(isPublicBucket(null)).toBe(false);
    expect(isPublicBucket(undefined)).toBe(false);
  });
});
