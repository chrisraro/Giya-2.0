/**
 * The service-worker <-> app message registry (doc 41 section 1).
 *
 * Doc 41 specifies five `postMessage` types. This task implements exactly one -
 * `SKIP_WAITING`, the accept side of the update flow (section 7) - and declares
 * the rest so the tasks that own them extend this union instead of inventing
 * their own string literals:
 *
 *   SET_USER, PURGE_USER_CACHES  T5.3, with the per-user me-cache
 *   OUTBOX_CHANGED               T5.3, with the IndexedDB receipt outbox
 *   NAVIGATE                     the push work, with `notificationclick`
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

/** The actions this worker implements. T5.3 and the push work add to this. */
export type SwMessageAction = "skip-waiting" | "ignore";

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
    // Declared by doc 41, implemented by later tasks. Falling through to
    // "ignore" is the correct interim behaviour, not an oversight.
    case "SET_USER":
    case "PURGE_USER_CACHES":
    case "OUTBOX_CHANGED":
    case "NAVIGATE":
      return "ignore";
  }
}
