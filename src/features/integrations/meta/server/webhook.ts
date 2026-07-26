import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/env";
import { redisKey, setNx } from "@/lib/redis";

// =============================================================================
// Meta webhook verification and payload shaping.
// =============================================================================
//
// docs/30-modules/42-integrations.md, resilience standard #7: webhook
// endpoints are "outside /api/v1 (not part of the public contract),
// signature-verified before any parsing, idempotent by provider event id
// (Redis SET NX 24h ...), and answer 200 fast with work queued, never
// processed inline."
//
// The verification lives here rather than in the route for the same reason
// src/lib/queue/verify.ts is its own module: it is the entire perimeter of an
// unauthenticated public endpoint, and a perimeter deserves a file with its
// own tests rather than twenty lines inside a handler.
//
// -----------------------------------------------------------------------------
// THE SIGNATURE, AND THE ONE MISTAKE THAT MAKES IT WORTHLESS
// -----------------------------------------------------------------------------
//
// Meta sends `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the RAW
// REQUEST BODY keyed with the app secret.
//
// IT MUST BE COMPUTED OVER THE BYTES AS RECEIVED. The tempting shape -
// `const body = await request.json()` and then HMAC of `JSON.stringify(body)` -
// is broken and looks fine: JSON round-tripping reorders nothing in V8 but
// drops insignificant whitespace, re-escapes non-ASCII, and renders numbers
// canonically. Any of those changes one byte and every signature fails; worse,
// on the day one of them DOESN'T change a byte, the check passes for a body
// that is not the body that was signed. So `rawBody` is a string parameter
// here, the route reads it with `request.text()` exactly once, and the JSON is
// parsed only after this function has returned ok.
//
// COMPARISON IS CONSTANT TIME. A byte-by-byte `===` on an HMAC leaks, in its
// timing, how many leading bytes of a guess were right - which turns forging a
// signature from 2^256 work into roughly 32 x 256. It costs one function call
// to remove.
//
// FAIL CLOSED, ALWAYS. No secret configured means nothing verifies, which
// means nothing is accepted. A webhook endpoint that accepts unsigned requests
// "because the integration is not configured yet" is an unauthenticated
// endpoint that flips tenant connections to 'revoked' on request.

export const SIGNATURE_HEADER = "x-hub-signature-256";

/** Doc 42 / doc 13: the idempotency window for a provider redelivery. */
export const WEBHOOK_DEDUPE_TTL_SECONDS = 86_400;

const LOG_PREFIX = "[integrations/meta/webhook]";

export type VerifyFailure =
  | "missing_signature"
  | "malformed_signature"
  | "not_configured"
  | "mismatch";

export type VerifyResult =
  | { readonly ok: true }
  | {
      /** FOR THE SERVER LOG. The route answers a bare 401. */
      readonly ok: false;
      readonly reason: VerifyFailure;
    };

function appSecret(override?: string): string | null {
  if (override !== undefined) return override.length > 0 ? override : null;
  try {
    return getServerEnv().META_APP_SECRET ?? null;
  } catch {
    // A server env that will not parse cannot authorise anything.
    return null;
  }
}

/**
 * Verify one inbound webhook request.
 *
 * NEVER THROWS. A thrown error here would surface as a 500, and Meta treats a
 * 5xx as retryable, so an unverifiable request would be redelivered for days.
 */
export function verifyWebhookSignature(input: {
  readonly signature: string | null;
  /** The RAW body, exactly as received. See the header. */
  readonly rawBody: string;
  /** Test override. `undefined` means "read the environment". */
  readonly secret?: string;
}): VerifyResult {
  try {
    if (input.signature === null || input.signature.length === 0) {
      return { ok: false, reason: "missing_signature" };
    }

    const secret = appSecret(input.secret);
    if (secret === null) {
      return { ok: false, reason: "not_configured" };
    }

    // Meta's format is `sha256=<hex>`. Anything else is malformed, including a
    // bare hex digest: accepting one would mean accepting a `sha1=` prefix
    // stripped by a well-meaning proxy, and SHA-1 is not what we verify.
    const [algorithm, digest] = input.signature.split("=");
    if (algorithm !== "sha256" || digest === undefined || !/^[0-9a-f]{64}$/i.test(digest)) {
      return { ok: false, reason: "malformed_signature" };
    }

    const expected = createHmac("sha256", secret).update(input.rawBody, "utf8").digest();
    const received = Buffer.from(digest, "hex");

    // The length guard is not a leak: an HMAC-SHA256 is always 32 bytes, the
    // regex above already fixed the hex length, and timingSafeEqual throws on
    // a mismatch.
    if (expected.length !== received.length) {
      return { ok: false, reason: "mismatch" };
    }
    if (!timingSafeEqual(expected, received)) {
      return { ok: false, reason: "mismatch" };
    }

    return { ok: true };
  } catch (error) {
    console.error(`${LOG_PREFIX} verification threw; rejecting`, error);
    return { ok: false, reason: "mismatch" };
  }
}

