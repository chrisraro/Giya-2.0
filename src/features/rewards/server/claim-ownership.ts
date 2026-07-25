// Ownership check for consumer-scoped claim endpoints (currently just the
// mint-token route). This is NOT redundant with RLS: reward_claims has two
// select policies (reward_claims_consumer_select: consumer_id = auth.uid();
// OR reward_claims_staff_select: staff of the owning business - see
// supabase/migrations/0012_campaigns.sql), and Postgres RLS ORs together
// every USING clause that applies to the caller's role. So a claim visible
// via repo.getClaim is visible to the claim's own consumer AND to any
// active staff member of the business that issued it. An endpoint scoped to
// "the claim owner only" (doc 35 s12: `POST /reward-claims/{claimId}/token`
// is "consumer (claim owner)") must therefore re-check consumer_id in
// application code - RLS alone would let a staff member mint (and then
// self-redeem) a customer's reward.
//
// Kept as a small pure function, not inlined in the route, so the ownership
// decision itself can be unit-tested without spinning up a request/Supabase
// mocks.

export interface OwnableClaim {
  consumerId: string;
}

/**
 * True iff `claim` belongs to `userId`. Callers must treat `false` as
 * "respond exactly like a missing claim" (doc 13: never distinguish
 * "exists but not yours" from "does not exist") - this function only
 * answers the ownership question, it does not decide the HTTP response.
 */
export function assertClaimOwner(claim: OwnableClaim, userId: string): boolean {
  return claim.consumerId === userId;
}
