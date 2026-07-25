import "server-only";

import {
  listActiveBusinesses,
  type BusinessSummary,
} from "@/features/businesses/server/public-repo";
import { createClient } from "@/lib/supabase/server";

import { SCAN_CHOOSER_LIMIT } from "../scan-entry";

// The read behind the `/scan` store chooser.
//
// Why the chooser exists at all: doc 33's route table marks generic (unbound)
// scanning `[V1]`, and the shipped pipeline agrees. `buildMatchCandidates` in
// server/process.ts supplies only the pre-bound business as a candidate, so a
// receipt submitted with no business_id scores against an empty candidate set
// and is rejected `wrong_business` every single time, after the photo has been
// taken, compressed and uploaded. Re-submitting the same photo from the right
// store page then hits receipts_sha_unique (a TOTAL index in 0017 that counts
// rejected rows) and returns 422 RECEIPT_DUPLICATE, so the paper receipt is
// spent. Every attempt also burns a slot of the 60/day cap and moves every
// velocity counter. Picking the store FIRST is the whole fix.
//
// Nothing here opens a new exposure path: businesses come from
// listActiveBusinesses, which is the same `businesses_public_select` read that
// `/b/[slug]` already performs, and the recency signal comes from the caller's
// own business_customers rows under their own session.

/** How many recently visited shops lead the list. */
export const SCAN_RECENT_LIMIT = 5;

export interface ScanTargets {
  /** Shops the consumer already has a relationship with, most recent first. */
  recent: BusinessSummary[];
  /** Every other active shop, alphabetically. */
  businesses: BusinessSummary[];
  /** More shops exist than were returned, so the search field is not optional. */
  truncated: boolean;
}

export interface LoadScanTargetsArgs {
  /** Already through `parseStoreQueryParam`. Undefined means no active search. */
  readonly query?: string | undefined;
}

export async function loadScanTargets(args: LoadScanTargetsArgs = {}): Promise<ScanTargets> {
  // Over-fetch by one, the same trick buildPage uses: it answers "is there
  // more?" without a second count query.
  const found = await listActiveBusinesses({
    query: args.query,
    limit: SCAN_CHOOSER_LIMIT + 1,
  });
  const truncated = found.length > SCAN_CHOOSER_LIMIT;
  const listed = truncated ? found.slice(0, SCAN_CHOOSER_LIMIT) : found;

  // A search is a deliberate act: the consumer has named the shop they want,
  // so a separate "recently visited" band above the matches is noise, and a
  // recent shop that matches is already in the results.
  if (args.query !== undefined) {
    return { recent: [], businesses: listed, truncated };
  }

  const recent = await loadRecentlyVisited();
  const recentIds = new Set(recent.map((business) => business.id));

  return {
    recent,
    businesses: listed.filter((business) => !recentIds.has(business.id)),
    truncated,
  };
}

/**
 * The caller's most recently visited shops. `business_customers` rows are
 * RLS-scoped to the consumer themselves, so this is the cheap version of
 * "where do you actually shop": one indexed read of rows that already exist
 * because a previous scan or claim created them.
 *
 * Ordering is by `last_visit_at` descending with nulls last, because a row can
 * exist with no visit yet (a reward claim creates the pair). Anything that
 * fails degrades to an empty list: recency is a convenience, and a chooser
 * that renders without it is still completely usable.
 */
async function loadRecentlyVisited(): Promise<BusinessSummary[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("business_customers")
    .select("business_id, last_visit_at")
    .order("last_visit_at", { ascending: false, nullsFirst: false })
    .limit(SCAN_RECENT_LIMIT);

  if (error || !data || data.length === 0) return [];

  const orderedIds = data.map((row) => row.business_id);
  // Re-read through the public path so a shop that has since been deactivated
  // or soft-deleted drops out: a stale business_customers row must not become
  // a link to a scan that cannot succeed.
  const businesses = await listActiveBusinesses({
    ids: orderedIds,
    limit: SCAN_RECENT_LIMIT,
  });

  const byId = new Map(businesses.map((business) => [business.id, business]));
  return orderedIds.flatMap((id) => {
    const business = byId.get(id);
    return business ? [business] : [];
  });
}
