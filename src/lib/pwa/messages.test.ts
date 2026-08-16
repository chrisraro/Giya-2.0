import { describe, expect, it } from "vitest";

import {
  OUTBOX_CHANGED_MESSAGE,
  PURGE_USER_CACHES_MESSAGE,
  SKIP_WAITING_MESSAGE,
  SW_MESSAGE_TYPES,
  parseSwMessage,
  swMessageAction,
} from "./messages";

// THE SW <-> APP PROTOCOL REGISTRY (doc 41 section 1).
//
// Five message types are specified. T5.1 implements exactly one of them -
// SKIP_WAITING, the update flow's accept - and declares the other four so T5.3
// (SET_USER / PURGE_USER_CACHES / OUTBOX_CHANGED) and the push work (NAVIGATE)
// EXTEND this union rather than inventing parallel string literals.
//
// The protocol is forward-compatible by design, and that cuts both ways during
// a deploy: an OLD service worker is controlling a NEW page for the seconds
// between activate and reload, so it will be handed types it has never heard
// of. Doc 41 says unknown types are ignored. A throw inside a `message`
// listener is an unhandled rejection in the worker, so "ignored" is not
// politeness - it is what keeps the worker alive through a version skew.

describe("SW message registry", () => {
  it("declares exactly the five types doc 41 section 1 names", () => {
    // Literals, not a re-export of the constant: the doc is the authority here,
    // not the code.
    expect([...SW_MESSAGE_TYPES]).toEqual([
      "SET_USER",
      "PURGE_USER_CACHES",
      "SKIP_WAITING",
      "OUTBOX_CHANGED",
      "NAVIGATE",
    ]);
  });

  it("ships SKIP_WAITING as a ready-made payload the update toast can post", () => {
    expect(SKIP_WAITING_MESSAGE).toEqual({ type: "SKIP_WAITING" });
  });

  it("ships PURGE_USER_CACHES as a ready-made payload the logout path can post", () => {
    // A literal, not a re-export: the constant and the type union have to agree
    // on the spelling, and comparing the constant to itself could not tell.
    expect(PURGE_USER_CACHES_MESSAGE).toEqual({ type: "PURGE_USER_CACHES" });
  });

  it("carries no payload on PURGE_USER_CACHES, because the purge is by cache class", () => {
    // The worker deletes every giya-pages-* and giya-me-*. It is never told
    // WHOSE session ended, so it cannot purge the wrong person's caches and does
    // not depend on a SET_USER that was never implemented.
    expect(Object.hasOwn(PURGE_USER_CACHES_MESSAGE, "payload")).toBe(false);
  });

  it("keeps the three implemented messages distinct", () => {
    const types = [SKIP_WAITING_MESSAGE, PURGE_USER_CACHES_MESSAGE, OUTBOX_CHANGED_MESSAGE].map(
      (message) => message.type,
    );
    expect(new Set(types).size).toBe(3);
  });
});

describe("parseSwMessage", () => {
  it("accepts a declared type", () => {
    expect(parseSwMessage({ type: "SKIP_WAITING" })).toEqual({ type: "SKIP_WAITING" });
  });

  it("carries the payload through for types that have one", () => {
    // NAVIGATE is the push work's; parsing must not drop the route it exists
    // to deliver.
    expect(parseSwMessage({ type: "NAVIGATE", payload: { route: "/wallet" } })).toEqual({
      type: "NAVIGATE",
      payload: { route: "/wallet" },
    });
  });

  it("CRITICAL: ignores an unknown type instead of throwing", () => {
    expect(() => parseSwMessage({ type: "DEFROST_THE_FRIDGE" })).not.toThrow();
    expect(parseSwMessage({ type: "DEFROST_THE_FRIDGE" })).toBeNull();
  });

  it("CRITICAL: ignores malformed data instead of throwing", () => {
    // Anything on the page can call `postMessage` at a service worker, and a
    // browser extension will.
    for (const junk of [null, undefined, "SKIP_WAITING", 42, [], {}, { type: 7 }, { type: null }]) {
      expect(() => parseSwMessage(junk)).not.toThrow();
      expect(parseSwMessage(junk)).toBeNull();
    }
  });
});

describe("swMessageAction", () => {
  it("asks the worker to skip waiting on SKIP_WAITING", () => {
    expect(swMessageAction({ type: "SKIP_WAITING" })).toBe("skip-waiting");
  });

  it("CRITICAL: purges the authenticated caches on PURGE_USER_CACHES", () => {
    // The action the logout path depends on. Falling through to "ignore" here
    // is what the whole of T5.3b exists to stop: the message is posted, the
    // worker shrugs, and the next consumer is served the previous one's /home.
    expect(swMessageAction(PURGE_USER_CACHES_MESSAGE)).toBe("purge-user-caches");
    // And through the wire shape, not only the constant: the app posts a plain
    // structured-cloned object, which is what actually arrives.
    expect(swMessageAction({ type: "PURGE_USER_CACHES" })).toBe("purge-user-caches");
  });

  it("purges regardless of any payload a caller invents", () => {
    // Forward compatibility in the direction that matters here. A future client
    // that starts sending a user id must not turn the purge into a no-op at an
    // older worker.
    expect(swMessageAction({ type: "PURGE_USER_CACHES", payload: { userId: "u1" } })).toBe(
      "purge-user-caches",
    );
  });

  it("ignores the three types this worker deliberately does not act on", () => {
    // SET_USER belongs to doc 41 section 4's me-cache, which is deferred; a
    // handler for it would store state nothing reads. OUTBOX_CHANGED travels
    // SW -> app. NAVIGATE is the push work's. "Not handled" must be a no-op and
    // not a crash, because a new client will post at an old worker during the
    // deploy that ships it.
    expect(swMessageAction({ type: "SET_USER", payload: { userId: "u1" } })).toBe("ignore");
    expect(swMessageAction({ type: "OUTBOX_CHANGED" })).toBe("ignore");
    expect(swMessageAction({ type: "NAVIGATE", payload: { route: "/wallet" } })).toBe("ignore");
  });

  it("does not purge on any other message", () => {
    // The purge deletes caches. A parser that answered "purge-user-caches" too
    // eagerly would throw away the app shell whenever an extension posted junk.
    for (const data of [
      { type: "SKIP_WAITING" },
      { type: "SET_USER" },
      { type: "OUTBOX_CHANGED" },
      { type: "NAVIGATE" },
      { type: "DEFROST_THE_FRIDGE" },
      undefined,
      "PURGE_USER_CACHES",
    ]) {
      expect(swMessageAction(data)).not.toBe("purge-user-caches");
    }
  });

  it("ignores unknown and malformed messages", () => {
    expect(swMessageAction({ type: "DEFROST_THE_FRIDGE" })).toBe("ignore");
    expect(swMessageAction(undefined)).toBe("ignore");
    expect(swMessageAction("SKIP_WAITING")).toBe("ignore");
  });
});
