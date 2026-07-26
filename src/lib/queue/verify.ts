import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env";

// =============================================================================
// QStash request verification.
// =============================================================================
//
// docs/30-modules/39-background-jobs.md, "Worker invocation contract", step 1:
// "Signature verification. `Upstash-Signature` verified against current + next
// QStash signing keys (src/lib/queue/verify.ts). Failure -> 401, no processing.
// No other caller can reach /api/jobs/*."
//
// This module is the entire perimeter of the worker routes. Those routes have
// no session, no cookie, no CSRF token and no rate limiter in front of them:
// they are unauthenticated HTTP endpoints on the public internet whose whole
// job is to take instructions from a JSON body and act on them as the service
// role. Everything that stops the internet from sending those instructions is
// in this file.
//
// -----------------------------------------------------------------------------
// THE FOUR RULES THIS FILE IS WRITTEN AROUND
// -----------------------------------------------------------------------------
//
// 1. FAIL CLOSED, ALWAYS. Every other external-dependency module in this
//    codebase fails soft (src/lib/ai/llm.ts returns null, raise.ts swallows,
//    the rate limiter opens). This one is the opposite and it is the deliberate
//    counterexample, the same way src/lib/api/handler.ts's idempotency gate is:
//    an unreadable config, a missing key, an unexpected exception, a claim it
//    cannot parse - all of it is `false`. A verifier that cannot verify has not
//    verified. There is no path through this module that returns ok on an
//    error, including the catch-all at the bottom.
//
// 2. BOTH KEYS, ALWAYS. Upstash rotates by promoting `next` to `current`, so
//    for one window messages in flight are signed with either. Trying only
//    `current` means a rotation silently starts 401-ing live traffic; trying
//    `next` only after `current` "fails" is the same thing said twice, so both
//    are simply tried. Neither configured means nothing verifies, which by rule
//    1 means nothing is accepted.
//
// 3. CONSTANT TIME on the signature comparison. A byte-by-byte `===` on an HMAC
//    leaks, in its timing, how many leading bytes of a guess were right, which
//    turns forging a signature from 2^256 work into 32 x 256. It is a small
//    risk over a network and it costs one function call to remove.
//
// 4. THE REASON NEVER LEAVES THE SERVER. `verifyQStashRequest` returns a reason
//    string and the route logs it and returns a bare 401. "Signature mismatch",
//    "expired", "wrong destination" and "no signing key configured" are four
//    different pieces of information about our configuration, and handing them
//    to whoever is probing the endpoint turns a closed door into an oracle
//    (it tells an attacker whether the endpoint is even wired up, and it tells
//    them when their forgery is failing for a reason other than the signature).
//
// -----------------------------------------------------------------------------
// WHAT IS VERIFIED, AND WHY EACH CHECK IS THERE
// -----------------------------------------------------------------------------
//
// The `Upstash-Signature` header is a JWS (JWT with an HMAC-SHA256 signature)
// whose payload carries `iss`, `sub`, `exp`, `nbf`, `iat`, `jti` and `body`.
//
//   signature  - the whole point. Without it every check below is decoration.
//   iss        - pins the issuer to "Upstash".
//   body       - `base64url(sha256(rawBody))`. THIS IS WHAT BINDS THE SIGNATURE
//                TO THE PAYLOAD. Without it a valid signature captured from any
//                message could be replayed with a body of the attacker's
//                choosing, and the signature would still verify - it signs the
//                token, not the request. A missing `body` claim is therefore a
//                rejection, not a "nothing to check".
//   sub        - the destination URL. Checked by PATH always, and by ORIGIN
//                when QSTASH_CALLBACK_ORIGIN says what our origin is. The path
//                check is what stops a genuine, correctly signed message for
//                one worker being replayed against another - which matters as
//                soon as there is more than one worker, and matters most on the
//                day one of them is cheap and another is expensive.
//   exp / nbf  - the replay window. Bounded rather than eliminated: doc 39 does
//                not give this codebase a `jti` store, and it does not need one,
//                because a replayed job is caught by the claim protocol (the
//                job row is no longer `queued`) and by the underlying entity's
//                own state. Two independent mechanisms, as everywhere else here.
//
// A small clock tolerance is allowed in both directions. Serverless clocks
// drift by fractions of a second and QStash's `nbf` is issued at send time; a
// zero-tolerance comparison turns a 200ms skew into a 401 storm, which fails
// closed in the least useful possible way.

/** Doc 39's header name. Compared case-insensitively by the Headers API. */
export const QSTASH_SIGNATURE_HEADER = "upstash-signature";

/** Seconds of clock skew tolerated on `exp` and `nbf`. */
export const CLOCK_TOLERANCE_SECONDS = 60;

const LOG_PREFIX = "[queue/verify]";

