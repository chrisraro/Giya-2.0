import "server-only";

import { createServiceRoleClient } from "@/lib/supabase/service";

// ===========================================================================
// The wallet's "what expires when" read (task 1.3, doc 35 section 7).
//
// Delegates entirely to `public.points_next_expiry` (0043), a thin wrapper
// over `private.points_lot_remainders` - the SAME FIFO formula
// `public.expire_points` (the sweep) uses to decide what to actually take.
// This module exists ONLY to call that one RPC; it computes nothing itself,
// which is the point: the number a consumer reads here is the number the
// sweep will eventually expire, never a second implementation that could
// drift from it.
//
// SERVICE ROLE, not the session-scoped client `src/features/rewards/server/
// repo.ts` uses for plain table reads. `public.points_next_expiry` is
// SECURITY DEFINER and granted to service_role only (0043's I-A grant block),
// matching every other cross-cutting points read in this codebase
// (`campaign_points_awarded`, `fixed_per_visit_already_paid` in
// src/features/receipts/server/award.ts) - the FIFO computation reads across
// a pair's whole ledger history via a window function, which is exactly the
// kind of aggregate this repo's established pattern keeps off the
// session-scoped, RLS-mediated path. The caller (the wallet page, a trusted
// Server Component) supplies `consumerId` from its own authenticated
// session, never from user input.
// ===========================================================================

export interface NextExpiryDTO {
  /** The soonest-expiring lot's remaining points, doc 35 section 7's FIFO
   * remainder - never the pair's whole balance. */
  points: number;
  /** ISO timestamp. Always in the future: `points_next_expiry` excludes any
   * lot already past its cutoff (that lot is the sweep's job, not the
   * wallet's - see 0043's own comment on the predicate). */
  expiresAt: string;
}

/**
 * The soonest-expiring lot for one (business, consumer) pair, or null when
 * there is nothing left to expire (no positive-remainder lot, or the
 * service-role client / RPC call is unavailable). Never throws: a missing
 * expiry line is a degraded wallet, not a broken one, mirroring the
 * fail-soft posture `src/features/notifications/server/raise.ts` documents
 * for the same reason (this is a read the page can live without).
 */
export async function getNextPointsExpiry(
  businessId: string,
  consumerId: string,
): Promise<NextExpiryDTO | null> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      `[points/expiry] no service-role client; cannot read next expiry for business ${businessId}`,
    );
    return null;
  }

  const { data, error } = await supabase.rpc("points_next_expiry", {
    p_business_id: businessId,
    p_consumer_id: consumerId,
  });

  if (error !== null) {
    console.error(`[points/expiry] could not read next expiry for business ${businessId}`, error);
    return null;
  }

  const row = data?.[0];
  if (row === undefined) return null;
  return { points: row.points, expiresAt: row.expires_at };
}

/**
 * The soonest-expiring lot per business, for every business id given -
 * exactly what the wallet needs to annotate each balance row. Businesses
 * with nothing to show are simply absent from the returned map, so a caller
 * can use `.get(businessId) ?? null`.
 *
 * Runs one RPC call per business (fine at this scale: a consumer's wallet
 * lists a handful of businesses, never hundreds) rather than a batched RPC,
 * so a single failing business cannot take the rest down - each call is
 * independently fail-soft per `getNextPointsExpiry` above.
 */
export async function getNextPointsExpiryByBusiness(
  consumerId: string,
  businessIds: readonly string[],
): Promise<Map<string, NextExpiryDTO>> {
  const results = new Map<string, NextExpiryDTO>();
  await Promise.all(
    businessIds.map(async (businessId) => {
      const next = await getNextPointsExpiry(businessId, consumerId);
      if (next !== null) results.set(businessId, next);
    }),
  );
  return results;
}