/**
 * The GET handshake Meta performs when the webhook is first registered.
 *
 * Meta calls the URL with `hub.mode=subscribe`, `hub.verify_token` and
 * `hub.challenge`, and expects the challenge echoed back verbatim if the token
 * matches the one configured in the app dashboard.
 *
 * WHY A SEPARATE VARIABLE rather than reusing META_APP_SECRET: the verify
 * token is typed into a third party's web form and is therefore, in the
 * threat-model sense, disclosed to everyone who can see that dashboard. The
 * app secret signs every webhook and mints every token exchange. Using one
 * value for both means a screenshot of the Meta console compromises the
 * signature scheme this file exists to enforce. They are different secrets
 * because they have different blast radii.
 *
 * Compared in constant time even though the token is low-value: the comparison
 * is free and the habit is what matters.
 */
export function verifyHandshake(input: {
  readonly mode: string | null;
  readonly token: string | null;
  readonly challenge: string | null;
  readonly verifyToken?: string;
}): string | null {
  if (input.mode !== "subscribe") return null;
  if (input.challenge === null || input.challenge.length === 0) return null;

  let expected: string | null;
  if (input.verifyToken !== undefined) {
    expected = input.verifyToken.length > 0 ? input.verifyToken : null;
  } else {
    try {
      expected = getServerEnv().META_WEBHOOK_VERIFY_TOKEN ?? null;
    } catch {
      expected = null;
    }
  }

  // Fail closed: with no configured token there is nothing to match, so the
  // handshake is refused rather than waved through.
  if (expected === null || input.token === null) return null;

  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(input.token, "utf8");
  if (left.length !== right.length || left.length === 0) return null;
  if (!timingSafeEqual(left, right)) return null;

  return input.challenge;
}

/**
 * Claim one delivery, so a redelivery is a no-op.
 *
 * Doc 42 says "idempotent by provider event id". Meta's webhook payload has no
 * top-level event id - the closest thing is `entry[].id` plus `entry[].time`,
 * which is not unique across the objects in one delivery. So the dedupe key is
 * the SHA-256 OF THE RAW BODY, which is exactly right for the case the rule
 * exists to cover: Meta retries a failed delivery with a byte-identical body,
 * and that hash is stable across retries and different for a genuinely new
 * event. It is also computed over the same bytes the signature authenticated,
 * so it cannot be influenced without breaking the signature first.
 *
 * Returns true when THIS call claimed the delivery. Returns false when it was
 * already claimed OR when Redis is unreachable - the second case fails CLOSED,
 * which for a webhook means "do not process". The cost is a missed
 * deauthorization that Meta will redeliver; the alternative cost is processing
 * a replayed event, and doc 42 asks for idempotency, not for best effort.
 */
export async function claimDelivery(rawBody: string): Promise<boolean> {
  const id = createHash("sha256").update(rawBody, "utf8").digest("hex");
  try {
    return await setNx(redisKey("wh", "meta", id), "1", WEBHOOK_DEDUPE_TTL_SECONDS);
  } catch (error) {
    console.error(`${LOG_PREFIX} dedupe store unavailable; not processing`, error);
    return false;
  }
}

/**
 * The external account ids a delivery says have been deauthorized.
 *
 * Meta's webhook envelope is `{object, entry: [{id, time, changed_fields |
 * changes}]}`. Two shapes matter here:
 *
 *   object 'permissions' - a USER removed a permission. `entry[].id` is the
 *                          user id and `changed_fields` names the permissions.
 *   object 'page'        - a PAGE-level change. `entry[].id` IS the page id,
 *                          which is what `external_account_id` stores.
 *
 * HONEST LIMITATION, recorded rather than hidden: for the 'permissions' shape
 * the id is a user id, and this codebase does not store the connecting user's
 * Meta id - only the Page id. So a user-level deauthorization matches nothing
 * here and the connection is caught later by refresh-on-read instead, which
 * flips it to 'expired' the first time Meta rejects the token. Storing the
 * user id to close that gap would mean storing another external identifier for
 * every connection to make one webhook shape tidier, and doc 42 already
 * designates refresh-on-read as the V1 mechanism for exactly this. Revisit
 * when publishing arrives and a stale token becomes user-visible.
 */
export function extractDeauthorizedAccounts(payload: unknown): readonly string[] {
  if (typeof payload !== "object" || payload === null) return [];

  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];

  const ids = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }

  return [...ids];
}
