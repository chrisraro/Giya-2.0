import "server-only";

import { randomUUID } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

import { getServerEnv } from "@/lib/env";
import { del, get, getDel, redisKey, set, setNx } from "@/lib/redis";

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
// claim; every mint reads the pointer, deletes the previous jti's key (so
// the old QR immediately stops validating), then writes the new jti and
// overwrites the pointer. Double redemption was already impossible
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

  const pointerKey = redisKey("redeem", "claim", claimId);
  const previousJti = await get(pointerKey);
  if (previousJti !== null) {
    // Best-effort by nature of DEL itself (it is a no-op if the key already
    // expired or was consumed) - invalidates the previously minted code the
    // instant a new one is minted.
    await del(redisKey("redeem", "jti", previousJti));
  }

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

  await set(pointerKey, jti, TOKEN_TTL_SECONDS);

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

  // Best-effort cleanup of the pointer key: the consume itself already
  // succeeded via the atomic GETDEL above, so a failure here must not
  // surface as a failed redemption. Worst case the pointer lingers and
  // points at an already-deleted jti key until its own TTL expires, which
  // is harmless (the next mint will just no-op the DEL of a missing key).
  try {
    await del(redisKey("redeem", "claim", payload.claimId));
  } catch {
    // Swallowed intentionally - see comment above.
  }

  return payload;
}
