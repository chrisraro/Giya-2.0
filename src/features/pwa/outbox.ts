/**
 * The offline receipt outbox (doc 41 section 3): durable storage, and the
 * decision to accept or refuse a capture.
 *
 * THE ONE RULE. There is no in-memory fallback anywhere in this file, and there
 * must never be one. The module this replaced fell back to a module-scoped
 * array whenever IndexedDB was missing or threw, so a consumer standing in a
 * basement milk-tea shop was told "saved on your phone" about a receipt that
 * lived in a JavaScript variable: gone on refresh, gone when the tab closed,
 * gone when the OS reclaimed it, and gone silently. When the queue cannot be
 * durable the honest outcome is `{ ok: false }` and a sentence saying the
 * capture was not kept (see ./outbox-copy.ts). A refusal costs the consumer one
 * retaken photo; a phantom queue costs them the receipt and the points.
 *
 * That is why nothing here is written against an injectable store either. The
 * module reaches `globalThis.indexedDB` directly, so a test cannot accidentally
 * be pointed at a stand-in that would pass whether the bytes reached a database
 * or not. `outbox.test.ts` runs it against a real IndexedDB implementation.
 *
 * WHAT LIVES WHERE. This file owns the schema, the durable operations and the
 * enqueue decision. `./outbox-replay.ts` owns the drain, its classification of
 * failures and its backoff. `./outbox-copy.ts` owns every sentence either of
 * them can say. `src/features/pwa/components/outbox-card.tsx` renders the
 * queue.
 *
 * CLIENT ONLY. IndexedDB does not exist on the server; nothing here may be
 * imported by a server component.
 */

import {
  OUTBOX_FULL_MESSAGE,
  OUTBOX_STORAGE_FULL_MESSAGE,
  OUTBOX_UNAVAILABLE_MESSAGE,
} from "./outbox-copy";

// ---------------------------------------------------------------------------
// Schema (doc 41 section 3, exactly)
// ---------------------------------------------------------------------------

export const OUTBOX_DB_NAME = "giya-offline";
export const OUTBOX_DB_VERSION = 1;
export const OUTBOX_STORE_NAME = "receipt_outbox";

/**
 * The drain is FIFO BY CAPTURE TIME, which is not insertion order and not key
 * order: the keys are UUIDs, and a manual retry rewrites a row without moving
 * its place in the queue. Hence a real index rather than a sort at read time.
 */
export const OUTBOX_CAPTURED_AT_INDEX = "captured_at";

/**
 * Doc 41 section 3: "Max 10 queued receipts", roughly 15MB worst case. It is a
 * quota guard and, deliberately, an offline fraud-velocity bound consistent
 * with the server's 60/day scan limit.
 */
export const OUTBOX_MAX_ITEMS = 10;

/** Doc 41 section 3: drives the queue card. */
export type OutboxStatus = "queued" | "uploading" | "failed";

export interface OutboxItem {
  /** UUID; the store's key path. */
  readonly id: string;
  /** The compressed JPEG, under 1.5MB by the doc 33 compression contract. */
  readonly image: Blob;
  /**
   * Advisory client hash, sent as a server pre-check. NULL, not undefined, when
   * `crypto.subtle` was unavailable or the hash had not resolved by the time
   * the consumer confirmed: doc 36 makes the authoritative hash server-side, so
   * this is allowed to be absent. See `normaliseOptional` for why null.
   */
  readonly client_sha256: string | null;
  /** Null for a generic scan. */
  readonly business_id: string | null;
  /** ISO string. Shown in the queue card and the index the drain reads. */
  readonly captured_at: string;
  /** Minted once at capture and reused by every replay, across restarts. */
  readonly idempotency_key: string;
  readonly attempts: number;
  /** The last failure class, for the queue card. */
  readonly last_error: string | null;
  readonly status: OutboxStatus;
}

/** The fields a replay or a manual action may rewrite. */
export type OutboxPatch = Partial<Pick<OutboxItem, "attempts" | "last_error" | "status">>;

/**
 * The queue is not usable. Never swallowed into a success anywhere in this
 * module; it is what turns into `reason: "unavailable"` and a sentence telling
 * the consumer the capture was not kept.
 */
export class OutboxUnavailableError extends Error {
  override readonly name = "OutboxUnavailableError";
}

// ---------------------------------------------------------------------------
// Durable operations
// ---------------------------------------------------------------------------

/**
 * `globalThis.indexedDB`, or a throw.
 *
 * Read at call time rather than captured at module scope: the module is
 * imported by the consumer layout's subtree, and touching storage globals at
 * import time is what takes a Safari private window's whole page down.
 */
function outboxFactory(): IDBFactory {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (factory === undefined || factory === null) {
    throw new OutboxUnavailableError("This browser has no IndexedDB.");
  }
  return factory;
}

