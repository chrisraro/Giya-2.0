import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PURGE_USER_CACHES_MESSAGE, swMessageAction } from "@/lib/pwa/messages";
import { purgeUserCaches } from "@/lib/pwa/purge";

// THE OTHER HALF OF THE LOGOUT PURGE (doc 41 preamble rule 2, section 8).
//
// `src/components/pwa/logout-form.tsx` posts PURGE_USER_CACHES on the way out
// of a session. If no worker acts on it the call is DECORATION: it succeeds, it
// looks like the feature, and the next consumer to sign in on that phone is
// still served the previous one's /home document.
//
// WHAT THIS FILE PROVES, AND WHAT IT DOES NOT.
//
// `src/app/sw.ts` only ever executes inside a ServiceWorkerGlobalScope - no
// `self`, no `caches`, no ExtendableMessageEvent - so it cannot be imported and
// run here. Both decisions it delegates ARE tested by execution:
// `swMessageAction` in src/lib/pwa/messages.test.ts and `purgeUserCaches` in
// src/lib/pwa/purge.test.ts, the latter against an in-memory store where the
// assertion is that the document is no longer retrievable. What is left in
// sw.ts is three lines of wiring, and this file reads them as source the same
// way src/app/outbox-sync-wiring.test.ts does.
//
// Every source assertion below is PAIRED with an executable one that runs the
// thing being named, so a mutant that kept the words and gutted the function
// cannot survive here on the strength of the spelling.
//
// It does NOT prove that a browser delivers the message, that `waitUntil` keeps
// the worker alive long enough, or that a real CacheStorage deletes. Doc 41
// section 11's Playwright `pwa-offline` project is where that belongs.

const SW = readFileSync(join(process.cwd(), "src", "app", "sw.ts"), "utf8");

/**
 * The same file with comments removed.
 *
 * sw.ts is heavily commented, including comments that quote the identifiers
 * being asserted. A T5.3a mutant that turned `retryFailed: true` into
 * `retryFailed: false, // retryFailed: true` survived a match against the raw
 * source for exactly that reason.
 */
const SW_CODE = SW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("service worker logout purge wiring (doc 41 preamble rule 2, section 8)", () => {
  it("acts on the purge action, and that action is what a real PURGE_USER_CACHES resolves to", () => {
    // The two halves have to agree. `swMessageAction` is a union, so a typo in
    // the worker's literal is a type error rather than a silent no-op - but a
    // BRANCH that was never written is neither, which is what this catches.
    expect(SW_CODE).toContain('action === "purge-user-caches"');
    expect(swMessageAction(PURGE_USER_CACHES_MESSAGE)).toBe("purge-user-caches");
  });

  it("hands the whole of Cache Storage to the purge, inside waitUntil", () => {
    // `waitUntil`, not a bare `void`: the page that posted this is already
    // navigating to /login, and a worker with nothing extending it can be killed
    // with half the caches still there.
    expect(SW_CODE).toMatch(/event\.waitUntil\(purgeUserCaches\(caches\)\)/);
  });

  it("CRITICAL: the function it calls really removes the previous consumer's document", async () => {
    // The executable half of the assertion above. Without this, a mutant that
    // emptied purgeUserCaches would leave the source match intact and the worker
    // calling a function that does nothing - the exact failure Wave 5 keeps
    // paying for.
    const stores = new Map<string, Map<string, string>>([
      ["giya-pages-b1", new Map([["/home", "<html>Hi Ana. 1,240 points.</html>"]])],
      ["giya-static-b1", new Map([["/_next/static/chunk.js", "app shell"]])],
    ]);
    const storage = {
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name: string) => Promise.resolve(stores.delete(name)),
    };

    await purgeUserCaches(storage);

    expect(stores.get("giya-pages-b1")).toBeUndefined();
    expect(stores.get("giya-static-b1")?.get("/_next/static/chunk.js")).toBe("app shell");
  });

  it("still skips waiting on SKIP_WAITING, so the update flow survived the new branch", () => {
    // The purge branch was added to a listener that already had one job. An
    // early `return` in the wrong place would have taken the update toast's
    // accept with it.
    expect(SW_CODE).toContain("void self.skipWaiting();");
    expect(swMessageAction({ type: "SKIP_WAITING" })).toBe("skip-waiting");
  });
});
