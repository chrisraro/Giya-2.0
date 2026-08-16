/**
 * WHO IS SIGNED IN ON THIS DEVICE, durably, where a service worker can read it.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `SET_USER`.
 *
 * The outbox drain is scoped to a user (see ./outbox.ts, `OutboxItem.user_id`).
 * Every caller of `drainOutbox` gets that id from the server component that
 * rendered the screen - except one. The Background Sync replay in
 * `src/app/sw.ts` runs with the app CLOSED, which is the whole point of it, and
 * a worker has no session, no cookies it can read and no props. Without an
 * answer to "who is signed in" that handler has only two options, and both are
 * defects the rest of this wave was spent removing:
 *
 *   drain everything  on a shared phone, consumer B's sync event picks up
 *                     consumer A's row. `assertOwnedImagePath` answers 403
 *                     FORBIDDEN, the replay calls that terminal, and A's only
 *                     copy of the photo is deleted. If the row never uploaded,
 *                     it is worse: the drain presigns a fresh path under B and
 *                     files A's purchase against B's account.
 *   drain nothing     the `sync` listener becomes decoration, which is exactly
 *                     what src/app/outbox-sync-wiring.test.ts was written to
 *                     stop.
 *
 * Doc 41 section 1's `SET_USER` message is the spec's answer and it is the
 * wrong shape for this problem. A posted message lands in the worker's memory,
 * and a worker is killed whenever the browser feels like it; a `sync` event
 * fires precisely when the worker was NOT running, so it would start with an
 * empty variable every time it mattered. The answer has to be durable, so it
 * lives in storage rather than in a message. That is why SET_USER stays
 * declared and unimplemented (see src/lib/pwa/messages.ts).
 *
 * WHY ITS OWN DATABASE, NOT A STORE IN `giya-offline`. Adding a store there
 * means bumping `OUTBOX_DB_VERSION`, and doc 41 section 10 is emphatic that the
 * receipt store is the one thing on the device that is never dropped or
 * recreated. A failed upgrade on the shared database would take the queue down
 * with it. A separate database cannot: the worst case here is
 * `readActiveUser()` answering null, which costs one deferred background drain
 * and no data at all.
 *
 * NOT A SECURITY BOUNDARY, AND MUST NEVER BE TREATED AS ONE. This is a hint
 * about which rows to try, held in storage any script on the origin can write.
 * The authority on whose receipt this is stays where it was: the session cookie
 * on the request, and `assertOwnedImagePath` on the server. Tampering with this
 * record cannot make the server accept a receipt for somebody else; it can only
 * cause a submission that is refused.
 *
 * CLIENT AND WORKER. IndexedDB exists in both and in neither on the server;
 * nothing here may be imported by a server component.
 */

export const SESSION_DB_NAME = "giya-session";
export const SESSION_DB_VERSION = 1;
export const SESSION_STORE_NAME = "active_user";

/** One row, always. The device has one signed-in consumer at a time. */
export const ACTIVE_USER_KEY = "current";

/**
 * Read at call time, never captured at module scope: this module is in the
 * consumer layout's subtree, and touching storage globals at import time is
 * what takes a Safari private window's whole page down.
 */
function sessionFactory(): IDBFactory | null {
  return (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
}

async function openSessionDb(): Promise<IDBDatabase | null> {
  const factory = sessionFactory();
  if (factory === null) return null;

  return new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(SESSION_DB_NAME, SESSION_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
        db.createObjectStore(SESSION_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    // Every failure resolves null rather than rejecting. NOTHING in this module
    // may throw: it is called on the way out of a session and from a background
    // handler, and a rejection in either place is a logout that hangs or a
    // worker that dies.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function withSessionStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | null,
  read: (request: IDBRequest | null) => T,
  fallback: T,
): Promise<T> {
  const db = await openSessionDb();
  if (db === null) return fallback;

  try {
    return await new Promise<T>((resolve) => {
      let request: IDBRequest | null = null;
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(SESSION_STORE_NAME, mode);
      } catch {
        resolve(fallback);
        return;
      }

      transaction.oncomplete = () => resolve(read(request));
      transaction.onerror = () => resolve(fallback);
      transaction.onabort = () => resolve(fallback);

      try {
        request = run(transaction.objectStore(SESSION_STORE_NAME));
      } catch {
        try {
          transaction.abort();
        } catch {
          // Already aborting.
        }
        resolve(fallback);
      }
    });
  } finally {
    db.close();
  }
}

/**
 * Records the consumer this device is signed in as.
 *
 * Called from every consumer page render, not only from the screens that queue
 * receipts. The gap that closes is real: B signs in, lands on /home and never
 * opens /scan, and a `sync` event fires against A's leftover rows. A record
 * written only where the outbox is used would still say A.
 *
 * @returns whether it was written. Nothing may depend on the answer.
 */
export async function rememberActiveUser(userId: string): Promise<boolean> {
  return withSessionStore<boolean>(
    "readwrite",
    (store) => store.put(userId, ACTIVE_USER_KEY),
    () => true,
    false,
  );
}

/**
 * Forgets who was signed in. Called on logout.
 *
 * THIS IS WHAT MAKES THE WHOLE ARRANGEMENT SAFE. Between one consumer signing
 * out and the next one opening a consumer page there is a window in which a
 * `sync` event could fire; without this, the record would still name the person
 * who left and the drain would submit their rows under whatever session now
 * exists. Cleared, the background drain does nothing at all - which costs a
 * deferred upload and cannot cost a receipt.
 */
export async function forgetActiveUser(): Promise<boolean> {
  return withSessionStore<boolean>(
    "readwrite",
    (store) => store.delete(ACTIVE_USER_KEY),
    () => true,
    false,
  );
}

/**
 * The consumer this device is signed in as, or `null`.
 *
 * `null` means "do not drain" everywhere it is used, and it is the answer for
 * every failure: no IndexedDB, a database that will not open, a blocked store.
 * Erring towards not draining is the direction that cannot lose a receipt.
 */
export async function readActiveUser(): Promise<string | null> {
  return withSessionStore<string | null>(
    "readonly",
    (store) => store.get(ACTIVE_USER_KEY),
    (request) => {
      const value = request?.result as unknown;
      return typeof value === "string" && value.length > 0 ? value : null;
    },
    null,
  );
}
