import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

import { isUsableBaseRule } from "../presenter";
import { isBusinessStatus } from "../types";
import type {
  ActivationFacts,
  BaseRuleShape,
  VerificationRound,
  VerificationRoundStatus,
} from "../types";

// ===========================================================================
// The facts the activation surfaces are built from, read once per request.
//
// READ UNDER THE CALLER'S OWN SESSION, not the service role, and that is a
// deliberate difference from the admin half of this slice. Every table touched
// here has a policy that already scopes it to the caller's tenant
// (`businesses_staff_select`, `points_rules_staff_select`,
// `products_staff_select`, `business_verifications_staff_select`), so RLS is a
// real second fence underneath the explicit `business_id` predicate. The admin
// queue cannot have that fence, because it is platform-wide by construction,
// and it says so at length in its own header. This one can, so it does.
//
// The service role appears exactly once in this feature: the submission itself,
// because 0033 grants EXECUTE on `submit_business_for_review` to `service_role`
// alone. See ../actions.ts.
//
// FAILURE SHAPE: `null` means "could not be read", never "nothing to do". A
// checklist that renders as complete because a query failed would invite a
// merchant to submit and be refused by the RPC, or worse, to believe they are
// set up when they are not.
// ===========================================================================

const ROUND_STATUSES: readonly VerificationRoundStatus[] = [
  "pending",
  "approved",
  "rejected",
  "revision_requested",
];

function toRoundStatus(value: string): VerificationRoundStatus {
  return (ROUND_STATUSES as readonly string[]).includes(value)
    ? (value as VerificationRoundStatus)
    : "pending";
}

interface BusinessRow {
  status: string;
  logo_url: string | null;
  cover_url: string | null;
  opening_hours: unknown;
}

interface RoundRow {
  id: string;
  status: string;
  decision_reason: string | null;
  decided_at: string | null;
  created_at: string;
}

/** doc 32 section 4's opening-hours editor writes an array; anything else is not set. */
function hasOpeningHours(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Everything the go-live card and the banner need for one tenant.
 *
 * Wrapped in React's `cache` so the dashboard page, the banner and the card
 * share one resolution per request. The cache key is the business id and the
 * cache is per-request, so it can never carry one tenant's state into another
 * caller's render.
 */
export const loadActivationFacts = cache(async function loadActivationFacts(
  businessId: string,
): Promise<ActivationFacts | null> {
  const supabase = await createClient();

  const [business, rule, product, round] = await Promise.all([
    supabase
      .from("businesses")
      .select("status, logo_url, cover_url, opening_hours")
      .eq("id", businessId)
      .maybeSingle<BusinessRow>(),
    // The same predicate `points_rules_one_base` (0012) makes unique: at most
    // one active, undeleted base rule per business.
    supabase
      .from("points_rules")
      .select("rule_type, rate_centavos_per_point, fixed_points, tiers")
      .eq("business_id", businessId)
      .eq("kind", "base")
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle<BaseRuleShape>(),
    // Existence, not a count. "Do they have a menu" is a yes or no question and
    // a bounded read answers it without paging a large catalog.
    supabase
      .from("products")
      .select("id")
      .eq("business_id", businessId)
      .is("deleted_at", null)
      .limit(1),
    supabase
      .from("business_verifications")
      .select("id, status, decision_reason, decided_at, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<RoundRow>(),
  ]);

  if (business.error !== null || business.data === null) {
    console.error(
      `[businesses/activation] could not read the business ${businessId}`,
      business.error,
    );
    return null;
  }
  // The rule read is the one failure that must not degrade quietly: falling
  // through to `hasEarningRule: false` would tell a merchant who has a rule to
  // go and set one, and falling through to true would tick a box the RPC then
  // refuses.
  if (rule.error !== null) {
    console.error(
      `[businesses/activation] could not read the base earning rule for ${businessId}`,
      rule.error,
    );
    return null;
  }
  if (round.error !== null) {
    console.error(
      `[businesses/activation] could not read the verification rounds for ${businessId}`,
      round.error,
    );
    return null;
  }

  const status = business.data.status;
  if (!isBusinessStatus(status)) {
    // 0002's check constraint makes this unreachable from the database side, so
    // reaching it means the constraint changed and this module did not.
    console.error(`[businesses/activation] unknown business status ${status} on ${businessId}`);
    return null;
  }

  const roundRow = round.data;
  const latestRound: VerificationRound | null =
    roundRow === null
      ? null
      : {
          id: roundRow.id,
          status: toRoundStatus(roundRow.status),
          decisionReason: roundRow.decision_reason,
          decidedAt: roundRow.decided_at,
          createdAt: roundRow.created_at,
        };

  return {
    businessId,
    status,
    hasEarningRule: isUsableBaseRule(rule.data),
    // A failed product read is reported as "no menu yet", not as a failure:
    // this item is advice and cannot block anything, so refusing to render the
    // whole card over it would trade a small inaccuracy for a large one.
    hasMenuItem: product.error === null && (product.data ?? []).length > 0,
    hasStorefrontDetails:
      (business.data.logo_url !== null || business.data.cover_url !== null) &&
      hasOpeningHours(business.data.opening_hours),
    latestRound,
  };
});
