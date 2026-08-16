import { PURGE_USER_CACHES_MESSAGE } from "./messages";

/**
 * Telling the worker to drop the authenticated caches, from the page, on the
 * way out of a session (doc 41 preamble rule 2, section 8).
 *
 * WHY THIS IS NOT IN `signOut()`. `src/features/identity/actions.ts`'s signOut
 * is a Server Action - it has to be, because only a Server Action or Route
 * Handler may delete the `sb-*` cookies - and `postMessage` to a service worker
 * is a client-side API that does not exist there. So the purge is posted by the
 * client component that invokes the action, before the action runs. See
 * `src/components/pwa/logout-form.tsx`.
 *
 * THE ORDERING TRADE, STATED RATHER THAN STUMBLED INTO. `postMessage` is
 * fire-and-forget: there is no acknowledgement, so the session can end before
 * the worker has finished deleting. That is accepted, for two reasons that both
 * have to hold:
 *
 *   1. Nothing the NEXT consumer can do addresses a half-deleted cache. Cache
 *      Storage is keyed by name and the worker deletes whole caches, so a
 *      navigation either finds the cache (and is answered from the network
 *      first anyway, on a 3s timeout) or does not.
 *   2. The next `activate` sweeps every cache carrying a different build id, so
 *      a delete that never completed is bounded by the next deploy.
 *
 * The alternative - purging from the page with `caches.delete()` and AWAITING it
 * - was considered and not taken: it would hold the consumer on a spinner while
 * storage responds, and a storage backend that hangs would then hang the logout
 * itself. Nothing here may be able to strand somebody signed in.
 */

/**
 * Posts PURGE_USER_CACHES to the worker controlling this page.
 *
 * NEVER THROWS, and callers must not await anything on the strength of the
 * answer. `false` is ordinary: no `navigator.serviceWorker` (insecure origin,
 * some private windows, iOS below 16.4 outside an installed app), or no
 * controller yet on the very first page view of a new registration. In both
 * cases there is nothing cached for this session to leak.
 *
 * @returns whether a worker was actually told.
 */
export function postUserCachePurge(
  container: ServiceWorkerContainer | undefined | null,
): boolean {
  try {
    // `controller`, not `registration.active`: the controller is the worker that
    // is answering THIS page's fetches, which is the one holding the documents
    // that were rendered for the session now ending. Reading it is also
    // synchronous, so nothing has to be awaited between here and the sign-out.
    //
    // Optional chaining rather than an early `if (controller == null) return
    // false`. That guard was written first and a mutant deleted it with nothing
    // turning red: `null.postMessage()` throws into the catch below, which also
    // answers false, so the guard changed nothing observable. The answer is now
    // carried by the return expression, which IS pinned - a mutant returning
    // `true` unconditionally fails the no-controller test.
    const controller = container?.controller ?? null;
    controller?.postMessage(PURGE_USER_CACHES_MESSAGE);
    return controller !== null;
  } catch {
    // A worker that is redundant by the time we post throws InvalidStateError.
    // Logging out matters more than purging; the next activate sweeps anyway.
    return false;
  }
}
