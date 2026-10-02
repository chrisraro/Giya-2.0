import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

// Shared by every feature slice (menu, campaigns, rewards catalog, customers,
// settings, ...) whose server actions need to know "whose" business they are
// acting on. Lifted out of src/features/menu/server/repo.ts (its original
// home) so the campaigns slice could reuse the exact same resolution instead
// of duplicating it; menu/server/repo.ts now re-exports this module's
// `resolveOwnerBusiness` so its own callers/tests are unaffected.
//
// TWO EXPORTS, ONE QUERY. Both functions below go through `readMembership`,
// which reads the caller's tenancy from `business_staff` under the caller's OWN
// session (RLS-scoped by 0004's self-select policy, with `user_id` pinned
// anyway), never from a URL segment, a query parameter, a form field, or a JWT
// claim. They differ in one predicate and in what they return:
//
//   * `resolveOwnerBusiness` - role-agnostic, the original. Menu, campaigns and
//     `portal-context.ts` use it; their screens are gated elsewhere.
//   * `resolveStaffContext`  - role-gated, and additionally returns the
//     caller's `userId` and `role`. Surfaces whose permission row in doc 01's
//     matrix is narrower than "any active member" need the role in hand, and a
//     member whose role is not allowed must resolve to null here rather than to
//     a business they can then read or write.
//
// `resolveStaffContext` deliberately mirrors
// src/features/receipts/review/access.ts's `resolveReviewerContext` (the same
// idea, hard-coded to owner/manager because the receipts surfaces are) rather
// than inventing a third shape, and it lives here rather than in a new module
// so there stays exactly one file that knows how tenancy is resolved.

/** `business_staff.role`, doc 00-product/01-personas-roles.md. */
export const BUSINESS_ROLES = ["owner", "manager", "marketing", "staff"] as const;

export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export type OwnerBusiness = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

export interface StaffContext {
  /** `profiles.id` of the signed-in member; the actor id any audit row carries. */
  userId: string;
  businessId: string;
  businessName: string;
  businessSlug: string;
  businessStatus: string;
  role: BusinessRole;
}

interface Membership {
  userId: string;
  businessId: string;
  role: string;
}

/**
 * The one membership query. `allowedRoles` of null means "any active
 * membership" and adds no role predicate at all, which keeps the role-agnostic
 * path exactly the query it has always been.
 *
 * Returns null for no session, no matching membership, or a read that errored -
 * the last one deliberately fails closed, because a membership read that
 * errored proves nothing about the caller's tenancy and must not fall through
 * to handling a caller might treat as merely empty.
 */
async function readMembership(
  allowedRoles: readonly BusinessRole[] | null,
): Promise<Membership | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const base = supabase
    .from("business_staff")
    .select("business_id, role")
    .eq("user_id", user.id)
    .eq("status", "active");

  const scoped = allowedRoles === null ? base : base.in("role", [...allowedRoles]);

  const { data, error } = await scoped
    .limit(1)
    .maybeSingle<{ business_id: string; role: string }>();

  if (error !== null) {
    console.error("[businesses] could not resolve the caller's membership", error);
    return null;
  }
  if (data === null) return null;

  return { userId: user.id, businessId: data.business_id, role: data.role };
}

async function readBusiness(businessId: string): Promise<OwnerBusiness | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("businesses")
    .select("id, slug, name, status")
    .eq("id", businessId)
    .maybeSingle<OwnerBusiness>();

  return data ?? null;
}

/**
 * Resolves the signed-in caller's business by looking up their first active
 * `business_staff` row, then loading that business's id/slug/name/status.
 * Returns null if the caller has no session or no active membership. Never
 * accepts a business id from the client - this is the only path server
 * actions use to learn "whose" business they're mutating.
 */
export async function resolveOwnerBusiness(): Promise<OwnerBusiness | null> {
  const membership = await readMembership(null);
  if (!membership) return null;

  return readBusiness(membership.businessId);
}

/** The one user-facing refusal for a suspended tenant, shared by every write gate. */
export const BUSINESS_SUSPENDED_MESSAGE =
  "This business is suspended. Contact Giya support to restore access.";

export type StaffAccess =
  | { ok: true; context: StaffContext }
  | { ok: false; reason: "no_access" | "suspended" };

/**
 * `resolveStaffContext` with the refusal reason kept, for write actions that
 * want to tell a suspended merchant WHY (doc 30 section 2.8: a suspended
 * business is blocked, BUSINESS_SUSPENDED).
 *
 * The portal layout already redirects a suspended business to /suspended, but
 * that is a courtesy: a server action can be POSTed directly (docs/README.md
 * golden rule 4), so the refusal lives here, in the tenancy resolver every
 * write goes through, not in the UI. The layout reads status through
 * `resolveOwnerBusiness`, which deliberately does NOT refuse, so the suspended
 * screen keeps working. `closed` is NOT refused: it is the merchant's own end
 * state, not a sanction (see the portal layout).
 */
export const resolveStaffAccess = cache(async function resolveStaffAccess(
  allowedRoles: readonly BusinessRole[],
): Promise<StaffAccess> {
  const membership = await readMembership(allowedRoles);
  if (!membership) return { ok: false, reason: "no_access" };

  const business = await readBusiness(membership.businessId);
  if (!business) return { ok: false, reason: "no_access" };

  if (business.status === "suspended") return { ok: false, reason: "suspended" };

  return {
    ok: true,
    context: {
      userId: membership.userId,
      businessId: business.id,
      businessName: business.name,
      businessSlug: business.slug,
      businessStatus: business.status,
      role: membership.role as BusinessRole,
    },
  };
});

/**
 * The signed-in caller's business AND the role they hold in it, or null when
 * there is no session, no active membership, or a membership whose role is not
 * in `allowedRoles`.
 *
 * A SUSPENDED business also resolves to null, so every caller fails closed
 * (see `resolveStaffAccess` for why, and for the variant that says so).
 *
 * Null is the only failure shape on purpose (same reasoning as
 * `resolveReviewerContext`): a page turns it into a redirect and a server
 * action turns it into a refusal, and neither ever needs to distinguish "not
 * signed in" from "not allowed".
 *
 * Wrapped in React's `cache` so a page and the components under it share one
 * resolution per request. The cache key includes the role list, and the cache
 * is per-request, so it can never carry one caller's tenant into another
 * caller's render.
 */
export const resolveStaffContext = cache(async function resolveStaffContext(
  allowedRoles: readonly BusinessRole[],
): Promise<StaffContext | null> {
  const access = await resolveStaffAccess(allowedRoles);
  return access.ok ? access.context : null;
});
