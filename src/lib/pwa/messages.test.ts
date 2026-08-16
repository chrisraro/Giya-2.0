import { describe, expect, it } from "vitest";

import {
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

  it("ignores the four types this task deliberately does not implement", () => {
    // Doc 41's me-cache and outbox rows are T5.3's; NAVIGATE is the push
    // work's. Declared, not handled - and "not handled" must be a no-op, not a
    // crash, because a T5.3 client will post SET_USER at a T5.1 worker during
    // the deploy that ships it.
    expect(swMessageAction({ type: "SET_USER", payload: { userId: "u1" } })).toBe("ignore");
    expect(swMessageAction({ type: "PURGE_USER_CACHES" })).toBe("ignore");
    expect(swMessageAction({ type: "OUTBOX_CHANGED" })).toBe("ignore");
    expect(swMessageAction({ type: "NAVIGATE", payload: { route: "/wallet" } })).toBe("ignore");
  });

  it("ignores unknown and malformed messages", () => {
    expect(swMessageAction({ type: "DEFROST_THE_FRIDGE" })).toBe("ignore");
    expect(swMessageAction(undefined)).toBe("ignore");
    expect(swMessageAction("SKIP_WAITING")).toBe("ignore");
  });
});