/**
 * Opens `giya-offline` v1, creating the store and index on first use.
 *
 * No connection is cached at module scope. A cached handle is stale after a
 * `versionchange` from another tab and after the browser force-closes the
 * database under storage pressure, and both of those failures look like a
 * silently empty queue. Reopening per operation costs microseconds and cannot
 * go stale.
 */
export async function openOutbox(): Promise<IDBDatabase> {
  const factory = outboxFactory();

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(OUTBOX_DB_NAME, OUTBOX_DB_VERSION);
    } catch (error) {
      reject(new OutboxUnavailableError(describe(error)));
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
        const store = db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: "id" });
        store.createIndex(OUTBOX_CAPTURED_AT_INDEX, OUTBOX_CAPTURED_AT_INDEX, { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    // VersionError (an older build meeting a newer database), a failed upgrade,
    // a blocked or corrupt store. Doc 41 section 10 is explicit that the outbox
    // store is never dropped and recreated to get past this; the receipts in it
    // are the one thing on the device that is not safe to lose.
    request.onerror = () => reject(new OutboxUnavailableError(describe(request.error)));
    request.onblocked = () => reject(new OutboxUnavailableError("The outbox is open elsewhere."));
  });
}

/**
 * Runs one transaction and closes the connection.
 *
 * Resolution waits for `transaction.oncomplete`, not for the request callback:
 * a request can succeed inside a transaction that then aborts, and resolving on
 * the request would report a write that never landed. On a durability-critical
 * store, "the transaction committed" is the only success worth reporting.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | null,
  read: (request: IDBRequest | null) => T,
): Promise<T> {
  const db = await openOutbox();

  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(OUTBOX_STORE_NAME, mode);
      let request: IDBRequest | null = null;

      transaction.oncomplete = () => resolve(read(request));
      transaction.onerror = () => reject(transaction.error ?? new Error("Outbox transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Outbox transaction aborted."));

      try {
        request = run(transaction.objectStore(OUTBOX_STORE_NAME));
      } catch (error) {
        // A synchronous throw from put(): QuotaExceededError arrives this way,
        // and the transaction may never fire an event of its own.
        try {
          transaction.abort();
        } catch {
          // Already aborting.
        }
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

/** Writes (or overwrites) one row. Rejects on quota, so callers can react. */
export async function putOutboxItem(item: OutboxItem): Promise<void> {
  await withStore<void>(
    "readwrite",
    (store) => store.put(item),
    () => undefined,
  );
}

/** Every row, FIFO by `captured_at` (doc 41 section 3). */
export async function listOutboxItems(): Promise<OutboxItem[]> {
  return withStore<OutboxItem[]>(
    "readonly",
    (store) => store.index(OUTBOX_CAPTURED_AT_INDEX).getAll(),
    (request) => (request?.result as OutboxItem[] | undefined) ?? [],
  );
}

/** How many receipts are waiting. Used by the cap and by the queue card. */
export async function countOutboxItems(): Promise<number> {
  return withStore<number>(
    "readonly",
    (store) => store.count(),
    (request) => (request?.result as number | undefined) ?? 0,
  );
}

export async function readOutboxItem(id: string): Promise<OutboxItem | null> {
  return withStore<OutboxItem | null>(
    "readonly",
    (store) => store.get(id),
    (request) => (request?.result as OutboxItem | undefined) ?? null,
  );
}

/**
 * Applies a patch to one row, in a single read-modify-write transaction.
 *
 * Read and write share the transaction so a concurrent drain cannot land
 * between them and lose an attempt count. Resolves `null` when the row is gone,
 * which is the ordinary outcome of a manual delete racing a drain.
 */
export async function updateOutboxItem(id: string, patch: OutboxPatch): Promise<OutboxItem | null> {
  let updated: OutboxItem | null = null;

  await withStore<void>(
    "readwrite",
    (store) => {
      const get = store.get(id);
      get.onsuccess = () => {
        const current = get.result as OutboxItem | undefined;
        if (current === undefined) return;
        updated = { ...current, ...patch };
        store.put(updated);
      };
      return null;
    },
    () => undefined,
  );

  return updated;
}

