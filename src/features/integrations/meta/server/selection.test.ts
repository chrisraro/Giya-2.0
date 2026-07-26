// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({
  entries: new Map<string, string>(),
}));

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  setNx: async (key: string, value: string) => {
    if (store.entries.has(key)) return false;
    store.entries.set(key, value);
    return true;
  },
  get: async (key: string) => store.entries.get(key) ?? null,
  getDel: async (key: string) => {
    const value = store.entries.get(key) ?? null;
    store.entries.delete(key);
    return value;
  },
}));

import { consumeSelection, peekSelectablePages, storePendingSelection } from "./selection";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-1111-4111-8111-111111111111";
const PAGE_TOKEN = "EAAGpage-scoped-token-value";

const SELECTION = {
  businessId: BUSINESS,
  userId: USER,
  pages: [
    { id: "1001", name: "Kape Cebu", category: "Coffee shop", accessToken: PAGE_TOKEN },
    { id: "1002", name: "Kape Manila", category: null, accessToken: "EAAGsecond" },
  ],
  grantedScopes: ["pages_show_list", "read_insights"],
  tokenExpiresAt: "2026-09-01T00:00:00.000Z",
} as const;

beforeEach(() => {
  store.entries.clear();
  process.env.INTEGRATION_TOKEN_AES_KEY = Buffer.alloc(32, 5).toString("base64");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("storePendingSelection", () => {
  it("stores the payload ENCRYPTED, never in plaintext", async () => {
    // These are page access tokens: exactly the class of value migration 0032
    // refuses to let a client role read out of Postgres. Leaving them readable
    // in a key-value store with no column grants would be incoherent.
    await storePendingSelection(SELECTION);

    const stored = [...store.entries.values()].join("");
    expect(stored).not.toContain(PAGE_TOKEN);
    expect(stored).not.toContain("Kape Cebu");
    expect(stored).not.toContain(BUSINESS);
    // and it is the token-cipher envelope, version byte first
    expect(Buffer.from(stored, "base64")[0]).toBe(1);
  });

  it("returns an opaque id with no structure", async () => {
    const id = await storePendingSelection(SELECTION);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(id).not.toContain(BUSINESS);
    expect(id).not.toContain(USER);
  });
});

describe("peekSelectablePages", () => {
  it("returns the page names WITHOUT any token", async () => {
    const selectionId = await storePendingSelection(SELECTION);

    const pages = await peekSelectablePages({ selectionId, businessId: BUSINESS, userId: USER });

    expect(pages).toEqual([
      { id: "1001", name: "Kape Cebu", category: "Coffee shop" },
      { id: "1002", name: "Kape Manila", category: null },
    ]);
    // The assertion behind "a token never reaches a client component": this is
    // the value the settings page hands to the picker.
    expect(JSON.stringify(pages)).not.toContain(PAGE_TOKEN);
    expect(JSON.stringify(pages)).not.toContain("accessToken");
  });

  it("does NOT consume the selection, so a refresh does not empty the picker", async () => {
    const selectionId = await storePendingSelection(SELECTION);

    await peekSelectablePages({ selectionId, businessId: BUSINESS, userId: USER });
    await expect(
      peekSelectablePages({ selectionId, businessId: BUSINESS, userId: USER }),
    ).resolves.toHaveLength(2);
  });

  it("refuses a selection belonging to another business", async () => {
    const selectionId = await storePendingSelection(SELECTION);
    await expect(
      peekSelectablePages({
        selectionId,
        businessId: "99999999-9999-4999-8999-999999999999",
        userId: USER,
      }),
    ).resolves.toBeNull();
  });

  it("refuses a selection belonging to another user", async () => {
    const selectionId = await storePendingSelection(SELECTION);
    await expect(
      peekSelectablePages({
        selectionId,
        businessId: BUSINESS,
        userId: "99999999-9999-4999-8999-999999999999",
      }),
    ).resolves.toBeNull();
  });

  it("refuses an id outside the permitted alphabet without touching Redis", async () => {
    await expect(
      peekSelectablePages({ selectionId: "has:a:colon", businessId: BUSINESS, userId: USER }),
    ).resolves.toBeNull();
  });

  it("refuses a payload that was tampered with in the store", async () => {
    const selectionId = await storePendingSelection(SELECTION);
    const key = [...store.entries.keys()][0] ?? "";
    const bytes = Buffer.from(store.entries.get(key) ?? "", "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    store.entries.set(key, bytes.toString("base64"));

    await expect(
      peekSelectablePages({ selectionId, businessId: BUSINESS, userId: USER }),
    ).resolves.toBeNull();
  });

  it("refuses everything once the encryption key has rotated away", async () => {
    const selectionId = await storePendingSelection(SELECTION);
    process.env.INTEGRATION_TOKEN_AES_KEY = `k9:${Buffer.alloc(32, 6).toString("base64")}`;
    await expect(
      peekSelectablePages({ selectionId, businessId: BUSINESS, userId: USER }),
    ).resolves.toBeNull();
  });
});

describe("consumeSelection", () => {
  it("returns the pages WITH their tokens, exactly once", async () => {
    const selectionId = await storePendingSelection(SELECTION);

    const first = await consumeSelection({ selectionId, businessId: BUSINESS, userId: USER });
    expect(first?.pages[0]?.accessToken).toBe(PAGE_TOKEN);
    expect(first?.grantedScopes).toEqual(["pages_show_list", "read_insights"]);

    // Single use: a double-submitted form cannot connect twice, and an
    // abandoned flow leaves nothing behind.
    const second = await consumeSelection({ selectionId, businessId: BUSINESS, userId: USER });
    expect(second).toBeNull();
  });

  it("burns the selection even when the binding check fails", async () => {
    // Same reasoning as the state nonce: a failed attempt must not leave the
    // value usable for the next guess.
    const selectionId = await storePendingSelection(SELECTION);
    await consumeSelection({
      selectionId,
      businessId: "99999999-9999-4999-8999-999999999999",
      userId: USER,
    });
    await expect(
      consumeSelection({ selectionId, businessId: BUSINESS, userId: USER }),
    ).resolves.toBeNull();
  });
});
