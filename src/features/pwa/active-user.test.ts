import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import {
  ACTIVE_USER_KEY,
  SESSION_DB_NAME,
  SESSION_DB_VERSION,
  SESSION_STORE_NAME,
  forgetActiveUser,
  readActiveUser,
  rememberActiveUser,
} from "./active-user";

// A REAL IndexedDB, for the same reason as outbox.test.ts: this record has to
// survive the worker being killed, and a test against an injected Map would
// pass whether it reached a database or a JavaScript variable. That is the
// exact failure this module was written to avoid - `SET_USER` would have put
// the answer in the worker's memory, which is empty every time a `sync` event
// fires.
//
// There is no injection seam in the module either; it reaches
// `globalThis.indexedDB` directly, so a test cannot be pointed somewhere else
// by accident.

const USER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Opens the session database at a HIGHER version, so the module's open fails. */
async function bumpDatabaseBeyondV1(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = (globalThis.indexedDB as IDBFactory).open(
      SESSION_DB_NAME,
      SESSION_DB_VERSION + 1,
    );
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe("the active user record", () => {
  it("is null before anybody signs in", async () => {
    expect(await readActiveUser()).toBeNull();
  });

  it("CRITICAL: survives a reader that never saw the write", async () => {
    // The property the whole module exists for. `rememberActiveUser` runs in a
    // page; `readActiveUser` runs in a service worker that may not have been
    // alive at the time, in a different JavaScript realm. Nothing in memory
    // connects them - only the database does.
    await rememberActiveUser(USER_A);

    // Fresh module instance, as a restarted worker would get.
    vi.resetModules();
    const { readActiveUser: readAgain } = await import("./active-user");

    expect(await readAgain()).toBe(USER_A);
  });

  it("replaces the previous consumer rather than accumulating", async () => {
    await rememberActiveUser(USER_A);
    await rememberActiveUser(USER_B);

    expect(await readActiveUser()).toBe(USER_B);
  });

  it("CRITICAL: forgetting leaves nobody, so a background drain does nothing", async () => {
    await rememberActiveUser(USER_A);

    await forgetActiveUser();

    // Not "some other user" and not the old one: the window between one
    // consumer logging out and the next opening a page is exactly when a sync
    // event must find no answer.
    expect(await readActiveUser()).toBeNull();
  });

  it("forgetting when nobody is recorded is a no-op, not a failure", async () => {
    await expect(forgetActiveUser()).resolves.not.toThrow();
    expect(await readActiveUser()).toBeNull();
  });

  it("stores exactly one row, under one key", async () => {
    await rememberActiveUser(USER_A);
    await rememberActiveUser(USER_B);

    // Read through the raw database, not through the module: a module that kept
    // its own idea of the key would agree with itself.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = (globalThis.indexedDB as IDBFactory).open(
        SESSION_DB_NAME,
        SESSION_DB_VERSION,
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const request = db
        .transaction(SESSION_STORE_NAME, "readonly")
        .objectStore(SESSION_STORE_NAME)
        .getAllKeys();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();

    expect(keys).toEqual([ACTIVE_USER_KEY]);
  });

  describe("when storage is unavailable", () => {
    it("CRITICAL: reads null rather than throwing, on a browser with no IndexedDB", async () => {
      vi.stubGlobal("indexedDB", undefined);

      await expect(readActiveUser()).resolves.toBeNull();
      await expect(rememberActiveUser(USER_A)).resolves.toBe(false);
      await expect(forgetActiveUser()).resolves.toBe(false);
    });

    it("CRITICAL: reads null rather than throwing, on a database that will not open", async () => {
      // A genuine VersionError from a real implementation, not a stub: an older
      // build meeting a newer database is what this actually looks like.
      await bumpDatabaseBeyondV1();

      await expect(readActiveUser()).resolves.toBeNull();
      await expect(rememberActiveUser(USER_A)).resolves.toBe(false);
      await expect(forgetActiveUser()).resolves.toBe(false);
    });
  });

  it("treats an empty or non-string stored value as nobody", async () => {
    // Anything on the origin can write to this database - it is a hint, not a
    // security boundary - and "" or a number must never be handed to the drain
    // as a user id, where it would match no row and could match a null one if
    // the ownership check were ever loosened.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = (globalThis.indexedDB as IDBFactory).open(
        SESSION_DB_NAME,
        SESSION_DB_VERSION,
      );
      request.onupgradeneeded = () => request.result.createObjectStore(SESSION_STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    for (const junk of ["", 42, null]) {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(SESSION_STORE_NAME, "readwrite");
        transaction.objectStore(SESSION_STORE_NAME).put(junk, ACTIVE_USER_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      expect(await readActiveUser()).toBeNull();
    }

    db.close();
  });
});
