import { Serwist, type PrecacheEntry } from "serwist";

import { readActiveUser } from "../features/pwa/active-user";
import {
  createBackoffSchedule,
  drainOutbox,
  isOutboxSyncTag,
} from "../features/pwa/outbox-replay";
import { submitCapturedReceipt } from "../features/receipts/upload";
import { isStaleGiyaCache } from "../lib/pwa/cache-names";
import { OUTBOX_CHANGED_MESSAGE, swMessageAction } from "../lib/pwa/messages";
import { purgeUserCaches } from "../lib/pwa/purge";
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
  /**
   * `ExtendableMessageEvent`. `waitUntil` is the half that matters for the
   * logout purge: the page posts and immediately navigates to /login, so
   * without it the browser is free to kill an idle worker mid-delete.
   */
  addEventListener(
    type: "message",
    listener: (event: { data: unknown; waitUntil(promise: Promise<unknown>): void }) => void,
  ): void;
  addEventListener(
    type: "activate",
    listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void,
  ): void;
  /** Background Sync (doc 41 sections 3 and 6). Absent on iOS and Firefox. */
  addEventListener(
    type: "sync",
    listener: (event: { readonly tag: string; waitUntil(promise: Promise<unknown>): void }) => void,
  ): void;
  readonly clients: {
    matchAll(options?: { type?: string }): Promise<{ postMessage(message: unknown): void }[]>;
  };
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
// the "what does this mean" decision are in ../lib/pwa/messages.ts; WHICH caches
// a purge removes is in ../lib/pwa/purge.ts. Both are tested by execution.
self.addEventListener("message", (event) => {
  const action = swMessageAction(event.data);

  if (action === "skip-waiting") {
    void self.skipWaiting();
    return;
  }

  // Doc 41 preamble rule 2: caches are purged on deploy AND ON LOGOUT. Inside
  // `waitUntil` because the page that posted this is on its way to /login and
  // may be gone a millisecond later; an idle worker with nothing extending it
  // can be killed with the delete half-done, which is the exposure this exists
  // to close.
  if (action === "purge-user-caches") {
    event.waitUntil(purgeUserCaches(caches));
  }
});

// Doc 41 section 7 step 5 - the "purged on deploy" guarantee. Every cache this
// app owns that carries a different build id goes; Serwist's own precache and
// anything else on the origin is left alone (see ../lib/pwa/cache-names.ts).
self.addEventListener("activate", (event) => {
  event.waitUntil(purgeStaleCaches());
});

// Doc 41 sections 3 and 6: the one-shot Background Sync replay, tag
// `receipt-outbox`. THIS LISTENER IS WHY `registerOutboxSync` IS NOT
// DECORATION - registering a tag no worker answers is a guard whose removal
// changes nothing, and doc 41 section 6 requires the handler be idempotent and
// safe to fire against an empty outbox, which `drainOutbox` is.
//
// The drain itself, its classification and its backoff live in
// ../features/pwa/outbox-replay.ts, where they run in an ordinary test. What is
// left here is wiring. Everything it touches (IndexedDB, fetch, Blob) exists in
// a worker; nothing in that import chain touches the DOM.
//
// The schedule is module scope, so it survives between sync events for as long
// as this worker lives. It holds when an item may next be tried, never what to
// send: losing it retries sooner and can never lose a receipt.
const outboxSchedule = createBackoffSchedule();

self.addEventListener("sync", (event) => {
  if (!isOutboxSyncTag(event.tag)) return;
  event.waitUntil(replayOutbox());
});

async function replayOutbox(): Promise<void> {
  // WHOSE ROWS THIS RUN MAY TOUCH. A worker has no session and no props, so the
  // answer comes from the durable record the app writes on every consumer page
  // and clears on logout (../features/pwa/active-user.ts, which explains why a
  // posted SET_USER could not do this job).
  //
  // `null` - nobody signed in, or storage unavailable - means DO NOTHING. On a
  // shared phone the alternative is that consumer B's sync event picks up
  // consumer A's row, and the server's 403 on the user-scoped storage path is
  // classified terminal, which deletes A's only copy of the photo. Skipping a
  // background drain costs a deferred upload; the next app launch drains it
  // with a user it is sure of.
  const userId = await readActiveUser();
  if (userId === null) return;

  const result = await drainOutbox({
    submit: submitCapturedReceipt,
    userId,
    now: () => Date.now(),
    schedule: outboxSchedule,
    // A `sync` event only fires because the browser decided connectivity is
    // back, which is the same evidence the app's `online` handler acts on, so
    // this run may reach rows that have spent their five attempts.
    retryFailed: true,
    // The worker has no UI. Doc 41 section 1 gives it one message for this:
    // OUTBOX_CHANGED, sent below once, rather than per item.
    notify: () => undefined,
  });

  if (result.removed === 0) return;

  // Doc 41 section 1: "app invalidates ['receipts','list'] and refreshes queue
  // UI". An open tab has no other way to learn that rows it is displaying were
  // uploaded by a worker it never spoke to.
  const windows = await self.clients.matchAll({ type: "window" });
  for (const client of windows) client.postMessage(OUTBOX_CHANGED_MESSAGE);
}

async function purgeStaleCaches(): Promise<void> {
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => isStaleGiyaCache(name, __GIYA_BUILD_ID__))
      .map((name) => caches.delete(name)),
  );
}

serwist.addEventListeners();
