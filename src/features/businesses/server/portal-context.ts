import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

import { resolveOwnerBusiness, type OwnerBusiness } from "./resolve-owner-business";

// ===========================================================================
// WHO IS SIGNED IN, AND WHOSE BUSINESS IS THIS.
//
// One answer per request, shared by the portal layout (which renders the
// topbar chrome on all eight portal routes) and by the pages beneath it.
//
// It does NOT resolve membership itself: it delegates to
// `resolveOwnerBusiness`, the shared resolver that campaigns, menu and the
// redeem screen already use, which reads the caller's first ACTIVE
// `business_staff` row under the caller's own session. Adding a second
// membership query here would be a second place for the tenancy answer to
// drift, which is exactly the failure this module is shaped to avoid.
//
// Why `resolveOwnerBusiness` and not `resolveReviewerContext`
// (features/receipts/review/access.ts): the reviewer context is intentionally
// owner-and-manager only, because receipt review is. The topbar renders for
// EVERY portal role, including marketing, and a marketing member must see
// their own name and their own business rather than being told they have no
// business. `resolveOwnerBusiness` is the role-agnostic resolver, and it also
// carries `status`, which the dashboard's verification banner needs.
//
// Wrapped in React's `cache` so the layout and the page under it share one
// resolution per request. The cache is per-request, so it can never carry one
// caller's identity into another caller's render.
// ===========================================================================

export interface PortalContext {
  /** The tenant every query on this request must be scoped to. */
  business: OwnerBusiness;
  /**
   * `profiles.display_name` of the signed-in user, or null when there is no
   * profile row or it could not be read. Null renders a neutral avatar; it
   * never falls back to a name belonging to somebody else.
   */
  displayName: string | null;
}

export const resolvePortalContext = cache(async function resolvePortalContext(): Promise<PortalContext | null> {
  const business = await resolveOwnerBusiness();
  if (business === null) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // `profiles` RLS is self-select plus platform admin (migration 0002), and an
  // admin's session would match every row, so the id is pinned rather than
  // relying on the policy to leave exactly one row standing.
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle<{ display_name: string }>();

  if (error !== null) {
    console.error("[businesses/portal-context] could not read the signed-in profile", error);
  }

  return { business, displayName: profile?.display_name ?? null };
});

/**
 * Up to two initials for an avatar, or null when the name yields none.
 *
 * Null is a real outcome, not a bug: a display name of "  " or "..." has no
 * initials, and inventing one would put a letter on screen that belongs to
 * nobody. The caller renders a neutral person glyph instead.
 */
export function initialsOf(displayName: string | null): string | null {
  if (displayName === null) return null;

  const words = displayName
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);

  const initials = words
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join("");

  return initials.length > 0 ? initials : null;
}
