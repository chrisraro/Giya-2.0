import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import { readActiveUser } from "@/features/pwa/active-user";

import { ActiveUserRecord } from "./active-user-record";

// A COMPONENT THAT RENDERS NOTHING IS THE EASIEST KIND TO GET WRONG.
//
// Its whole output is a side effect, so "it is mounted in the consumer layout"
// and "the record it writes can be read back" are both true of a component
// whose effect body is empty - and both were, in a first draft. A mutant that
// deleted the `rememberActiveUser` call survived a source assertion in the
// layout and an executable assertion on the module, because neither of them ran
// this component.
//
// Real IndexedDB again: the record has to outlive the page, which is the only
// reason it is in a database rather than in a variable.

const USER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ActiveUserRecord", () => {
  it("CRITICAL: records the signed-in consumer where the service worker can read it", async () => {
    // Without this write the background replay reads null forever, drains
    // nothing, and `registerOutboxSync` becomes a call no worker answers.
    render(<ActiveUserRecord userId={USER_A} />);

    await waitFor(async () => expect(await readActiveUser()).toBe(USER_A));
  });

  it("records the CURRENT consumer when the props change", async () => {
    const { rerender } = render(<ActiveUserRecord userId={USER_A} />);
    await waitFor(async () => expect(await readActiveUser()).toBe(USER_A));

    rerender(<ActiveUserRecord userId={USER_B} />);

    // A stale record is the dangerous direction: it would let a sync event
    // submit the previous consumer's rows under this one's session.
    await waitFor(async () => expect(await readActiveUser()).toBe(USER_B));
  });

  it("renders nothing", () => {
    const { container } = render(<ActiveUserRecord userId={USER_A} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("CRITICAL: does not throw on a browser with no IndexedDB", async () => {
    // Safari private windows, site data blocked. The page must still render;
    // the cost of a missing record is a deferred background drain.
    vi.stubGlobal("indexedDB", undefined);

    expect(() => render(<ActiveUserRecord userId={USER_A} />)).not.toThrow();
  });
});
