import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

// ===========================================================================
// The gate for every admin surface.
//
// READ THIS BEFORE TOUCHING ANYTHING IN `queue.ts` OR `consequences.ts`.
//
// This is the admin counterpart of `features/receipts/review/access.ts`, and
// it is deliberately the same shape for the same reason: everything below it
// reads through the SERVICE ROLE, which bypasses RLS entirely, so RLS is not
// the fence on those reads and this function is.
//
// The difference from the business version is the one that matters: the
// business fence resolves a BUSINESS ID that every downstream query then
// applies as a predicate. There is no such predicate here, because the whole
// point of the admin surfaces is that they are platform-wide (doc 31 §5, doc
// 37 "Admin fraud queue: platform-wide"). So this function is not one fence
// among several - it is the ONLY fence, and a caller that forgets it has
// published the entire platform.
//
// WHY TABLE TRUTH AND NOT THE CLAIM. `private.is_admin()` reads
// `app_metadata.is_platform_admin` out of the JWT and that is correct for RLS,
// where doc 12 fixes claims as the authorization hint. It is NOT correct here.
// Doc 12, same section: "Claims are authorization hints for RLS, not the source
// of truth. The source of truth is the tables. Claims refresh on token refresh
// (<=1h); revocation must be immediate, so destructive-permission checks (staff
// removal, suspension) also verify against the table server-side." An admin
// deactivated ten minutes ago is still carrying a valid claim for up to an
// hour, and the actions behind this gate are suspension and clawback. The
// portal layout gates on this table read, exactly as the business portal layout
// gates on a `business_staff` read rather than on the `biz` claim.
//
// The read runs under the CALLER'S OWN SESSION, not the service role, so
// `platform_admins_select` (0002: `user_id = auth.uid()` or a super_admin
// claim) is a second, independent fence underneath the explicit `user_id`
// predicate. A caller can only ever read their own row.
// ===========================================================================

/** doc 01's permission matrix rows and 0002's `platform_admins.role` check. */
export const ADMIN_ROLES = ["super_admin", "admin", "support"] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export interface AdminContext {
  /** `profiles.id` of the signed-in admin; the actor id every audit row carries. */
  userId: string;
  displayName: string;
  role: AdminRole;
}

function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

/**
 * doc 01's matrix and doc 31 §11: `support` is read-only everywhere and never
 * takes a destructive action. Every consequence-ladder action checks this, and
 * `clawback_receipt_points` re-checks it in SQL against the same table, so a
 * bug here cannot mint a ledger row.
 *
 * Exported as a predicate rather than inlined as `role !== "support"` so the
 * screens can DISABLE what they must not offer, instead of offering it and
 * failing after the reason has been typed.
 */
export function canActOnLadder(role: AdminRole): boolean {
  return role === "super_admin" || role === "admin";
}

/**
 * The signed-in caller's admin identity, or null when there is no session, no
 * `platform_admins` row, or a row that has been deactivated.
 *
 * Null is the only failure shape, exactly as in the business version: the
 * layout turns it into a 404 (not a redirect - see the layout for why a
 * non-admin must not learn that `/admin` exists) and a server action turns it
 * into a refusal. Nothing downstream ever needs to tell "not signed in" apart
 * from "not an admin", and a code path that could tell them apart is an oracle
 * for who the platform admins are.
 *
 * Wrapped in React's `cache` so the layout, the page beneath it and any server
 * action in the same request share one resolution. The cache is per-request, so
 * it can never carry one caller's identity into another caller's render.
 */
export const resolveAdminContext = cache(async function resolveAdminContext(): Promise<AdminContext | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: admin, error } = await supabase
    .from("platform_admins")
    .select("user_id, role, is_active")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle<{ user_id: string; role: string; is_active: boolean }>();

  if (error !== null) {
    console.error("[admin/access] could not resolve the caller's admin row", error);
    return null;
  }
  if (admin === null || !isAdminRole(admin.role)) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("id", user.id)
    .maybeSingle<{ id: string; display_name: string }>();

  return {
    userId: user.id,
    displayName: profile?.display_name ?? "Admin",
    role: admin.role,
  };
});
