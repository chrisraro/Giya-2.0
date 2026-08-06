import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

// ===========================================================================
// Doc 30 section 2.8's two suspension consequences, read side.
//
// The admin ladder (src/features/admin/consequences.ts) writes
// `profiles.is_suspended` + `suspended_reason`; `businesses.status` carries
// `'suspended'` as one of its check-constrained values. Neither was read by
// anything before this module: a suspended consumer kept full access and a
// suspended business's portal never blocked. This file is the ONE place both
// facts are read from, so every gate - the consumer layout's screen redirect,
// the business portal layout's screen redirect, and the money-path refusals
// in claimReward/validateRedemption/submitReceipt - agrees on what
// "suspended" means and never re-derives it with a slightly different query.
//
// Doc 13 error codes, exported alongside the readers because every caller
// that turns "suspended" into a refusal needs the same stable string.
// ===========================================================================

export const ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED";
export const BUSINESS_SUSPENDED = "BUSINESS_SUSPENDED";

/**
 * `"active"` and `"suspended"` are definitive; `"unknown"` means the read
 * itself failed or found no row, which proves nothing either way.
 *
 * Deliberately NOT a boolean: a screen-level gate and a money-path gate need
 * DIFFERENT postures for `"unknown"`, and collapsing it into `false` would
 * force one of them to be wrong. See the call sites: the consumer/business
 * portal layouts treat `"unknown"` as "let the courtesy screen render" (the
 * redirect is not the control, doc 30's UI note), while every money path
 * treats it as "refuse" (the RPC-adjacent guard IS the control, and this
 * codebase's own convention - `campaignPointsAwarded`,
 * `campaignCustomerEarnCount` in receipts/server/award.ts, `assertCanAct` in
 * admin/consequences.ts - fails CLOSED on a read it cannot trust for a money
 * decision).
 */
export type SuspensionStatus = "active" | "suspended" | "unknown";

interface ProfileSuspensionRow {
  is_suspended: boolean;
}

/**
 * Reads `profiles.is_suspended` for `userId`.
 *
 * `supabase` should ordinarily be the caller's own session-scoped client
 * (RLS `profiles_owner_select` already limits a non-admin session to its own
 * row, so `userId` must be the caller's own id or the read returns no row
 * regardless of the id passed); a service-role client works too and is what
 * `submitReceipt` passes, since that whole module already runs service-role
 * per doc 36 Stage 1.
 */
export async function readConsumerSuspension(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<SuspensionStatus> {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_suspended")
    .eq("id", userId)
    .maybeSingle<ProfileSuspensionRow>();

  if (error !== null) {
    console.error("[auth/suspension] could not read profile suspension state", error);
    return "unknown";
  }
  if (data === null) return "unknown";
  return data.is_suspended ? "suspended" : "active";
}

interface BusinessSuspensionRow {
  status: string;
}

/**
 * Reads `businesses.status` for `businessId` and answers `"suspended"` only
 * for the exact value `'suspended'` - `businesses_status_check` also allows
 * `draft`, `pending_verification`, `active` and `closed`, none of which is
 * this gate's concern (a draft or closed business is a different problem,
 * handled elsewhere).
 */
export async function readBusinessSuspension(
  supabase: SupabaseClient<Database>,
  businessId: string,
): Promise<SuspensionStatus> {
  const { data, error } = await supabase
    .from("businesses")
    .select("status")
    .eq("id", businessId)
    .maybeSingle<BusinessSuspensionRow>();

  if (error !== null) {
    console.error("[auth/suspension] could not read business status", error);
    return "unknown";
  }
  if (data === null) return "unknown";
  return data.status === "suspended" ? "suspended" : "active";
}
