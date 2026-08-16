import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob } from "node:buffer";

import {
  OUTBOX_CAPTURED_AT_INDEX,
  OUTBOX_DB_NAME,
  OUTBOX_DB_VERSION,
  OUTBOX_MAX_ITEMS,
  deleteOutboxItem,
  enqueueCapturedReceipt,
  listOutboxItems,
  openOutbox,
  putOutboxItem,
  updateOutboxItem,
  type EnqueueReceiptInput,
  type OutboxItem,
} from "./outbox";
import {
  OUTBOX_FULL_MESSAGE,
  OUTBOX_STORAGE_FULL_MESSAGE,
  OUTBOX_UNAVAILABLE_MESSAGE,
} from "./outbox-copy";

// WHY fake-indexeddb AND NOT AN INJECTED STORE
//
// This module exists to make one promise true: a receipt the consumer was told
// is "saved on your phone" is still there after the tab closes. A test that
// pointed the module at an injected Map would pass whether the implementation
// wrote to IndexedDB or to a JavaScript variable, which is exactly the bug this
// task was written to delete. So the tests run against a REAL IndexedDB
// implementation (fake-indexeddb speaks the actual spec: versioned opens,
// transactions, key paths, indexes, structured clone) installed on
// `globalThis.indexedDB`, which is also how the production module reaches it -
// there is no injection seam to accidentally exercise instead.
//
// The failure cases are provoked through that same real implementation rather
// than by hand-rolled stubs: `unavailable` by opening the database at a HIGHER
// version first so the module's v1 open fails with a genuine VersionError, and
// `quota` by making the real object store's own `put` throw the
// QuotaExceededError a full phone throws.
//
// jsdom's Blob is the one thing that cannot be used as-is: it is not
// structured-cloneable by Node, so IndexedDB stores it as `{}`. Test receipts
// are therefore built from node:buffer's Blob, which clones properly. Nothing
// in the module constructs a Blob; it stores whatever the capture flow hands it.
function receiptBlob(bytes = "jpeg-bytes"): Blob {
  return new NodeBlob([bytes], { type: "image/jpeg" }) as unknown as Blob;
}

const CAPTURE: EnqueueReceiptInput = {
  id: "11111111-1111-4111-8111-111111111111",
  image: receiptBlob(),
  clientSha256: "a".repeat(64),
  businessId: "3f1b0d9c-4444-4444-8444-444444444444",
  capturedAt: "2026-08-16T09:00:00.000Z",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  imagePath: undefined,
};

function capture(overrides: Partial<EnqueueReceiptInput> = {}): EnqueueReceiptInput {
  return { ...CAPTURE, image: receiptBlob(), ...overrides };
}

function storedRow(index: number): OutboxItem {
  return {
    id: `row-${index}`,
    image: receiptBlob(),
    client_sha256: `${index}`.repeat(4),
    business_id: null,
    captured_at: `2026-08-16T09:0${index}:00.000Z`,
    idempotency_key: `key-${index}`,
    image_path: null,
    attempts: 0,
    last_error: null,
    status: "queued",
  };
}