/**
 * The verified claims a caller may read. Deliberately narrow: the worker needs
 * none of this to do its work (the payload is in the body and the body is
 * bound by the signature), and returning the whole token would invite someone
 * to trust a claim that is authenticated but not meaningful.
 */
export interface QStashClaims {
  readonly issuer: string;
  readonly destination: string;
  /** `jti`, the message id. Useful in logs to correlate with the QStash console. */
  readonly messageId: string | null;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: QStashClaims }
  | {
      /**
       * `reason` is FOR THE SERVER LOG. See rule 4 in the header: it must never
       * reach the response body, and the route that consumes this returns a
       * bare 401.
       */
      readonly ok: false;
      readonly reason: string;
    };

export interface VerifyQStashRequestInput {
  /** The `Upstash-Signature` header value, or null when it was absent. */
  readonly signature: string | null;
  /**
   * The RAW body, exactly as received. Not a re-serialized parse of it: JSON
   * round-tripping reorders keys and drops whitespace, and the hash is over
   * bytes. The caller must read this before parsing anything.
   */
  readonly rawBody: string;
  /**
   * The path this request arrived at, e.g. `/api/jobs/notify.email`. Compared
   * against the path of the signed `sub` claim.
   */
  readonly path: string;
  /** Injectable clock, so expiry is asserted rather than waited out. */
  readonly now?: () => number;
  /**
   * Overrides for the two signing keys. Tests pass them; production reads the
   * environment. `undefined` (the absent property) means "read the env";
   * an explicitly empty object means "no keys", which rejects everything.
   */
  readonly keys?: { readonly current?: string; readonly next?: string };
  /** Override for QSTASH_CALLBACK_ORIGIN. Same convention as `keys`. */
  readonly expectedOrigin?: string | null;
}

interface DecodedToken {
  readonly signingInput: string;
  readonly signature: Buffer;
  readonly claims: Record<string, unknown>;
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** `base64url(sha256(bytes))`, unpadded, which is the form QStash signs. */
export function bodyHash(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("base64url");
}

/**
 * Split and decode the JWS without verifying it. Everything this returns is
 * still attacker-controlled; nothing may be trusted until `signature` has been
 * checked against a key.
 */
function decode(token: string): DecodedToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  if (
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    header.length === 0 ||
    payload.length === 0 ||
    signature.length === 0
  ) {
    return null;
  }

  let claims: unknown;
  try {
    claims = JSON.parse(base64UrlDecode(payload).toString("utf8"));
  } catch {
    return null;
  }

  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    return null;
  }

  return {
    signingInput: `${header}.${payload}`,
    signature: base64UrlDecode(signature),
    claims: claims as Record<string, unknown>,
  };
}

/**
 * Constant-time HMAC check against one key.
 *
 * The length guard before `timingSafeEqual` is not a leak: an HMAC-SHA256 is
 * always 32 bytes, so a different length is a malformed token rather than a
 * near-miss guess, and `timingSafeEqual` throws on unequal lengths.
 */
function signatureMatches(token: DecodedToken, key: string): boolean {
  const expected = createHmac("sha256", key).update(token.signingInput).digest();
  if (expected.length !== token.signature.length) return false;
  return timingSafeEqual(expected, token.signature);
}

