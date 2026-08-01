import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

import { foldRoutingBreakdown } from "../routing-breakdown";
import type { RoutingBreakdown, RoutingTally } from "../routing-breakdown";

// ===========================================================================
// D10: the one read behind the review-rate panel.
//
// ---------------------------------------------------------------------------
// THE SERVICE ROLE IS HERE, SO THE TENANCY FENCE IS IN THE CALLER.
// ---------------------------------------------------------------------------
// Same posture, and the same obligation, as ../review/queue.ts and
// ../../admin/queue.ts. `public.receipt_routing_breakdown` (migration 0035) is
// `security definer` and granted to `service_role` alone, because it reads
// `parse_meta` and 0017's column grant withholds that column from
// `authenticated` - column privileges are role-wide, so no policy can hand a
// merchant this read.
//
// The consequence has to be said out loud because this module takes a business
// id and could be mistaken for a boundary: IT IS NOT ONE. `businessId` may only
// ever come from `resolveReviewerContext()` (../review/access.ts), which reads
// it out of `business_staff` under the caller's own session. Passing NULL asks
// for the whole platform and is legitimate from exactly one place, an `(admin)`
// route that has already called `resolveAdminContext()`. A route parameter, a
// query string or a form field reaching `businessId` here is a cross-tenant
// leak that no policy will catch.
//
// FAILURE SHAPE, inherited from both queue modules: null means "could not be
// read" and is never rendered as zero. A review rate of 0% is a claim that the
// pipeline is approving everything on its own, which is the single most
// reassuring sentence this product can say to a merchant, and a dropped
// connection is in no position to say it.
// ===========================================================================

/**
 * The window every surface reads. One number, exported, because the merchant's
 * panel and the admin's panel comparing different periods would make the two
 * numbers look like a discrepancy in the pipeline rather than in the query.
 *
 * 30 days rather than the dashboard's rolling 7: D10's threshold is about a
 * merchant's steady state after their first week, and a week of a small shop's
 * receipts is too few for a quarter to mean anything. It is also long enough
 * that one bad afternoon of photographs does not read as a policy problem.
 */
export const ROUTING_WINDOW_DAYS = 30;

export interface RoutingStatsDeps {
  /** SERVICE ROLE. See the header: the fence is the caller's, not RLS's. */
  supabase: SupabaseClient<Database>;
}

/** Null when the service-role key is absent, matching every sibling module. */
export function defaultRoutingStatsDeps(): RoutingStatsDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) return null;
  return { supabase };
}

export interface LoadRoutingBreakdownInput {
  /**
   * The tenant to scope to, or null for the whole platform. Null is admin-only;
   * see the header.
   */
  businessId: string | null;
  windowDays?: number;
}

/**
 * The review-rate breakdown for one business, or for the platform.
 *
 * Aggregation happens in Postgres rather than here, and that is the whole
 * reason a function exists at all: PostgREST cannot group, so the alternative
 * was reading every receipt row in the window into this process and folding it,
 * which is a row cap in disguise. The moment the platform view exceeded the cap
 * the number would quietly become a sample, and a sampled review rate is
 * exactly the almost-true number D10 exists to stop us acting on.
 */
export async function loadRoutingBreakdown(
  input: LoadRoutingBreakdownInput,
  deps: RoutingStatsDeps | null = defaultRoutingStatsDeps(),
): Promise<RoutingBreakdown | null> {
  if (deps === null) return null;
  const windowDays = input.windowDays ?? ROUTING_WINDOW_DAYS;

  const { data, error } = await deps.supabase.rpc("receipt_routing_breakdown", {
    // TENANCY: this argument, and nothing else, is what stops one merchant's
    // panel counting another's receipts. Its only legitimate source is
    // resolveReviewerContext(). Omitted rather than passed as null for the
    // platform call, so the function's own `default null` is what decides.
    ...(input.businessId === null ? {} : { p_business_id: input.businessId }),
    p_days: windowDays,
  });

  if (error !== null) {
    console.error(
      `[receipts/routing-stats] breakdown failed for ${input.businessId ?? "the platform"}`,
      error,
    );
    return null;
  }

  // An empty array is a real answer: a business with no receipts in the window.
  // `foldRoutingBreakdown` turns it into zeros with a 0% rate, and the surfaces
  // render their own empty state off `total === 0` rather than off a null.
  const rows: RoutingTally[] = (data ?? []).map((row) => ({
    kind: row.kind,
    key: row.key,
    tally: Number(row.tally),
  }));

  return foldRoutingBreakdown(rows, windowDays);
}