/** Opens `giya-offline` at a version ABOVE the module's, then closes it. */
async function bumpDatabaseBeyondV1(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = (globalThis.indexedDB as IDBFactory).open(
      OUTBOX_DB_NAME,
      OUTBOX_DB_VERSION + 1,
    );
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

let persist: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  persist = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("navigator", { storage: { persist } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("outbox schema (doc 41 section 3)", () => {
  it("is db giya-offline v1, store receipt_outbox keyed by id, indexed by captured_at", async () => {
    const db = await openOutbox();

    // Asserted against literals rather than against the module's own constants:
    // an expectation that reads the value it is checking cannot disagree with
    // the code. These four names are the schema contract with doc 41.
    expect(db.name).toBe("giya-offline");
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames]).toEqual(["receipt_outbox"]);

    const store = db.transaction("receipt_outbox", "readonly").objectStore("receipt_outbox");
    expect(store.keyPath).toBe("id");
    expect([...store.indexNames]).toEqual(["captured_at"]);
    expect(store.index("captured_at").keyPath).toBe("captured_at");
    db.close();
  });

  it("stores all nine spec fields, with the image surviving as a Blob", async () => {
    await enqueueCapturedReceipt(capture());

    const [item] = await listOutboxItems();
    // Doc 41 section 3's nine, plus `image_path`. The tenth is not decoration:
    // the uploads endpoint mints a fresh path per call, so without it every
    // replay sends a different body under the same Idempotency-Key and the
    // stored-response replay doc 41 calls "the primary replay guard" can never
    // fire for an outbox item. See the field's own comment.
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "attempts",
      "business_id",
      "captured_at",
      "client_sha256",
      "id",
      "idempotency_key",
      "image",
      "image_path",
      "last_error",
      "status",
    ]);
    expect(item?.status).toBe("queued");
    expect(item?.attempts).toBe(0);
    expect(item?.last_error).toBeNull();
    expect(item?.idempotency_key).toBe("22222222-2222-4222-8222-222222222222");
    expect(await item?.image.text()).toBe("jpeg-bytes");
  });

  it("stores a generic scan's missing business and missing advisory hash as null, not undefined", async () => {
    // IndexedDB keeps `undefined` as a present-but-undefined property, which
    // then serialises into a submit body as a missing field in one place and a
    // literal null in another. Normalising at the boundary keeps the replayed
    // body byte-identical to the one the capture screen would have sent.
    await enqueueCapturedReceipt(capture({ businessId: undefined, clientSha256: undefined }));

    const [item] = await listOutboxItems();
    expect(item?.business_id).toBeNull();
    expect(item?.client_sha256).toBeNull();
    expect(item?.image_path).toBeNull();
  });

  it("keeps an image_path from an attempt whose upload already landed", async () => {
    // The bytes are in the bucket under this path. Every replay has to reuse
    // it, or the body changes under an unchanged Idempotency-Key.
    await enqueueCapturedReceipt(capture({ imagePath: "user-1/already-uploaded.jpg" }));

    const [item] = await listOutboxItems();
    expect(item?.image_path).toBe("user-1/already-uploaded.jpg");
  });
});

describe("outbox durability", () => {
  it("keeps a queued receipt across a full module restart", async () => {
    // THE TEST THIS MODULE EXISTS FOR. The old implementation fell back to a
    // module-scoped array whenever IndexedDB was unavailable or threw, so a
    // receipt the consumer was told was "saved on your phone" lived in a
    // JavaScript variable and vanished on the next refresh.
    //
    // `vi.resetModules()` throws the module registry away, so the second import
    // below evaluates a SECOND, INDEPENDENT copy of outbox.ts with empty module
    // scope. The IndexedDB instance on globalThis is untouched, which is the
    // disk. Anything the first copy kept in a variable is unreachable to the
    // second; only what reached IndexedDB comes back.
    const before = await import("./outbox");
    const enqueued = await before.enqueueCapturedReceipt(capture());
    expect(enqueued.ok).toBe(true);

    vi.resetModules();
    const after = await import("./outbox");
    // Without this the test would still pass against a module-level cache: it
    // pins that the restart being simulated actually happened.
    expect(after).not.toBe(before);

    const items = await after.listOutboxItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(await items[0]?.image.text()).toBe("jpeg-bytes");
  });

  it("refuses the capture, and says so, when the browser has no IndexedDB", async () => {
    // Deleted rather than passed as undefined to a parameter: the module reads
    // the global directly, so this exercises the branch and not a default.
    vi.stubGlobal("indexedDB", undefined);

    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("unavailable");
    expect(outcome.ok === false && outcome.message).toBe(
      "We could not save your receipt on this phone, so it was not kept. Take the photo again when you have a connection.",
    );
    expect(outcome.ok === false && outcome.message).toBe(OUTBOX_UNAVAILABLE_MESSAGE);
  });

  it("refuses the capture when the database itself will not open", async () => {
    // A real open failure through the real implementation: the database already
    // exists at a higher version (doc 41 section 10's failed-migration case, and
    // what a downgraded app hits), so opening at v1 raises VersionError.
    await bumpDatabaseBeyondV1();

    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("unavailable");
    // And nothing pretends the receipt is queued afterwards.
    await expect(listOutboxItems()).rejects.toThrow();
  });
});

