/**
 * The service-worker <-> app message registry (doc 41 section 1).
 *
 * Doc 41 specifies five `postMessage` types. Three are implemented:
 *
 *   SKIP_WAITING       T5.1, the accept side of the update flow (section 7)
 *   OUTBOX_CHANGED     T5.3a, SW -> app after a Background Sync replay
 *   PURGE_USER_CACHES  T5.3b, the logout purge (preamble rule 2, section 8)
 *
 * Two are declared and not implemented:
 *
 *   SET_USER   NOBODY OWNS THIS YET, and it must not be implemented for its own
 *              sake. Doc 41 gives it exactly one job: telling the worker which
 *              user the per-user me-cache name (`giya-me-{buildId}-{userIdHash}`)
 *              belongs to. That cache is section 4's, which is DEFERRED - the
 *              three consumer pages are `force-dynamic` server components, there
 *              is no client fetching of `/api/v1/me/*` and no TanStack Query, so
 *              a me-cache would cache routes with no callers. See
 *              docs/superpowers/plans/2026-08-06-missing-modules.md, Wave 5.
 *              Until that redesign happens, a SET_USER handler would be state
 *              the worker stores and never reads: a field whose removal changes
 *              nothing. The logout purge deliberately does NOT need it - it
 *              deletes by cache CLASS, not by user, so it is correct without the
 *              worker ever having been told who was signed in.
 *   NAVIGATE   the push work, with `notificationclick`
 *
 * The protocol is forward-compatible: unknown types are IGNORED, never thrown
 * on. That matters most during a deploy, when an old worker still controls a
 * new page for the seconds between `activate` and reload and is handed types it
 * has never seen. A throw inside a `message` listener is an unhandled rejection
 * in the worker, so ignoring is what keeps it alive across a version skew.
 */

/** Every type the protocol defines, in doc 41's order. */
export const SW_MESSAGE_TYPES = [
  "SET_USER",
  "PURGE_USER_CACHES",
  "SKIP_WAITING",
  "OUTBOX_CHANGED",
  "NAVIGATE",
] as const;

export type SwMessageType = (typeof SW_MESSAGE_TYPES)[number];

/** Every payload is `{type, payload?}` (doc 41 section 1). */
export type SwMessage = {
  readonly type: SwMessageType;
  readonly payload?: unknown;
};

/** What the update toast posts when the user accepts (doc 41 section 7 step 3). */
export const SKIP_WAITING_MESSAGE: SwMessage = { type: "SKIP_WAITING" };

/**
 * What the worker posts to every open window after a Background Sync replay
 * emptied rows from the receipt outbox (doc 41 sections 1 and 3).
 *
 * SW -> app, unlike the two above. The replay ran inside the worker, so a tab
 * showing the queue card has no other way to learn that rows it is displaying
 * are gone; `src/components/pwa/receipt-outbox.tsx` listens for it.
 */
export const OUTBOX_CHANGED_MESSAGE: SwMessage = { type: "OUTBOX_CHANGED" };

/**
 * What the app posts on the way out of a session (doc 41 preamble rule 2,
 * section 8). App -> SW.
 *
 * NO PAYLOAD, AND THAT IS THE DESIGN. The worker deletes by cache CLASS - every
 * `giya-pages-*` and `giya-me-*` - not by user, so it does not need to be told
 * whose session just ended, and cannot get it wrong if the answer arrives late
 * or not at all. See ./purge.ts for which classes and why the pages cache is one
 * of them.
 */
export const PURGE_USER_CACHES_MESSAGE: SwMessage = { type: "PURGE_USER_CACHES" };

/**
 * A declared message, or `null` for anything unrecognised or malformed.
 *
 * Never throws. Anything running on the page can `postMessage` at a service
 * worker, and browser extensions do.
 */
export function parseSwMessage(data: unknown): SwMessage | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;

  const { type, payload } = data as { type?: unknown; payload?: unknown };
  if (typeof type !== "string") return null;
  if (!(SW_MESSAGE_TYPES as readonly string[]).includes(type)) return null;

  return payload === undefined
    ? { type: type as SwMessageType }
    : { type: type as SwMessageType, payload };
}

/** The actions this worker implements. The push work adds to this. */
export type SwMessageAction = "skip-waiting" | "purge-user-caches" | "ignore";

/**
 * What the worker should do with an inbound message.
 *
 * Kept here rather than as a `switch` inside `sw.ts` so the "unknown and
 * unimplemented types are a no-op" rule is provable in a normal test run -
 * `sw.ts` itself only ever executes inside a real ServiceWorkerGlobalScope.
 */
export function swMessageAction(data: unknown): SwMessageAction {
  const message = parseSwMessage(data);
  if (message === null) return "ignore";

  switch (message.type) {
    case "SKIP_WAITING":
      return "skip-waiting";
    case "PURGE_USER_CACHES":
      return "purge-user-caches";
    // OUTBOX_CHANGED travels the other way (SW -> app) and is handled by
    // src/components/pwa/receipt-outbox.tsx, so the worker ignoring it is
    // correct rather than pending. SET_USER and NAVIGATE are declared and
    // unimplemented; see this file's header for who owns them and why SET_USER
    // has deliberately not been given a handler.
    case "SET_USER":
    case "OUTBOX_CHANGED":
    case "NAVIGATE":
      return "ignore";
  }
}
