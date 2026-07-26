// @vitest-environment node
//
// The perimeter of every worker route, so this suite is written as an attack
// list rather than a behaviour list: each test names a way in and asserts it is
// closed. The two happy-path tests exist so a change that closes everything by
// accident is caught too.
//
// Every call passes `keys` and `expectedOrigin` explicitly, so nothing here
// depends on the environment and no test can pass because a real key happened
// to be set.

import { createHash, createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// `getServerEnv` returns nothing at all, which is deliberate: every call below
// passes its keys explicitly, so a test that accidentally stopped doing so
// would fail rather than quietly verify against a real credential.
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

import { bodyHash, verifyQStashRequest } from "./verify";

const CURRENT_KEY = "sig_current_key_for_tests_only";
const NEXT_KEY = "sig_next_key_for_tests_only";
const PATH = "/api/jobs/notify.email";
const ORIGIN = "https://giya.example";

const NOW_MS = Date.UTC(2026, 6, 26, 12, 0, 0);
const now = (): number => NOW_MS;
const nowSeconds = Math.floor(NOW_MS / 1000);

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

interface TokenParts {
  readonly key?: string;
  readonly claims?: Record<string, unknown>;
  readonly signature?: string;
}

/** Mint a QStash-shaped JWS. `claims` is merged over the valid defaults, so a
 * test states only the field it is attacking. */
function mint(rawBody: string, parts: TokenParts = {}): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: "Upstash",
      sub: `${ORIGIN}${PATH}`,
      exp: nowSeconds + 300,
      nbf: nowSeconds - 1,
      iat: nowSeconds - 1,
      jti: "msg_test_0001",
      body: bodyHash(rawBody),
      ...(parts.claims ?? {}),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature =
    parts.signature ??
    createHmac("sha256", parts.key ?? CURRENT_KEY).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

const BODY = JSON.stringify({ job_id: "0198f000-0000-7000-8000-000000000001", notification_ids: [] });

function verify(signature: string | null, rawBody = BODY, path = PATH) {
  return verifyQStashRequest({
    signature,
    rawBody,
    path,
    now,
    keys: { current: CURRENT_KEY, next: NEXT_KEY },
    expectedOrigin: ORIGIN,
  });
}

describe("verifyQStashRequest", () => {
  it("accepts a request signed with the current key", () => {
    const result = verify(mint(BODY));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.issuer).toBe("Upstash");
      expect(result.claims.messageId).toBe("msg_test_0001");
    }
  });

  // Rule 2 in the module header. Upstash rotates by promoting `next` to
  // `current`, so for one window messages in flight are signed with either. A
  // verifier that only tried `current` would 401 live traffic on rotation day
  // and the outage would look like an Upstash problem.
  it("accepts a request signed with the next key", () => {
    expect(verify(mint(BODY, { key: NEXT_KEY })).ok).toBe(true);
  });

  // THE FORGERY. This is the whole point of the module: a well-formed token
  // with correct claims, an authentic-looking issuer and a real body hash,
  // signed with a key we do not hold.
  it("rejects a forged request signed with an attacker's key", () => {
    const forged = mint(BODY, { key: "sig_the_attacker_made_this_up" });
    const result = verify(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("does not match");
    }
  });

  // The lazier forgery: keep a captured token's claims and put anything in the
  // signature slot.
  it("rejects a token whose signature is not an HMAC at all", () => {
    expect(verify(mint(BODY, { signature: base64Url("not-a-signature") })).ok).toBe(false);
  });

  // The truncation attack `timingSafeEqual` would throw on if the length guard
  // were missing. A throw would surface as a 500, and QStash retries 5xx.
  it("rejects a signature of the wrong length without throwing", () => {
    const valid = mint(BODY);
    const truncated = `${valid.slice(0, valid.lastIndexOf(".") + 1)}${base64Url("short")}`;
    expect(() => verify(truncated)).not.toThrow();
    expect(verify(truncated).ok).toBe(false);
  });

  it("rejects a missing signature header", () => {
    const result = verify(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("missing");
  });

  it("rejects a signature that is not three dot-separated parts", () => {
    expect(verify("garbage").ok).toBe(false);
    expect(verify("a.b").ok).toBe(false);
    expect(verify("a.b.c.d").ok).toBe(false);
  });

  it("rejects a token whose payload is not JSON", () => {
    const header = base64Url(JSON.stringify({ alg: "HS256" }));
    const payload = base64Url("not json");
    const signingInput = `${header}.${payload}`;
    const signature = createHmac("sha256", CURRENT_KEY).update(signingInput).digest("base64url");
    expect(verify(`${signingInput}.${signature}`).ok).toBe(false);
  });

  // THE BODY SWAP, and the reason the `body` claim is checked at all. Without
  // it a signature authenticates a token rather than a request, so any captured
  // token would carry any payload - here, a job id of the attacker's choosing.
  it("rejects a valid token replayed with a different body", () => {
    const signature = mint(BODY);
    const swapped = JSON.stringify({ job_id: "0198f000-0000-7000-8000-0000000000ff" });
    const result = verify(signature, swapped);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("body hash");
  });

  it("rejects a token carrying no body hash", () => {
    expect(verify(mint(BODY, { claims: { body: undefined } })).ok).toBe(false);
  });

  it("accepts a body hash that arrives base64url-padded", () => {
    const padded = `${bodyHash(BODY)}==`;
    expect(verify(mint(BODY, { claims: { body: padded } })).ok).toBe(true);
  });

  it("computes the body hash as base64url(sha256(body))", () => {
    expect(bodyHash("hello")).toBe(createHash("sha256").update("hello").digest("base64url"));
  });

  // CROSS-ENDPOINT REPLAY. A genuine, correctly signed message for one worker,
  // captured and posted to another. It matters as soon as there is more than
  // one worker and it matters most when one of them is cheap and another is
  // expensive.
  it("rejects a genuine message replayed against a different worker route", () => {
    const result = verify(mint(BODY), BODY, "/api/jobs/ocr.process");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("path");
  });

  it("rejects a message addressed to a different origin", () => {
    const result = verifyQStashRequest({
      signature: mint(BODY, { claims: { sub: `https://evil.example${PATH}` } }),
      rawBody: BODY,
      path: PATH,
      now,
      keys: { current: CURRENT_KEY },
      expectedOrigin: ORIGIN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("origin");
  });

  // The origin check is skipped when unconfigured (behind a proxy the server
  // cannot derive its own public origin without trusting a caller-set header),
  // but the PATH check needs no configuration and must still hold.
  it("still enforces the path when no expected origin is configured", () => {
    const unconfigured = (path: string) =>
      verifyQStashRequest({
        signature: mint(BODY),
        rawBody: BODY,
        path,
        now,
        keys: { current: CURRENT_KEY },
        expectedOrigin: null,
      });
    expect(unconfigured(PATH).ok).toBe(true);
    expect(unconfigured("/api/jobs/ocr.process").ok).toBe(false);
  });

  it("tolerates a trailing slash on either side of the destination path", () => {
    expect(verify(mint(BODY, { claims: { sub: `${ORIGIN}${PATH}/` } })).ok).toBe(true);
    expect(verify(mint(BODY), BODY, `${PATH}/`).ok).toBe(true);
  });

  it("rejects a token whose issuer is not Upstash", () => {
    expect(verify(mint(BODY, { claims: { iss: "Evilstash" } })).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const result = verify(mint(BODY, { claims: { exp: nowSeconds - 3_600 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("expired");
  });

  it("rejects a token with no expiry at all", () => {
    expect(verify(mint(BODY, { claims: { exp: undefined } })).ok).toBe(false);
  });

  it("rejects a token that is not yet valid", () => {
    expect(verify(mint(BODY, { claims: { nbf: nowSeconds + 3_600 } })).ok).toBe(false);
  });

  // Serverless clocks drift. A zero-tolerance comparison would turn a 200ms
  // skew into a 401 storm, which fails closed in the least useful way.
  it("tolerates small clock skew in both directions", () => {
    expect(verify(mint(BODY, { claims: { exp: nowSeconds - 30 } })).ok).toBe(true);
    expect(verify(mint(BODY, { claims: { nbf: nowSeconds + 30 } })).ok).toBe(true);
  });

  // RULE 1, and the single most important test in this file. A worker route
  // with no signing key configured is not "open for local testing", it is an
  // unauthenticated remote-execution endpoint. Every other external dependency
  // in this codebase degrades to permissive; this one must not.
  it("rejects everything when no signing key is configured", () => {
    const result = verifyQStashRequest({
      signature: mint(BODY),
      rawBody: BODY,
      path: PATH,
      now,
      keys: {},
      expectedOrigin: ORIGIN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no QStash signing key");
  });

  // A misconfigured expected origin must not silently disable the origin check
  // and must not silently accept. Fail closed, and say which it was in the log.
  it("rejects when the configured origin is not a URL", () => {
    const result = verifyQStashRequest({
      signature: mint(BODY),
      rawBody: BODY,
      path: PATH,
      now,
      keys: { current: CURRENT_KEY },
      expectedOrigin: "not a url",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a destination that is not a URL", () => {
    expect(verify(mint(BODY, { claims: { sub: "/api/jobs/notify.email" } })).ok).toBe(false);
  });
});