describe("outbox ordering", () => {
  it("lists FIFO by captured_at, not by insertion order and not by key order", async () => {
    // Doc 41 section 3: "the sync handler drains the outbox FIFO", and FIFO
    // there means BY CAPTURE TIME. Three orders are in play and a fixture where
    // any two of them coincide cannot tell them apart, so this one makes all
    // three disagree:
    //
    //   key order        aa-third,  mm-second, zz-first   (what store.getAll gives)
    //   insertion order  aa-third,  zz-first,  mm-second
    //   capture order    zz-first,  mm-second, aa-third   (what the drain owes)
    //
    // An earlier version of this test used ids that sorted the same way as the
    // capture times, and a mutant that read store.getAll() instead of the
    // captured_at index survived it.
    await putOutboxItem({ ...storedRow(3), id: "aa-third", captured_at: "2026-08-16T09:03:00.000Z" });
    await putOutboxItem({ ...storedRow(1), id: "zz-first", captured_at: "2026-08-16T09:01:00.000Z" });
    await putOutboxItem({ ...storedRow(2), id: "mm-second", captured_at: "2026-08-16T09:02:00.000Z" });

    const items = await listOutboxItems();

    expect(items.map((item) => item.id)).toEqual(["zz-first", "mm-second", "aa-third"]);
    expect(items.map((item) => item.captured_at)).toEqual([
      "2026-08-16T09:01:00.000Z",
      "2026-08-16T09:02:00.000Z",
      "2026-08-16T09:03:00.000Z",
    ]);
    expect(OUTBOX_CAPTURED_AT_INDEX).toBe("captured_at");
  });
});

describe("outbox cap (doc 41 section 3)", () => {
  it("refuses the 11th capture with the spec sentence and keeps the queue at ten", async () => {
    for (let index = 0; index < 10; index += 1) {
      await putOutboxItem({ ...storedRow(index), id: `row-${index}` });
    }

    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("cap");
    expect(outcome.ok === false && outcome.message).toBe("Upload your pending receipts first.");
    expect(outcome.ok === false && outcome.message).toBe(OUTBOX_FULL_MESSAGE);
    // The refusal is a refusal: the 11th row was never written.
    expect(await listOutboxItems()).toHaveLength(10);
    expect(OUTBOX_MAX_ITEMS).toBe(10);
  });

  it("accepts the 10th capture", async () => {
    // The boundary from the other side, so an off-by-one that refuses at nine
    // cannot hide behind the test above.
    for (let index = 0; index < 9; index += 1) {
      await putOutboxItem({ ...storedRow(index), id: `row-${index}` });
    }

    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(true);
    expect(await listOutboxItems()).toHaveLength(10);
  });
});

