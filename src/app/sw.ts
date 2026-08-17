import { Serwist, type PrecacheEntry } from "serwist";

import { isStaleGiyaCache } from "../lib/pwa/cache-names";
import { swMessageAction } from "../lib/pwa/messages";
import { giyaRouteSpecs, toRuntimeCaching } from "../lib/pwa/runtime-caching";

/**
 * The service worker (doc 41 sections 1, 7 and 8).
 *
 * This file is the only one in the repo that runs inside a
 * ServiceWorkerGlobalScope, and it is deliberately thin. Every decision it
 * makes - which URLs are cacheable, what the caches are called, which of them a
 * deploy deletes, what an inbound message means - lives in `src/lib/pwa/*`,
 * where it is testable in a normal test run. What is left here is wiring, and
 * wiring is the part `next build` proves.
 *
 * `__GIYA_BUILD_ID__` is substituted at build time by the DefinePlugin in
 * next.config.ts. It is what makes every cache name unique per deploy
 * (doc 41 section 7 step 1).
 */
declare const __GIYA_BUILD_ID__: string;

/**
 * The slice of `ServiceWorkerGlobalScope` this file touches.
 *
 * Declared locally rather than by adding "webworker" to tsconfig's `lib`, which
 * would merge the worker globals into every DOM file in the app and start a
 * fight between two definitions of half the platform.
 */
type ServiceWorkerScope = {
  /** Injected by @serwist/next's InjectManifest: the precache manifest. */
  readonly __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  skipWaiting(): Promise<void>;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: "activate",
    listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void,
  ): void;
};

declare const self: ServiceWorkerScope;

const serwist = new Serwist({
  // `?? []` because the manifest is not injected in development builds, where
  // @serwist/next leaves the placeholder undefined.
  precacheEntries: self.__SW_MANIFEST ?? [],
  precacheOptions: { cleanupOutdatedCaches: true },
  // Doc 41 section 7 step 2: a new worker waits. Activating under a user who is
  // halfway through a scan would throw away the capture they are holding the
  // phone still for. The update toast is how they say when.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: toRuntimeCaching(giyaRouteSpecs(__GIYA_BUILD_ID__)),
  // The navigation row is NetworkFirst; when the network is gone and nothing is
  // cached for that URL, this is what answers instead of the browser's dinosaur.
  // `/offline` is added to the precache manifest in next.config.ts, which is the
  // condition this option documents for itself.
  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

// Doc 41 section 1: `{type, payload?}`, unknown types ignored. The parsing and
// the "what does this mean" decision are in ../lib/pwa/messages.ts.
self.addEventListener("message", (event) => {
  if (swMessageAction(event.data) === "skip-waiting") {
    void self.skipWaiting();
  }
});

// Doc 41 section 7 step 5 - the "purged on deploy" guarantee. Every cache this
// app owns that carries a different build id goes; Serwist's own precache and
// anything else on the origin is left alone (see ../lib/pwa/cache-names.ts).
self.addEventListener("activate", (event) => {
  event.waitUntil(purgeStaleCaches());
});

async function purgeStaleCaches(): Promise<void> {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => isStaleGiyaCache(name, __GIYA_BUILD_ID__))
      .map((name) => caches.delete(name)),
  );
}

serwist.addEventListeners();
