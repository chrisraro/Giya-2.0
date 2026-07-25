import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

// ===========================================================================
// The tenancy anchor for every review surface.
//
// READ THIS BEFORE TOUCHING ANYTHING IN `queue.ts`.
//
// Spec section 2 and the plan's Risks section: the review screens read
// `receipts` through the SERVICE ROLE, which bypasses RLS entirely, because
// 0017's column-level grant withholds `parse_meta` and both confidences from
// `authenticated` and column privileges are role-wide (staff are the same
// `authenticated` role as consumers, so no grant can give staff more columns).
//
// The consequence is that RLS stops being the tenancy fence for these reads
// and CODE becomes the fence. This function is that fence's only anchor. It
// resolves the caller's business the way `resolveOwnerBusiness` does, from
// TABLE TRUTH under the caller's own session (RLS-scoped, `user_id =
// auth.uid()`), never from a URL segment, a query parameter, a form field or a
// JWT claim. Everything downstream takes the business id it returns and
// applies it as an explicit predicate.
//
// It is deliberately NOT `resolveOwnerBusiness` itself: that helper returns no
// role, and the review surfaces are owner/manager only (doc 32 section 13's
// matrix, mirrored by 0017's `receipts_staff_select` and by guard 2 of
// `server/review.ts`). A `marketing` or `staff` member reaching this screen
// must resolve to null here, not to a business whose queue they can read.
// ===========================================================================

/** Doc 32 section 13: receipt review is owner and manager only. */
export const REVIEWER_ROLES = ["owner", "manager"] as const;

export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export interface ReviewerContext {
  /** `profiles.id` of the signed-in reviewer; the actor id every audit row carries. */
  userId: string;
  businessId: string;
  businessName: string;
  role: ReviewerRole;
}

/**
 * The signed-in caller's reviewing business, or null when there is no session,
 * no active membership, or a membership whose role cannot review receipts.
 *
 * Null is the only failure shape on purpose. A page turns it into a redirect
 * and a server action turns it into a refusal; neither ever needs to
 * distinguish "not signed in" from "not allowed", and distinguishing them here
 * would only tempt a caller to leak the difference.
 *
 * Wrapped in React's `cache` so the portal layout (which needs it for the
 * sidebar badge) and the page beneath it (which needs it for the queue) share
 * one resolution per request instead of each paying for an `auth.getUser()`
 * round trip. The cache is per-request, so it can never carry one caller's
 * tenant into another caller's render.
 */
export const resolveReviewerContext = cache(async function resolveReviewerContext(): Promise<ReviewerContext | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Session-scoped client, so 0004's business_staff self-select policy already
  // constrains this to the caller's own rows; `user_id` is pinned anyway,
  // because "RLS also allows it" is not a reason to leave a predicate off the
  // query that decides which tenant the next twelve reads belong to.
  const { data: membership, error } = await supabase
    .from("business_staff")
    .select("business_id, role")
    .eq("user_id", user.id)
    .eq("status", "active")
    .in("role", [...REVIEWER_ROLES])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<{ business_id: string; role: string }>();

  if (error !== null) {
    // Fail closed: a membership read that errored proves nothing.
    console.error("[receipts/review] could not resolve the reviewer's membership", error);
    return null;
  }
  if (membership === null) return null;

  const { data: business } = await supabase
    .from("businesses")
    .select("id, name")
    .eq("id", membership.business_id)
    .maybeSingle<{ id: string; name: string }>();

  if (business === null) return null;

  return {
    userId: user.id,
    businessId: business.id,
    businessName: business.name,
    role: membership.role as ReviewerRole,
  };
});
