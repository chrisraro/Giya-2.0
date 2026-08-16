import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import { OUTBOX_SYNC_TAG, isOutboxSyncTag } from "@/features/pwa/outbox-replay";
import { parseSwMessage } from "@/lib/pwa/messages";

// THE OTHER HALF OF BACKGROUND SYNC.
//
// `registerOutboxSync` asks the browser to fire a `sync` event with the tag
// `receipt-outbox` (doc 41 section 3 step 1). If no worker listens for that
// tag, the call is DECORATION: it succeeds, it looks like the feature, and
// nothing drains. That is precisely the shape of bug Wave 5 has been paying
// for, so the listener is pinned here.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
//
// `src/app/sw.ts` is the one file in the repo that only ever executes inside a
// ServiceWorkerGlobalScope, so it cannot be imported and run in a normal test:
// there is no `self`, no `clients`, no `sync` event. Its decisions therefore
// live in `src/features/pwa/outbox-replay.ts`, which IS tested by execution
// (outbox-replay.test.ts), and what remains in sw.ts is wiring. This file reads
// that wiring as source, the same way src/app/service-worker-scope.test.ts
// reads the registration site.
//
// It proves three things: a `sync` listener exists, it gates on the shared tag
// predicate rather than a literal of its own, and the drain runs inside
// `waitUntil` so the browser keeps the worker alive for it. It does NOT prove
// the browser fires the event, that credentials reach the fetch from a worker,
// or that the drain succeeds against a real server. Doc 41 section 11 puts
// those in the Playwright `pwa-offline` project, scenarios 2 and 3.

const SW = readFileSync(join(process.cwd(), "src", "app", "sw.ts"), "utf8");

/**
 * The same file with comments removed.
 *
 * Every assertion below is about CODE, and this file is heavily commented -
 * including comments that quote the very identifiers being asserted. A mutant
 * that turned `retryFailed: true` into `retryFailed: false, // retryFailed: true`
 * survived a match against the raw source for exactly that reason.
 */
const SW_CODE = SW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("service worker outbox sync wiring (doc 41 sections 3 and 6)", () => {
  it("listens for sync events", () => {
    expect(SW_CODE).toMatch(/addEventListener\(\s*"sync"/);
  });

  it("gates on the shared tag predicate, so the two sides cannot drift", () => {
    // The value that matters. If the handler carried its own string literal,
    // renaming the tag on the registration side would leave both halves
    // compiling, both tests passing, and no receipt ever drained in the
    // background. Sharing `isOutboxSyncTag` makes that a type error instead.
    expect(SW_CODE).toContain("isOutboxSyncTag(event.tag)");
    expect(SW_CODE).not.toMatch(/event\.tag\s*===\s*"/);
    // And the predicate the worker shares is the one the app registers with.
    expect(isOutboxSyncTag(OUTBOX_SYNC_TAG)).toBe(true);
  });

  it("runs the drain inside waitUntil, so the browser does not kill the worker mid-upload", () => {
    expect(SW_CODE).toMatch(/event\.waitUntil\(replayOutbox\(\)\)/);
    expect(SW_CODE).toMatch(/drainOutbox\(/);
  });

  it("tells open tabs the queue changed, using a message the app recognises", () => {
    // Doc 41 section 1's OUTBOX_CHANGED. Posting a type the app's parser drops
    // would be a silent no-op, which is why the constant is asserted through
    // that same parser rather than by eye.
    // The POST, not the import. A first draft asserted only that the constant
    // appeared somewhere in the file, and a mutant that dropped the
    // postMessage call survived it: the import line still named the constant.
    expect(SW_CODE).toMatch(/\.postMessage\(OUTBOX_CHANGED_MESSAGE\)/);
    expect(parseSwMessage({ type: "OUTBOX_CHANGED" })?.type).toBe("OUTBOX_CHANGED");
  });

  it("lets the background replay reach rows that spent their five attempts", () => {
    // A `sync` event only fires because the browser decided connectivity is
    // back, which is the same evidence the app's `online` handler acts on. With
    // `retryFailed: false` the one replay path that runs with the app CLOSED
    // would skip exactly the receipts that most need it - and doc 41 section 8
    // gives an iOS outbox about seven days before eviction.
    // Tied to the drainOutbox call rather than matched anywhere in the file -
    // the same narrowing the OUTBOX_CHANGED assertion needed after a mutant
    // that dropped the postMessage survived on the import line alone.
    expect(SW_CODE).toMatch(/drainOutbox\(\{[^}]*retryFailed: true/);
  });

  it("CRITICAL: drains for the recorded consumer, and for nobody when there is none", () => {
    // A worker has no session. Without an answer to "who is signed in" the
    // background replay would drain EVERY row on the device, and on a shared
    // phone that means submitting consumer A's receipt under consumer B's
    // session: 403 FORBIDDEN, which the replay classifies terminal, which
    // deletes A's only copy of the photo.
    //
    // Tied to the drainOutbox call rather than matched anywhere in the file,
    // the same narrowing the retryFailed assertion above needed.
    expect(SW_CODE).toMatch(/drainOutbox\(\{[^}]*userId,/);
    expect(SW_CODE).toContain("const userId = await readActiveUser();");
    expect(SW_CODE).toContain("if (userId === null) return;");
  });

  it("and the record it reads really is empty until somebody signs in", async () => {
    // The executable half. A source match alone would survive a
    // `readActiveUser` that answered with a constant, which is the failure mode
    // the guard exists to prevent - it would hand the drain a user id nobody is
    // signed in as.
    vi.stubGlobal("indexedDB", new IDBFactory());
    try {
      const { readActiveUser, rememberActiveUser } = await import("@/features/pwa/active-user");
      expect(await readActiveUser()).toBeNull();
      await rememberActiveUser("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
      expect(await readActiveUser()).toBe("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("and somebody actually writes that record, or the background replay is decoration", () => {
    // The other direction of the same defect. With the guard above and nothing
    // writing the record, `readActiveUser()` is always null, the background
    // drain never runs, and `registerOutboxSync` goes back to being a call
    // nothing answers - which is the exact bug the top of this file describes.
    //
    // The consumer LAYOUT, not /scan: B signs in, lands on /home, never opens
    // the scan screen, and a sync event fires against A's leftover rows.
    const layout = readFileSync(
      join(process.cwd(), "src", "app", "(consumer)", "layout.tsx"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\/.*$/gm, "");

    expect(layout).toContain("<ActiveUserRecord userId={user.id} />");
  });

  it("says nothing to a tab when the drain removed no rows", () => {
    // An idempotent handler is required (doc 41 section 6: "safe to fire with
    // an empty outbox"). Waking every open tab to tell it nothing happened is
    // the cheap kind of wrong that shows up as battery.
    expect(SW_CODE).toContain("if (result.removed === 0) return;");
  });
});
