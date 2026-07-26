// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// An in-memory Redis with real GETDEL semantics. The single-use property is
// the whole point of this module, so a mock whose GETDEL did not delete would
// pass every test below while asserting nothing.
const store = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  failing: { value: false },
}));

function guard(): void {
  if (store.failing.value) throw new Error("redis unreachable (test)");
}

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  setNx: async (key: string, value: string) => {
    guard();
    if (store.entries.has(key)) return false;
    store.entries.set(key, value);
    return true;
  },
  getDel: async (key: string) => {
    guard();
    const value = store.entries.get(key) ?? null;
    store.entries.delete(key);
    return value;
  },
}));

import { STATE_TTL_SECONDS, issueState, verifyState } from "./state";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS = "22222222-2222-4222-8222-222222222222";
const USER = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_USER = "bbbbbbbb-2222-4222-8222-222222222222";
const REDIRECT = `https://giya.ph/api/v1/businesses/${BUSINESS}/integrations/meta/callback`;

async function mint(): Promise<string> {
  return issueState({ businessId: BUSINESS, userId: USER, redirectUri: REDIRECT });
}

beforeEach(() => {
  store.entries.clear();
  store.failing.value = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("issueState", () => {
  it("mints an unguessable, url-safe nonce", () => {
    // 32 random bytes as base64url. Not a uuid: v4 is 122 bits with a
    // recognisable shape, and the larger number costs nothing.
    return mint().then((state) => {
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  it("never repeats", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(await mint());
    expect(seen.size).toBe(200);
  });

  it("uses doc 42's ten-minute window", () => {
    expect(STATE_TTL_SECONDS).toBe(600);
  });
});

describe("verifyState", () => {
  it("accepts a state it issued, for the same business and user", async () => {
    const state = await mint();
    await expect(verifyState({ state, businessId: BUSINESS, userId: USER })).resolves.toEqual({
      ok: true,
      redirectUri: REDIRECT,
    });
  });

  it("REFUSES A REPLAY", async () => {
    // Attack 3 in this module's header: the same callback URL fetched twice,
    // by a refresh, a preloading browser, or an attacker who kept it.
    const state = await mint();

    const first = await verifyState({ state, businessId: BUSINESS, userId: USER });
    expect(first.ok).toBe(true);

    const second = await verifyState({ state, businessId: BUSINESS, userId: USER });
    expect(second).toEqual({ ok: false, reason: "unknown" });
  });

  it("REFUSES A STATE MINTED FOR A DIFFERENT BUSINESS", async () => {
    // Attack 2: a user who legitimately administers tenant A replays the
    // callback against tenant B's callback path.
    const state = await mint();
    await expect(
      verifyState({ state, businessId: OTHER_BUSINESS, userId: USER }),
    ).resolves.toEqual({ ok: false, reason: "business_mismatch" });
  });

  it("REFUSES A MISSING STATE", async () => {
    // Attack 1 in its simplest form: a bare `?code=...` from an attacker who
    // captured a code from their own flow.
    await expect(verifyState({ state: null, businessId: BUSINESS, userId: USER })).resolves.toEqual(
      { ok: false, reason: "missing" },
    );
    await expect(verifyState({ state: "", businessId: BUSINESS, userId: USER })).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("refuses a state minted by a different user of the same tenant", async () => {
    const state = await mint();
    await expect(verifyState({ state, businessId: BUSINESS, userId: OTHER_USER })).resolves.toEqual(
      { ok: false, reason: "user_mismatch" },
    );
  });

  it("BURNS THE STATE even when the business does not match", async () => {
    // The consume happens BEFORE the comparison, deliberately: a verification
    // that leaves the value usable after a failed attempt is one an attacker
    // can iterate against until they hit the right tenant.
    const state = await mint();
    await verifyState({ state, businessId: OTHER_BUSINESS, userId: USER });

    await expect(verifyState({ state, businessId: BUSINESS, userId: USER })).resolves.toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  it("refuses a state that was never issued", async () => {
    await expect(
      verifyState({ state: "A".repeat(43), businessId: BUSINESS, userId: USER }),
    ).resolves.toEqual({ ok: false, reason: "unknown" });
  });

  it("refuses a state outside the permitted alphabet before touching Redis", async () => {
    // `state` arrives from the query string and the colon is the Redis key
    // separator: without this check an attacker-supplied state could address a
    // key in another namespace entirely.
    for (const candidate of [
      "short",
      "has:colon:in:it-padded-to-length-aaaaaaaaaaaa",
      "has spaces in it padded to the minimum length",
      `${"a".repeat(129)}`,
    ]) {
      const result = await verifyState({
        state: candidate,
        businessId: BUSINESS,
        userId: USER,
      });
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }
    expect(store.entries.size).toBe(0);
  });

  it("refuses a stored value that is not the expected shape", async () => {
    store.entries.set(`test:meta:oauth:${"z".repeat(43)}`, "not json");
    await expect(
      verifyState({ state: "z".repeat(43), businessId: BUSINESS, userId: USER }),
    ).resolves.toEqual({ ok: false, reason: "malformed" });
  });

  it("FAILS CLOSED when the state store is unreachable", async () => {
    // The deliberate counterpoint to the circuit breaker, which fails open. A
    // CSRF check that cannot read its store has not checked anything.
    const state = await mint();
    store.failing.value = true;

    await expect(verifyState({ state, businessId: BUSINESS, userId: USER })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("binds the redirect_uri, so the exchange cannot be pointed elsewhere", async () => {
    // Meta requires the redirect_uri on the token exchange to be identical to
    // the one the dialog was opened with. Reading it back from the state
    // rather than rebuilding it from the callback request is what keeps that
    // value out of the caller's influence.
    const state = await issueState({
      businessId: BUSINESS,
      userId: USER,
      redirectUri: "https://giya.ph/exact/path",
    });
    const result = await verifyState({ state, businessId: BUSINESS, userId: USER });
    expect(result.ok === true ? result.redirectUri : null).toBe("https://giya.ph/exact/path");
  });
});