export async function deleteOutboxItem(id: string): Promise<void> {
  await withStore<void>(
    "readwrite",
    (store) => store.delete(id),
    () => undefined,
  );
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueReceiptInput {
  /** The row key. Supplied by the caller so the capture screen owns identity. */
  readonly id: string;
  readonly image: Blob;
  readonly clientSha256: string | undefined;
  readonly businessId: string | undefined;
  readonly capturedAt: string;
  /**
   * The key the capture screen already minted for this submission. Storing it
   * is the whole reason the outbox is safe: the same logical submission keeps
   * one identity across however many replays and however many restarts, so the
   * server replays its original answer instead of filing a second receipt.
   */
  readonly idempotencyKey: string;
}

/** Why a capture was not kept. Each maps to one sentence in ./outbox-copy.ts. */
export type EnqueueRefusal = "cap" | "quota" | "unavailable";

export type EnqueueOutcome =
  | { readonly ok: true; readonly item: OutboxItem }
  | { readonly ok: false; readonly reason: EnqueueRefusal; readonly message: string };

/**
 * `undefined` becomes `null` before it reaches storage.
 *
 * IndexedDB keeps an explicitly-undefined property as present-and-undefined,
 * and the two spell differently once the row is read back and turned into a
 * submit body. Since the body is fingerprinted under the Idempotency-Key
 * (src/lib/api/handler.ts), a body that drifts between attempts is answered 409
 * IDEMPOTENCY_REPLAYED rather than replayed. One spelling, decided here.
 */
function normaliseOptional(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

function toOutboxItem(input: EnqueueReceiptInput): OutboxItem {
  return {
    id: input.id,
    image: input.image,
    client_sha256: normaliseOptional(input.clientSha256),
    business_id: normaliseOptional(input.businessId),
    captured_at: input.capturedAt,
    idempotency_key: input.idempotencyKey,
    attempts: 0,
    last_error: null,
    status: "queued",
  };
}

/**
 * The name is read off the object rather than through `instanceof Error`.
 *
 * The full-storage signal arrives as a `DOMException`, which is NOT an
 * `instanceof Error` in every engine, and IndexedDB hands some failures back as
 * a bare `DOMException` on the request. Narrowing by `instanceof` first would
 * silently reclassify every quota failure as `unavailable`, skip the purge and
 * the retry doc 41 asks for, and tell a consumer with a full phone the wrong
 * sentence about why their receipt was not kept.
 */
function errorName(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const { name } = error as { name?: unknown };
  return typeof name === "string" ? name : "";
}

function isQuotaError(error: unknown): boolean {
  return errorName(error) === "QuotaExceededError";
}

function describe(error: unknown): string {
  const name = errorName(error);
  return name === "" ? String(error) : name;
}

/**
 * Deletes this app's image caches, the sacrificial class in doc 41 section 8
 * ("images are sacrificed first"). Returns quietly on a browser with no Cache
 * Storage; the caller's next move is the same either way.
 *
 * Narrow on purpose: `giya-images-` and nothing else. The page shell is what
 * makes the app open at all with no signal, and other origins' caches are not
 * ours to spend.
 */
async function purgeImageCaches(): Promise<void> {
  const storage = (globalThis as { caches?: CacheStorage }).caches;
  if (storage === undefined || storage === null) return;

  try {
    const names = await storage.keys();
    await Promise.all(
      names.filter((name) => name.startsWith("giya-images-")).map((name) => storage.delete(name)),
    );
  } catch {
    // Cache Storage is unavailable or blocked. The retry below still happens;
    // it simply has less room to work with.
  }
}

/**
 * Doc 41 section 8: "after the first item enters the outbox, request
 * `navigator.storage.persist()`".
 *
 * Best-effort by design. Chromium usually grants it for an installed PWA and
 * Safari never does, so this raises the floor on Android without anything
 * depending on the answer. Called only after a row is actually committed, so
 * the ask is always about a receipt that exists.
 */
async function requestPersistence(): Promise<void> {
  const manager = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage;
  if (manager === undefined || typeof manager.persist !== "function") return;
  try {
    await manager.persist();
  } catch {
    // Denied, or unsupported behind a flag. Nothing here depends on it.
  }
}

/**
 * Accept a capture into the durable queue, or refuse it and say so.
 *
 * The three refusals are the honest outcomes named in doc 41 section 3:
 *
 *   cap          the 11th receipt, refused so the queue stays inside mobile
 *                quotas and inside the server's own velocity bound
 *   quota        the phone is full, after one image-cache purge and one retry
 *   unavailable  no IndexedDB, or a database that will not open
 *
 * On every one of them the capture was NOT kept, and the message says so.
 */
export async function enqueueCapturedReceipt(input: EnqueueReceiptInput): Promise<EnqueueOutcome> {
  const item = toOutboxItem(input);

  try {
    if ((await countOutboxItems()) >= OUTBOX_MAX_ITEMS) {
      return { ok: false, reason: "cap", message: OUTBOX_FULL_MESSAGE };
    }
    await putOutboxItem(item);
  } catch (error) {
    if (!isQuotaError(error)) {
      return { ok: false, reason: "unavailable", message: OUTBOX_UNAVAILABLE_MESSAGE };
    }

    // Doc 41 section 3: "attempt image-cache cleanup, retry once, else tell the
    // user storage is full". Once, not in a loop: a phone that is full stays
    // full, and a retry loop on a blocked write is a frozen scan screen.
    await purgeImageCaches();
    try {
      await putOutboxItem(item);
    } catch (retryError) {
      return isQuotaError(retryError)
        ? { ok: false, reason: "quota", message: OUTBOX_STORAGE_FULL_MESSAGE }
        : { ok: false, reason: "unavailable", message: OUTBOX_UNAVAILABLE_MESSAGE };
    }
  }

  await requestPersistence();
  return { ok: true, item };
}
