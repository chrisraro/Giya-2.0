import "server-only";

import { randomBytes } from "node:crypto";

import { getDel, redisKey, setNx } from "@/lib/redis";

// =============================================================================
// The OAuth `state` nonce. THE CSRF DEFENCE FOR THE ENTIRE CONNECT FLOW.
// =============================================================================
//
// docs/30-modules/42-integrations.md: "server-generated state nonce (Redis, 10
// min TTL) -> Meta consent dialog -> callback ... verifies state".
//
// -----------------------------------------------------------------------------
// WHAT GOES WRONG WITHOUT THIS, EXACTLY
// -----------------------------------------------------------------------------
//
// The callback is a GET that an attacker can cause a victim's browser to make,
// with query parameters of the attacker's choosing. Three concrete attacks,
// and the property that stops each:
//
//   1. ACCOUNT INJECTION. The attacker starts a Meta connect flow with their
//      OWN Facebook account, captures the `code` from their own callback, and
//      then walks a logged-in merchant into
//      `/callback?code=<attacker's code>`. Without state verification we
//      exchange it and attach the ATTACKER'S Page to the MERCHANT'S tenant.
//      The merchant's portal now shows insights the attacker controls, and
//      every future read of that connection runs against a token the attacker
//      can revoke at will. Stopped by: the code is only exchanged when it
//      arrives with a state WE issued, in a session that requested it.
//
//   2. CROSS-TENANT ATTACHMENT. A user who legitimately administers tenant A
//      starts a flow there, then replays the resulting callback against
//      tenant B's callback path. Stopped by: the state is bound to the
//      business id at issue time and compared against the path segment at
//      verify time. A state minted for A verifies at A and nowhere else.
//
//   3. REPLAY. The same callback URL is fetched twice - by a refresh, a
//      preloading browser, or an attacker who kept it. Stopped by: consumption
//      is a single atomic GETDEL, so the second attempt finds nothing at all.
//
// -----------------------------------------------------------------------------
// THE THREE PROPERTIES, AND WHERE EACH IS ENFORCED
// -----------------------------------------------------------------------------
//
//   SINGLE USE     - `getDel` (one Redis round trip). This MUST stay one
//                    command, for the reason src/lib/redis.ts states on that
//                    helper: a GET followed by a DEL lets two concurrent
//                    consumers both read before either deletes.
//   BOUND TO THE   - the business id is stored in the VALUE, not derived from
//   BUSINESS         the request. Anything derived from the callback request
//                    is attacker-controlled by definition.
//   BOUND TO THE   - likewise the user id. A state minted by one member of a
//   USER             tenant cannot be completed by another member's session,
//                    which matters because the flow ends by storing a
//                    credential attributed to whoever completed it.
//
// The nonce itself is 32 bytes from `randomBytes`. Not a uuid: a v4 uuid is
// 122 bits with a recognisable shape, and there is no reason to take the
// smaller number when the larger one costs nothing.
//
// -----------------------------------------------------------------------------
// THIS MODULE FAILS CLOSED
// -----------------------------------------------------------------------------
//
// A Redis outage means no state can be verified, which means no code is
// exchanged. That is the same call src/lib/queue/verify.ts makes and the
// opposite of src/lib/integrations/circuit-breaker.ts: a breaker that cannot
// read its state is merely uninformed, whereas a CSRF check that cannot read
// its state has not checked anything. "Unavailable" is a refusal here.

/** Doc 42's TTL: ten minutes is longer than any honest consent dialog. */
export const STATE_TTL_SECONDS = 600;

/**
 * The alphabet a state may contain, checked BEFORE the value is used to build
 * a Redis key. `state` arrives from the query string, and the colon is the
 * Redis key separator: without this an attacker-supplied state could address a
 * key in another namespace entirely.
 */
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

const LOG_PREFIX = "[integrations/meta/state]";

interface StatePayload {
  readonly businessId: string;
  readonly userId: string;
  /** Stored so the token exchange sends back the byte-identical value. */
  readonly redirectUri: string;
  readonly issuedAt: number;
}

export type StateVerifyFailure =
  | "missing"
  | "malformed"
  | "unknown"
  | "business_mismatch"
  | "user_mismatch"
  | "unavailable";

export type StateVerifyResult =
  | { readonly ok: true; readonly redirectUri: string }
  | {
      /**
       * FOR THE SERVER LOG ONLY, per the rule src/lib/queue/verify.ts states
       * as its rule 4. "Unknown state" and "state for another business" are
       * two different facts about our storage, and handing them to whoever is
       * probing the endpoint turns a closed door into an oracle.
       */
      readonly ok: false;
      readonly reason: StateVerifyFailure;
    };

function keyFor(state: string): string {
  return redisKey("meta", "oauth", state);
}

/**
 * Mint a state nonce for one connect attempt and store what it is bound to.
 *
 * `setNx` rather than `set`: a collision on 32 random bytes is not a thing
 * that happens, but if it ever did, overwriting would silently invalidate
 * another user's in-flight connect. Refusing to reuse a key costs nothing.
 */
export async function issueState(input: {
  readonly businessId: string;
  readonly userId: string;
  readonly redirectUri: string;
}): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const payload: StatePayload = {
    businessId: input.businessId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    issuedAt: Date.now(),
  };

  const stored = await setNx(keyFor(state), JSON.stringify(payload), STATE_TTL_SECONDS);
  if (!stored) {
    // Cannot happen twice in the lifetime of this platform; if it does, the
    // right answer is to fail rather than to reuse.
    throw new Error("Could not start the Meta connection. Please try again.");
  }

  return state;
}

/**
 * Consume a state and check it against the callback's context.
 *
 * ORDER MATTERS. The value is consumed FIRST, before any comparison, so that a
 * state presented against the wrong business is burned rather than left in
 * Redis for the attacker to try again against the right one. A verification
 * that leaves the credential usable after a failed attempt is a verification
 * an attacker can iterate against.
 */
export async function verifyState(input: {
  readonly state: string | null;
  readonly businessId: string;
  readonly userId: string;
}): Promise<StateVerifyResult> {
  if (input.state === null || input.state.length === 0) {
    return { ok: false, reason: "missing" };
  }
  if (!STATE_PATTERN.test(input.state)) {
    return { ok: false, reason: "malformed" };
  }

  let raw: string | null;
  try {
    // Single atomic consume. See the header: this must not become GET + DEL.
    raw = await getDel(keyFor(input.state));
  } catch (error) {
    console.error(`${LOG_PREFIX} could not read the state store; refusing`, error);
    return { ok: false, reason: "unavailable" };
  }

  if (raw === null) {
    // Never issued, already used, or expired. All three are the same answer.
    return { ok: false, reason: "unknown" };
  }

  let payload: StatePayload;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as StatePayload).businessId !== "string" ||
      typeof (parsed as StatePayload).userId !== "string" ||
      typeof (parsed as StatePayload).redirectUri !== "string"
    ) {
      return { ok: false, reason: "malformed" };
    }
    payload = parsed as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload.businessId !== input.businessId) {
    return { ok: false, reason: "business_mismatch" };
  }
  if (payload.userId !== input.userId) {
    return { ok: false, reason: "user_mismatch" };
  }

  return { ok: true, redirectUri: payload.redirectUri };
}