describe("outbox quota (doc 41 sections 3 and 8)", () => {
  /**
   * Makes the real object store throw the error a full phone throws.
   *
   * The prototype is taken off a live store rather than imported from
   * `fake-indexeddb/lib/FDBObjectStore`, whose typings its package exports map
   * does not expose. Reaching it this way also guarantees the patch lands on
   * the exact class the module under test will be handed.
   */
  async function failPutsWithQuotaError(times: number): Promise<ReturnType<typeof vi.spyOn>> {
    const db = await openOutbox();
    const prototype = Object.getPrototypeOf(
      db.transaction("receipt_outbox", "readonly").objectStore("receipt_outbox"),
    ) as IDBObjectStore;
    db.close();

    const real = prototype.put;
    let remaining = times;
    return vi
      .spyOn(prototype, "put")
      .mockImplementation(function (this: IDBObjectStore, ...args: [unknown, unknown?]) {
        if (remaining > 0) {
          remaining -= 1;
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        }
        return (real as unknown as (...a: unknown[]) => IDBRequest).apply(this, args);
      });
  }

  function stubCaches(names: string[]): { keys: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
    const keys = vi.fn().mockResolvedValue(names);
    const remove = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { keys, delete: remove });
    return { keys, remove };
  }

  it("purges the image cache and retries once, and the receipt is then queued", async () => {
    const { remove } = stubCaches(["giya-images-abc123", "giya-pages-abc123", "other-app-images"]);
    const put = await failPutsWithQuotaError(1);

    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(true);
    expect(await listOutboxItems()).toHaveLength(1);
    // Exactly one cleanup and exactly one retry: doc 41 says "retry once".
    expect(put).toHaveBeenCalledTimes(2);
    // Images are the sacrificial cache (doc 41 section 8). The page shell and
    // other origins' caches are not ours to spend.
    expect(remove.mock.calls.flat()).toEqual(["giya-images-abc123"]);
  });

  it("tells the consumer storage is full when the retry fails too, and keeps nothing", async () => {
    stubCaches(["giya-images-abc123"]);
    const put = await failPutsWithQuotaError(2);

    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("quota");
    expect(outcome.ok === false && outcome.message).toBe(
      "This phone has no room left, so we did not save your receipt. Free up some space, then take the photo again.",
    );
    expect(outcome.ok === false && outcome.message).toBe(OUTBOX_STORAGE_FULL_MESSAGE);
    // One retry, not a loop: a phone that is full stays full, and a retry loop
    // on a blocked write is a frozen scan screen.
    expect(put).toHaveBeenCalledTimes(2);
    expect(await listOutboxItems()).toHaveLength(0);
  });

  it("still refuses honestly when the browser has no Cache Storage to purge", async () => {
    vi.stubGlobal("caches", undefined);
    await failPutsWithQuotaError(2);

    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe("quota");
  });
});

describe("outbox persistence request (doc 41 section 8)", () => {
  it("asks the browser to persist storage once a receipt is queued", async () => {
    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the capture was refused", async () => {
    for (let index = 0; index < 10; index += 1) {
      await putOutboxItem({ ...storedRow(index), id: `row-${index}` });
    }

    await enqueueCapturedReceipt(capture());

    expect(persist).not.toHaveBeenCalled();
  });

  it("still queues the receipt on a browser with no storage manager", async () => {
    vi.stubGlobal("navigator", {});

    const outcome = await enqueueCapturedReceipt(capture());

    expect(outcome.ok).toBe(true);
    expect(await listOutboxItems()).toHaveLength(1);
  });
});

describe("outbox row updates", () => {
  it("persists an attempt count and status durably", async () => {
    await putOutboxItem(storedRow(1));

    const updated = await updateOutboxItem("row-1", {
      attempts: 3,
      status: "failed",
      last_error: "network",
    });

    expect(updated?.attempts).toBe(3);
    vi.resetModules();
    const after = await import("./outbox");
    const [item] = await after.listOutboxItems();
    expect(item?.attempts).toBe(3);
    expect(item?.status).toBe("failed");
    expect(item?.last_error).toBe("network");
    // The patch touches only what it names.
    expect(item?.idempotency_key).toBe("key-1");
    expect(await item?.image.text()).toBe("jpeg-bytes");
  });

  it("returns null for a row that is no longer there", async () => {
    expect(await updateOutboxItem("row-gone", { attempts: 1 })).toBeNull();
  });

  it("deletes a row durably", async () => {
    await putOutboxItem(storedRow(1));

    await deleteOutboxItem("row-1");

    vi.resetModules();
    const after = await import("./outbox");
    expect(await after.listOutboxItems()).toHaveLength(0);
  });
});