function readString(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(claims: Record<string, unknown>, name: string): number | null {
  const value = claims[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The signing keys, from the override or the environment.
 *
 * `getServerEnv()` throws when any REQUIRED server key is missing, including
 * ones with nothing to do with the queue, so the read is guarded exactly as
 * src/lib/ai/llm.ts guards its own. The difference is what the guard does with
 * the failure: llm.ts returns null and the pipeline carries on, while this
 * returns no keys, which rejects the request. Same defence, opposite default,
 * and that asymmetry is the whole point of rule 1.
 */
function resolveKeys(override: VerifyQStashRequestInput["keys"]): string[] {
  if (override !== undefined) {
    return [override.current, override.next].filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );
  }

  try {
    const env = getServerEnv();
    return [env.QSTASH_CURRENT_SIGNING_KEY, env.QSTASH_NEXT_SIGNING_KEY].filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} server env is unreadable; rejecting the request`, error);
    return [];
  }
}

function resolveExpectedOrigin(
  override: VerifyQStashRequestInput["expectedOrigin"],
): string | null {
  if (override !== undefined) return override;
  try {
    return getServerEnv().QSTASH_CALLBACK_ORIGIN ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify one inbound worker request.
 *
 * Returns `{ok: true, claims}` only when the token is present, well formed,
 * signed by one of the configured keys, issued by Upstash, addressed to this
 * path (and this origin, when we know it), inside its validity window, and
 * carrying a `body` hash that matches the bytes received. Anything else is
 * `{ok: false, reason}` and the reason stays on the server.
 *
 * NEVER THROWS. The catch-all at the end exists so that a bug in this function
 * is a rejection rather than a 500, because a 500 from a worker route is a
 * retryable status and QStash would obligingly retry the request this module
 * just failed to evaluate.
 */
export function verifyQStashRequest(input: VerifyQStashRequestInput): VerifyResult {
  try {
    const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);

    if (input.signature === null || input.signature.length === 0) {
      return { ok: false, reason: "missing Upstash-Signature header" };
    }

    const keys = resolveKeys(input.keys);
    if (keys.length === 0) {
      // Rule 1, stated at the one place it is most tempting to break: a worker
      // route with no signing key configured is not "open for local testing",
      // it is an unauthenticated remote-execution endpoint.
      return { ok: false, reason: "no QStash signing key is configured" };
    }

    const token = decode(input.signature);
    if (token === null) {
      return { ok: false, reason: "signature is not a well-formed token" };
    }

    // Rule 2: both keys, and `some` rather than an early return per key so the
    // shape of the loop cannot be refactored into "current, then next only on
    // an error".
    if (!keys.some((key) => signatureMatches(token, key))) {
      return { ok: false, reason: "signature does not match any configured signing key" };
    }

    // ---- from here the claims are authenticated, but not yet meaningful ----

    const issuer = readString(token.claims, "iss");
    if (issuer !== "Upstash") {
      return { ok: false, reason: `unexpected issuer ${issuer ?? "(absent)"}` };
    }

    const expiry = readNumber(token.claims, "exp");
    if (expiry === null) {
      return { ok: false, reason: "token carries no exp" };
    }
    if (expiry + CLOCK_TOLERANCE_SECONDS < nowSeconds) {
      return { ok: false, reason: "token has expired" };
    }

    // `nbf` is optional in the JWT spec and present in practice. Absent is
    // accepted (a token with an exp is already bounded); present and in the
    // future is not.
    const notBefore = readNumber(token.claims, "nbf");
    if (notBefore !== null && notBefore - CLOCK_TOLERANCE_SECONDS > nowSeconds) {
      return { ok: false, reason: "token is not yet valid" };
    }

    // THE BINDING. Without this check the signature authenticates a token and
    // not a request, and any captured token would carry any body.
    const claimedBodyHash = readString(token.claims, "body");
    if (claimedBodyHash === null) {
      return { ok: false, reason: "token carries no body hash" };
    }
    // Compared with the padding stripped from both sides: the claim is
    // base64url and has been observed both padded and unpadded, and a `=`
    // costing a legitimate request a 401 would be a silly outage.
    if (stripPadding(claimedBodyHash) !== stripPadding(bodyHash(input.rawBody))) {
      return { ok: false, reason: "body hash does not match the signed value" };
    }

    const destination = readString(token.claims, "sub");
    if (destination === null) {
      return { ok: false, reason: "token carries no destination" };
    }

    const destinationCheck = checkDestination(
      destination,
      input.path,
      resolveExpectedOrigin(input.expectedOrigin),
    );
    if (destinationCheck !== null) {
      return { ok: false, reason: destinationCheck };
    }

    return {
      ok: true,
      claims: {
        issuer,
        destination,
        messageId: readString(token.claims, "jti"),
      },
    };
  } catch (error) {
    // Rule 1's backstop. A throw here would surface as a 500, which QStash
    // treats as retryable, so an unverifiable request would be re-delivered
    // forever.
    console.error(`${LOG_PREFIX} unexpected failure; rejecting the request`, error);
    return { ok: false, reason: "verification threw" };
  }
}

function stripPadding(value: string): string {
  return value.replace(/=+$/, "");
}

/**
 * Compare the signed destination against where this request actually arrived.
 * Returns null when it is acceptable, or the log reason when it is not.
 *
 * PATH is always compared: it is what stops a genuine message for one worker
 * being replayed against another, and it needs no configuration to be correct.
 * ORIGIN is compared only when configured, because behind a proxy the server
 * cannot derive its own public origin from the request without trusting a
 * header the caller sets - which would make the check assert nothing.
 *
 * Trailing slashes are normalized on both sides. `/api/jobs/notify.email` and
 * `/api/jobs/notify.email/` are the same endpoint to every router involved, and
 * a 401 over one is an outage with a very confusing log line.
 */
function checkDestination(
  destination: string,
  path: string,
  expectedOrigin: string | null,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(destination);
  } catch {
    return "destination is not a URL";
  }

  if (normalizePath(parsed.pathname) !== normalizePath(path)) {
    return "destination path does not match this route";
  }

  if (expectedOrigin !== null) {
    let expected: URL;
    try {
      expected = new URL(expectedOrigin);
    } catch {
      // A misconfigured origin must not silently disable the check, and it
      // must not silently accept either. Fail closed and say so in the log.
      return "QSTASH_CALLBACK_ORIGIN is not a URL";
    }
    if (parsed.origin !== expected.origin) {
      return "destination origin does not match QSTASH_CALLBACK_ORIGIN";
    }
  }

  return null;
}

function normalizePath(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}
