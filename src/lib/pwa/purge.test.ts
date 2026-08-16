import { describe, expect, it } from "vitest";

import { cacheName } from "./cache-names";
import { holdsAuthenticatedData, purgeUserCaches } from "./purge";

// THE LOGOUT PURGE (doc 41 preamble rule 2, section 8).
//
// WHAT THESE TESTS ASSERT, AND WHY IT IS NOT "delete() was called".
//
// jsdom has no Cache Storage, so there is no real store to run against. A fake
// that only records which names `delete()` was handed would prove the code
// calls what this test told it to call - the exact shape of assertion Wave 5
// has been paying for. So the fake below is a real (in-memory) store: it holds
// URL -> body entries, and every assertion here is about RETRIEVABILITY after
// the purge. "Consumer A's /home document can no longer be read out of Cache
// Storage" is the security property; "delete was called with giya-pages-b1" is
// a restatement of the implementation.
//
// What it still cannot prove is that a browser's real CacheStorage behaves like
// this one, or that the worker receives the message. Doc 41 section 11's
// Playwright `pwa-offline` project is where that belongs.

const BUILD = "b1";

/** The document that carries consumer A's name and balance in its HTML. */
const A_HOME_DOCUMENT = "<html>Hi Ana. 1,240 points.</html>";

/**
 * An in-memory Cache Storage that really stores and really serves.
 *
 * `match` searches every cache, the way `caches.match()` does, so a document
 * that survived in ANY cache is a hit - which is what makes the negative
 * assertions below mean "unreachable", not "unreachable through the one name I
 * happened to look under".
 */
class MemoryCacheStorage {
  readonly stores = new Map<string, Map<string, string>>();

  seed(name: string, url: string, body: string): this {
    const entries = this.stores.get(name) ?? new Map<string, string>();
    entries.set(url, body);
    this.stores.set(name, entries);
    return this;
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }

  match(url: string): Promise<string | undefined> {
    for (const entries of this.stores.values()) {
      const hit = entries.get(url);
      if (hit !== undefined) return Promise.resolve(hit);
    }
    return Promise.resolve(undefined);
  }
}

function seededStorage(): MemoryCacheStorage {
  return new MemoryCacheStorage()
    .seed(cacheName("pages", BUILD), "/home", A_HOME_DOCUMENT)
    .seed(cacheName("pages", BUILD), "/wallet", "<html>Ana's wallet</html>")
    // A cache left behind by an EARLIER build. The deploy purge only runs at
    // `activate`, so a logout can find one of these sitting there.
    .seed("giya-pages-b0", "/rewards", "<html>Ana's claims</html>")
    .seed(cacheName("static", BUILD), "/_next/static/chunk.js", "app shell")
    .seed(cacheName("images", BUILD), "https://cdn/logo.png", "logo bytes")
    .seed(cacheName("public-api", BUILD), "/api/v1/businesses", "[]")
    .seed("serwist-precache-v2-https://giya.ph/", "/offline", "<html>offline</html>");
}

describe("holdsAuthenticatedData (doc 41 preamble rule 2)", () => {
  it("covers the pages cache, because RSC documents ARE the user's data", () => {
    expect(holdsAuthenticatedData(cacheName("pages", BUILD))).toBe(true);
    expect(holdsAuthenticatedData("giya-pages-b0")).toBe(true);
  });

  it("covers the me cache doc 41 section 8 names, whether or not it ships", () => {
    expect(holdsAuthenticatedData("giya-me-b1")).toBe(true);
    expect(holdsAuthenticatedData("giya-me-b1-9f2c")).toBe(true);
  });

  it("leaves the caches that hold nothing about a person", () => {
    expect(holdsAuthenticatedData(cacheName("static", BUILD))).toBe(false);
    expect(holdsAuthenticatedData(cacheName("images", BUILD))).toBe(false);
    expect(holdsAuthenticatedData(cacheName("public-api", BUILD))).toBe(false);
  });

  it("leaves caches this app does not own", () => {
    expect(holdsAuthenticatedData("serwist-precache-v2-https://giya.ph/")).toBe(false);
    expect(holdsAuthenticatedData("workbox-precache")).toBe(false);
    expect(holdsAuthenticatedData("")).toBe(false);
  });

  it("matches whole class names, so a future giya-pagesmith- is not swept in", () => {
    expect(holdsAuthenticatedData("giya-pagesmith-b1")).toBe(false);
    expect(holdsAuthenticatedData("giya-metrics-b1")).toBe(false);
  });
});

describe("purgeUserCaches (doc 41 preamble rule 2, section 8)", () => {
  it("CRITICAL: the previous consumer's /home document is no longer retrievable", async () => {
    const storage = seededStorage();
    expect(await storage.match("/home")).toBe(A_HOME_DOCUMENT);

    await purgeUserCaches(storage);

    // The whole task, in one assertion. Not "delete was called" - the document
    // that names Ana and states her balance cannot be served to the next person
    // who signs in on this phone.
    expect(await storage.match("/home")).toBeUndefined();
    expect(await storage.match("/wallet")).toBeUndefined();
    // Including the one an older build wrote, which the deploy purge has not
    // reached yet.
    expect(await storage.match("/rewards")).toBeUndefined();
  });

  it("keeps the app shell, so logging out does not cost the next sign-in a re-download", async () => {
    const storage = seededStorage();

    await purgeUserCaches(storage);

    expect(await storage.match("/_next/static/chunk.js")).toBe("app shell");
    expect(await storage.match("https://cdn/logo.png")).toBe("logo bytes");
    expect(await storage.match("/api/v1/businesses")).toBe("[]");
  });

  it("keeps Serwist's precache, so /offline still answers a dead connection", async () => {
    const storage = seededStorage();

    await purgeUserCaches(storage);

    expect(await storage.match("/offline")).toBe("<html>offline</html>");
  });

  it("reports which caches it removed", async () => {
    const storage = seededStorage();

    expect([...(await purgeUserCaches(storage))].sort()).toEqual([
      "giya-pages-b0",
      "giya-pages-b1",
    ]);
  });

  it("CRITICAL: resolves on a browser with no Cache Storage rather than throwing", async () => {
    // Safari private windows and insecure origins. A logout that fails because
    // a cache could not be cleared is worse than the bug being fixed.
    await expect(purgeUserCaches(undefined)).resolves.toEqual([]);
  });

  it("CRITICAL: resolves when Cache Storage itself throws", async () => {
    const hostile = {
      keys: () => Promise.reject(new Error("storage blocked")),
      delete: () => Promise.resolve(true),
    };

    await expect(purgeUserCaches(hostile)).resolves.toEqual([]);
  });

  it("CRITICAL: resolves when one delete fails, and still removes the others", async () => {
    const storage = seededStorage();
    const partlyHostile = {
      keys: () => storage.keys(),
      delete: (name: string) =>
        name === "giya-pages-b0"
          ? Promise.reject(new Error("cache in use"))
          : storage.delete(name),
    };

    // One cache refusing to go must not cancel the others. `giya-pages-b1` is
    // the one the next consumer's navigation would actually have matched.
    await expect(purgeUserCaches(partlyHostile)).resolves.toEqual(["giya-pages-b1"]);
    expect(await storage.match("/home")).toBeUndefined();
    expect(await storage.match("/rewards")).toBe("<html>Ana's claims</html>");
  });
});
