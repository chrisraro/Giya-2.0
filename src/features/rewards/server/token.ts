import "server-only";

import { randomUUID } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

import { getServerEnv } from "@/lib/env";
import { del, getDel, redisKey, setGet, setNx } from "@/lib/redis";

// Single-use redemption tokens: a business scans a customer's claim QR, the
// server mints a short-lived signed token, the business's confirm action
// redeems it exactly once. The HS256 signature proves the token was minted
// by us and has not been tampered with; the Redis jti record is what makes
// it single-use (a valid signature alone is replayable forever, since JWTs
// are just data - the anti-replay guarantee comes entirely from GETDEL).
//
// One-live-code-per-claim: refreshing the QR within the 5-minute window
// used to leave the previous jti valid, so a customer could screenshot or
// share several concurrently-valid codes. A "pointer" key
// (redeem:claim:{claimId} -> current jti) tracks the single live code for a
// claim; every mint atomically swaps the pointer to its own jti (via
// setGet, see below) and deletes whichever jti it displaced, so the old QR
// immediately stops validating. Double redemption was already impossible
// (redemptions.claim_id is unique plus the claim row lock) - this closes
// the separate "multiple live codes exist at once" gap.
const TOKEN_TTL_SECONDS = 300;

export type RedemptionTokenErrorCode = "REDEMPTION_TOKEN_INVALID";

export class RedemptionTokenError extends Error {
  readonly code: RedemptionTokenErrorCode;

  constructor(message = "Redemption token is invalid, expired, or already used") {
    super(message);
    this.name = "RedemptionTokenError";
    this.code = "REDEMPTION_TOKEN_INVALID";
  }
}

export interface RedemptionTokenPayload {
  claimId: string;
  businessId: string;
  jti: string;
}

export interface MintedRedemptionToken {
  token: string;
  expiresAt: string;
  jti: string;
}

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(getServerEnv().REDEMPTION_TOKEN_SECRET);
}

function isRedemptionTokenPayload(value: unknown): value is RedemptionTokenPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.claimId === "string" &&
    typeof candidate.businessId === "string" &&
    typeof candidate.jti === "string"
  );
}

// Mints a signed, single-use token for redeeming one claim at one business.
// Ownership/status checks on the claim are NOT this module's job - the
// caller (route/RPC) verifies the claim belongs to businessId and is in a
// redeemable state before calling this.
export async function mintRedemptionToken(
  claimId: string,
  businessId: string,
): Promise<MintedRedemptionToken> {
  const jti = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = nowSeconds + TOKEN_TTL_SECONDS;

  const token = await new SignJWT({ claimId, businessId, jti })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(getSecretKey());

  const stored = await setNx(
    redisKey("redeem", "jti", jti),
    claimId,
    TOKEN_TTL_SECONDS,
  );
  if (!stored) {
    // jti is a crypto.randomUUID(); a collision against an existing Redis
    // key is astronomically unlikely and indicates something is wrong.
    throw new RedemptionTokenError("Failed to mint redemption token: jti collision");
  }

  // Atomic pointer swap. `SET key value EX ttl GET` sets the pointer to
  // this mint's jti and, in the SAME command, returns whatever value the
  // pointer held immediately before - there is no separate read step for a
  // concurrent mint to interleave with. Redis executes commands one at a
  // time, so two concurrent mints' SET...GET calls against the same
  // pointer key are strictly ordered: whichever lands second at Redis
  // necessarily observes the first one's jti as "previous" and deletes it.
  //
  // Walk both orderings for two concurrent mints A (jti a) and B (jti b) of
  // the SAME claim, starting from whatever the pointer held before either
  // ran (P, possibly null):
  //   A's SET...GET lands first:  pointer P->a, A reads P,  deletes jti P.
  //     B's SET...GET lands second: pointer a->b, B reads a, deletes jti a.
  //     Final state: pointer=b, live jti={b}. Exactly one.
  //   B's SET...GET lands first:  pointer P->b, B reads P,  deletes jti P.
  //     A's SET...GET lands second: pointer b->a, A reads b, deletes jti b.
  //     Final state: pointer=a, live jti={a}. Exactly one.
  // Either way, whichever mint's swap lands last "wins" the pointer, and it
  // deletes precisely the jti it displaced - never its own (guarded by the
  // `!== jti` check below), never a key some other mint has not yet
  // written, and always the one live code left over from every earlier
  // mint of this claim.
  const pointerKey = redisKey("redeem", "claim", claimId);
  const previousJti = await setGet(pointerKey, jti, TOKEN_TTL_SECONDS);
  if (previousJti !== null && previousJti !== jti) {
    // Best-effort by nature of DEL itself (it is a no-op if the key already
    // expired or was consumed) - invalidates the code this mint displaced.
    await del(redisKey("redeem", "jti", previousJti));
  }

  return {
    token,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    jti,
  };
}

// Verifies and consumes a redemption token. Succeeds at most once per
// minted token: the Redis record for its jti is atomically read-and-deleted
// (GETDEL), so a second call for the same token always sees it already
// gone and throws, even under concurrent requests.
export async function consumeRedemptionToken(
  token: string,
): Promise<RedemptionTokenPayload> {
  let payload: RedemptionTokenPayload;
  try {
    const verified = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
    });
    if (!isRedemptionTokenPayload(verified.payload)) {
      throw new RedemptionTokenError();
    }
    // Narrow to exactly the three claims this module owns; jose's verified
    // payload also carries iat/exp, which are not part of this module's
    // return contract.
    const { claimId, businessId, jti } = verified.payload;
    payload = { claimId, businessId, jti };
  } catch {
    // Any verify failure (bad signature, malformed token, expired exp,
    // missing claims) collapses to the same error and code: callers must
    // not be able to distinguish "expired" from "tampered" from a timing
    // or error-message side channel.
    throw new RedemptionTokenError();
  }

  const storedClaimId = await getDel(redisKey("redeem", "jti", payload.jti));
  if (storedClaimId === null || storedClaimId !== payload.claimId) {
    // null: already consumed (replay) or never existed / expired out of
    // Redis. Mismatch: stored value does not match the token's claimId,
    // which should never happen for a token we minted ourselves, but is
    // treated the same as any other invalid-token case (fail closed).
    throw new RedemptionTokenError();
  }

  // Pointer cleanup is deliberately SKIPPED here (this used to be a blind
  // `del(pointerKey)`). The consume itself already succeeded via the atomic
  // GETDEL above; a plain DEL of redeem:claim:{claimId} risks deleting a
  // pointer that a concurrent, newer mintRedemptionToken call for the SAME
  // claim just wrote via its own atomic SET...GET swap - and unlike that
  // swap, there is no single Redis command to delete a key conditionally
  // on its current value, so "read then delete only on match" would just
  // reopen a read/delete race between two separate commands. The pointer's
  // only purpose is letting the NEXT mint find the PREVIOUS jti to
  // invalidate; once a code is consumed here there is nothing left for it
  // to point at that matters, so leaving it to expire on its own
  // TOKEN_TTL_SECONDS TTL is simplest and correct - it can at worst make a
  // future mint's "delete the previous jti" step a no-op on an already-gone
  // key, never resurrect or orphan a live code.
  return payload;
}
