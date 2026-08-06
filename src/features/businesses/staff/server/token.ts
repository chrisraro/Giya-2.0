import "server-only";

import { randomBytes } from "node:crypto";

// The invite token: `business_staff.invite_token` (0002), unique, looked up
// with no other predicate by the public `/invite/[token]` route - so its
// entire security property is "an attacker cannot guess a live one".
//
// 32 bytes from `randomBytes`, base64url-encoded - the exact precedent
// src/features/integrations/meta/server/state.ts's OAuth nonce uses, and
// stated there: "Not a uuid: a v4 uuid is 122 bits with a recognisable shape,
// and there is no reason to take the smaller number when the larger one costs
// nothing." A uuid (v4 or v7) is also ruled out on a second, DB-specific
// ground `src/features/rewards/server/token.ts` does not have to argue: a v7
// uuid's leading bits are a timestamp, and `invite_token` has nothing else
// binding it to a mint time the way that module's Redis TTL does - a
// sequential prefix would leak roughly when an invite was sent to anyone who
// can see two of them.
//
// UNLIKE `rewards/server/token.ts`, this is not a signed JWT and there is no
// Redis record: single-use is enforced by the DATABASE ROW itself (a
// conditional UPDATE guarded on `status = 'invited'`, in server/service.ts),
// because the token has nowhere else to live - `invite_token` IS the
// row's lookup key, not a capability layered on top of one. A JWT would add a
// second, redundant expiry/signature to verify against the same
// `invite_expires_at` column already carries.
const TOKEN_BYTES = 32;

export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Doc 30 section 2.7: "`invite_expires_at` default 7 days." */
export const INVITE_TTL_DAYS = 7;

export function inviteExpiresAt(from: Date = new Date()): string {
  const expires = new Date(from.getTime());
  expires.setUTCDate(expires.getUTCDate() + INVITE_TTL_DAYS);
  return expires.toISOString();
}
