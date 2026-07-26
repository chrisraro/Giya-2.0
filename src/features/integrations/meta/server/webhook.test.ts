// @vitest-environment node

import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const serverEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => serverEnv,
}));

const store = vi.hoisted(() => ({
  entries: new Set<string>(),
  failing: { value: false },
}));

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  setNx: async (key: string) => {
    if (store.failing.value) throw new Error("redis unreachable (test)");
    if (store.entries.has(key)) return false;
    store.entries.add(key);
    return true;
  },
}));

import {
  SIGNATURE_HEADER,
  claimDelivery,
  extractDeauthorizedAccounts,
  verifyHandshake,
  verifyWebhookSignature,
} from "./webhook";

const SECRET = "test-meta-app-secret";
const VERIFY_TOKEN = "test-verify-token";

/** The body Meta would actually send, with the whitespace it would send. */
const RAW_BODY = JSON.stringify({
  object: "permissions",
  entry: [{ id: "1001", time: 1_790_000_000, changed_fields: ["pages_show_list"] }],
});

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

beforeEach(() => {
  store.entries.clear();
  store.failing.value = false;
  serverEnv.META_APP_SECRET = SECRET;
  serverEnv.META_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyWebhookSignature({ signature: sign(RAW_BODY), rawBody: RAW_BODY })).toEqual({
      ok: true,
    });
  });

  it("names the header Meta actually sends", () => {
    expect(SIGNATURE_HEADER).toBe("x-hub-signature-256");
  });

  it("VERIFIES AGAINST THE RAW BYTES, not a re-serialized parse", () => {
    // The mistake this whole module is written around. A body with
    // insignificant whitespace has a DIFFERENT signature from its compact
    // re-serialization, so a handler that hashed JSON.stringify(parsed) would
    // reject genuine deliveries - and, on the day the round trip happened to
    // be byte-identical, would accept a body that was not the one signed.
    const spaced = `{\n  "object": "permissions",\n  "entry": []\n}`;
    const compact = JSON.stringify(JSON.parse(spaced));
    expect(spaced).not.toBe(compact);

    // The signature over the bytes as received verifies.
    expect(verifyWebhookSignature({ signature: sign(spaced), rawBody: spaced }).ok).toBe(true);
    // The same signature against the re-serialized form does not.
    expect(verifyWebhookSignature({ signature: sign(spaced), rawBody: compact }).ok).toBe(false);
  });

  it("rejects a body altered by a single byte", () => {
    const signature = sign(RAW_BODY);
    const tampered = RAW_BODY.replace('"1001"', '"1002"');
    expect(verifyWebhookSignature({ signature, rawBody: tampered })).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("rejects a signature made with a different secret", () => {
    expect(
      verifyWebhookSignature({ signature: sign(RAW_BODY, "wrong-secret"), rawBody: RAW_BODY }),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a missing signature", () => {
    expect(verifyWebhookSignature({ signature: null, rawBody: RAW_BODY })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
    expect(verifyWebhookSignature({ signature: "", rawBody: RAW_BODY })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a bare digest with no algorithm prefix", () => {
    // Accepting one would mean accepting a `sha1=` prefix stripped by a
    // well-meaning proxy, and SHA-1 is not what we verify.
    const digest = sign(RAW_BODY).slice("sha256=".length);
    expect(verifyWebhookSignature({ signature: digest, rawBody: RAW_BODY })).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });

  it("rejects a sha1-prefixed signature", () => {
    expect(
      verifyWebhookSignature({ signature: `sha1=${"a".repeat(40)}`, rawBody: RAW_BODY }),
    ).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("rejects a digest of the wrong length or alphabet", () => {
    for (const bad of ["sha256=abc", `sha256=${"z".repeat(64)}`, "sha256="]) {
      expect(verifyWebhookSignature({ signature: bad, rawBody: RAW_BODY }).ok).toBe(false);
    }
  });

  it("FAILS CLOSED with no secret configured", () => {
    // A webhook endpoint that accepts unsigned requests "because the
    // integration is not configured yet" is an unauthenticated endpoint that
    // flips tenant connections to 'revoked' on request.
    delete serverEnv.META_APP_SECRET;
    expect(verifyWebhookSignature({ signature: sign(RAW_BODY), rawBody: RAW_BODY })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("never throws, so an unverifiable request cannot become a retryable 500", () => {
    expect(() =>
      verifyWebhookSignature({ signature: "sha256=", rawBody: RAW_BODY, secret: "" }),
    ).not.toThrow();
  });

  it("does not leak the secret in its result", () => {
    const result = verifyWebhookSignature({ signature: "sha256=" + "0".repeat(64), rawBody: "x" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe("verifyHandshake", () => {
  it("echoes the challenge when the token matches", () => {
    expect(
      verifyHandshake({ mode: "subscribe", token: VERIFY_TOKEN, challenge: "1158201444" }),
    ).toBe("1158201444");
  });

  it("refuses a wrong token", () => {
    expect(verifyHandshake({ mode: "subscribe", token: "nope", challenge: "115" })).toBeNull();
  });

  it("refuses a mode other than subscribe", () => {
    expect(
      verifyHandshake({ mode: "unsubscribe", token: VERIFY_TOKEN, challenge: "115" }),
    ).toBeNull();
  });

  it("refuses when no verify token is configured", () => {
    // Echoing any challenge presented to it would let anyone register OUR URL
    // against THEIR app.
    delete serverEnv.META_WEBHOOK_VERIFY_TOKEN;
    expect(
      verifyHandshake({ mode: "subscribe", token: VERIFY_TOKEN, challenge: "115" }),
    ).toBeNull();
  });

  it("refuses an absent challenge or token", () => {
    expect(verifyHandshake({ mode: "subscribe", token: VERIFY_TOKEN, challenge: null })).toBeNull();
    expect(verifyHandshake({ mode: "subscribe", token: null, challenge: "115" })).toBeNull();
  });

  it("does not accept the app secret as the verify token", () => {
    // The two are separate variables precisely so a screenshot of Meta's
    // console does not compromise the signature scheme.
    expect(verifyHandshake({ mode: "subscribe", token: SECRET, challenge: "115" })).toBeNull();
  });
});

describe("claimDelivery", () => {
  it("claims a delivery once", async () => {
    await expect(claimDelivery(RAW_BODY)).resolves.toBe(true);
    await expect(claimDelivery(RAW_BODY)).resolves.toBe(false);
  });

  it("treats a different body as a different event", async () => {
    await claimDelivery(RAW_BODY);
    await expect(claimDelivery(`${RAW_BODY} `)).resolves.toBe(true);
  });

  it("FAILS CLOSED when the dedupe store is unreachable", async () => {
    // Doc 42 asks for idempotency, not best effort. The cost is a missed
    // deauthorization that Meta will redeliver; the alternative cost is
    // processing a replayed event.
    store.failing.value = true;
    await expect(claimDelivery(RAW_BODY)).resolves.toBe(false);
  });
});

describe("extractDeauthorizedAccounts", () => {
  it("collects the entry ids", () => {
    expect(extractDeauthorizedAccounts(JSON.parse(RAW_BODY))).toEqual(["1001"]);
  });

  it("deduplicates repeated ids in one delivery", () => {
    expect(
      extractDeauthorizedAccounts({
        object: "page",
        entry: [{ id: "1001" }, { id: "1001" }, { id: "1002" }],
      }),
    ).toEqual(["1001", "1002"]);
  });

  it("returns nothing for a payload with no entries", () => {
    expect(extractDeauthorizedAccounts({})).toEqual([]);
    expect(extractDeauthorizedAccounts(null)).toEqual([]);
    expect(extractDeauthorizedAccounts("not an object")).toEqual([]);
    expect(extractDeauthorizedAccounts({ entry: "not an array" })).toEqual([]);
  });

  it("skips entries with no usable id", () => {
    expect(
      extractDeauthorizedAccounts({ entry: [{ id: 42 }, { id: "" }, null, { id: "1003" }] }),
    ).toEqual(["1003"]);
  });
});
