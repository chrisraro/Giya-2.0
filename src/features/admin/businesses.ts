import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { describeBaseRule } from "@/features/businesses/activation/presenter";
import type { BaseRuleShape } from "@/features/businesses/activation/types";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

import type { AdminBusinessReviewItem } from "./types";

// ===========================================================================
// THE MERCHANT VERIFICATION QUEUE (doc 31 section 3, doc 32 section 2).
//
// ---------------------------------------------------------------------------
// THERE IS NO TENANCY PREDICATE IN THIS FILE, AND THAT IS THE POINT.
// ---------------------------------------------------------------------------
// Same header as ./queue.ts, restated rather than cross-referenced because
// someone will read this file alone: the fence is `resolveAdminContext()` in
// ./access.ts, called by the layout above every page and by every server
// action. Nothing in this module may be called from a route that is not under
// `(admin)`, and no function here takes a business id from a caller who is not
// already past that gate.
//
// Why the service role. 0033 added `businesses_admin_select` and
// `business_verifications_admin_select`, so a direct client read by an admin is
// now correct rather than silently empty - but the queue still reads through
// the service role, for the reason every other admin surface does: it joins
// across `business_staff` and `profiles`, whose policies are tenant-scoped and
// which have no admin policy (0033 says why it deliberately did not add one to
// `business_staff`: the roster carries `invite_token`, and widening it needs a
// column fence first).
//
// FAILURE SHAPE, inherited: every read returns `null` for "could not be read"
// and `[]` only for "read successfully and there is nothing". An empty
// verification queue is a claim that no merchant is waiting, and a merchant
// waiting is a merchant who cannot trade. A dropped connection is not entitled
// to make that claim.
// ===========================================================================

/** Ceiling on one queue page. This is a working list, not an archive. */
const QUEUE_LIMIT = 100;

export interface AdminBusinessDeps {
  /** MUST be the service-role client. See the header. */
  supabase: SupabaseClient<Database>;
}

export function defaultAdminBusinessDeps(): AdminBusinessDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[admin/businesses] SUPABASE_SERVICE_ROLE_KEY is not configured; the verification queue cannot be read",
    );
    return null;
  }
  return { supabase };
}

interface BusinessRow {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  city_id: string | null;
  business_type_id: string;
  created_at: string;
}

const BUSINESS_COLUMNS =
  "id, name, slug, email, phone, city_id, business_type_id, created_at";

/**
 * Businesses waiting on a go-live decision, oldest first.
 *
 * OLDEST FIRST, deliberately, and it is the opposite of the fraud queue's
 * instinct. A flagged receipt is triaged by severity because the worst one is
 * the most urgent. An applicant is not: every one of them is equally blocked
 * from trading, so the only fair order is how long they have been waiting, and
 * the merchant at the top is the one whose patience is running out.
 *
 * Served by `businesses_pending_review_idx` (0033), a partial index on exactly
 * this predicate in exactly this order.
 */
export async function listBusinessesAwaitingReview(
  deps: AdminBusinessDeps | null = defaultAdminBusinessDeps(),
): Promise<AdminBusinessReviewItem[] | null> {
  if (deps === null) return null;

  const { data, error } = await deps.supabase
    .from("businesses")
    .select(BUSINESS_COLUMNS)
    .eq("status", "pending_verification")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(QUEUE_LIMIT);

  if (error !== null) {
    console.error("[admin/businesses] verification queue read failed", error);
    return null;
  }

  const rows = (data ?? []) as BusinessRow[];
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  const [cities, types, owners, rounds, rules, menus] = await Promise.all([
    loadCityNames(deps, rows.map((row) => row.city_id)),
    loadBusinessTypeNames(deps, rows.map((row) => row.business_type_id)),
    loadOwnerNames(deps, ids),
    loadOpenRounds(deps, ids),
    loadBaseRules(deps, ids),
    loadMenuPresence(deps, ids),
  ]);

  return rows.map((row) => {
    const round = rounds.get(row.id) ?? null;
    return {
      businessId: row.id,
      name: row.name,
      slug: row.slug,
      cityName: row.city_id === null ? null : (cities.get(row.city_id) ?? null),
      businessTypeName: types.get(row.business_type_id) ?? null,
      contactEmail: row.email,
      contactPhone: row.phone,
      ownerName: owners.get(row.id) ?? null,
      createdAt: row.created_at,
      submittedAt: round?.createdAt ?? null,
      applicantNote: round?.notes ?? null,
      earningRule: describeBaseRule(rules.get(row.id) ?? null),
      hasMenu: menus.has(row.id),
    } satisfies AdminBusinessReviewItem;
  });
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

async function loadCityNames(
  deps: AdminBusinessDeps,
  cityIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(cityIds.filter((id): id is string => id !== null)));
  if (unique.length === 0) return new Map();

  const { data, error } = await deps.supabase.from("ref_cities").select("id, name").in("id", unique);
  if (error !== null) {
    console.error("[admin/businesses] city name read failed", error);
    return new Map();
  }
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
}

async function loadBusinessTypeNames(
  deps: AdminBusinessDeps,
  typeIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(typeIds));
  if (unique.length === 0) return new Map();

  const { data, error } = await deps.supabase
    .from("ref_business_types")
    .select("id, name")
    .in("id", unique);
  if (error !== null) {
    console.error("[admin/businesses] business type read failed", error);
    return new Map();
  }
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
}

/**
 * The owner's display name, per business.
 *
 * ONLY `display_name`, exactly as `loadDisplayNames` in ./queue.ts does for
 * consumers, and the argument is the same one: an admin CAN read more and the
 * service role would let them, but "may" is not "needs". The business's own
 * contact email and phone are on the `businesses` row and are what an admin
 * would use to get in touch; the owner's personal profile fields are not part
 * of this decision.
 *
 * `business_staff_one_owner` (0002) makes at most one active owner per
 * business, so the map is unambiguous by construction.
 */
async function loadOwnerNames(
  deps: AdminBusinessDeps,
  businessIds: readonly string[],
): Promise<Map<string, string>> {
  const { data, error } = await deps.supabase
    .from("business_staff")
    .select("business_id, user_id")
    .in("business_id", [...businessIds])
    .eq("role", "owner")
    .eq("status", "active");

  if (error !== null) {
    console.error("[admin/businesses] owner read failed", error);
    return new Map();
  }

  const staff = (data ?? []) as Array<{ business_id: string; user_id: string }>;
  if (staff.length === 0) return new Map();

  const { data: profiles, error: profileError } = await deps.supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", staff.map((row) => row.user_id));

  if (profileError !== null) {
    console.error("[admin/businesses] owner profile read failed", profileError);
    return new Map();
  }

  const names = new Map(
    ((profiles ?? []) as Array<{ id: string; display_name: string }>).map((r) => [
      r.id,
      r.display_name,
    ]),
  );

  const byBusiness = new Map<string, string>();
  for (const row of staff) {
    const name = names.get(row.user_id);
    if (name !== undefined) byBusiness.set(row.business_id, name);
  }
  return byBusiness;
}

interface OpenRound {
  createdAt: string;
  notes: string | null;
}

/**
 * The OPEN round per business: `status='pending'`, most recent first.
 *
 * There can be at most one in practice - `submit_business_for_review` (0033)
 * refuses a second submission with SUBMIT_INVALID_STATE while the first is
 * open - but the query does not depend on that, because a database that
 * predates the RPC can hold rows the RPC would not have written. The first row
 * seen per business wins, which is the newest.
 */
async function loadOpenRounds(
  deps: AdminBusinessDeps,
  businessIds: readonly string[],
): Promise<Map<string, OpenRound>> {
  const { data, error } = await deps.supabase
    .from("business_verifications")
    .select("business_id, notes, created_at")
    .in("business_id", [...businessIds])
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error !== null) {
    console.error("[admin/businesses] verification round read failed", error);
    return new Map();
  }

  const byBusiness = new Map<string, OpenRound>();
  for (const row of (data ?? []) as Array<{
    business_id: string;
    notes: string | null;
    created_at: string;
  }>) {
    if (byBusiness.has(row.business_id)) continue;
    byBusiness.set(row.business_id, { createdAt: row.created_at, notes: row.notes });
  }
  return byBusiness;
}

/**
 * Each business's active base earning rule, if it has one.
 *
 * THIS IS THE FIELD THE DECISION TURNS ON. `activate_business` (0033) refuses
 * with ACTIVATION_NO_EARNING_RULE when it is absent, so a queue that did not
 * show it would send an admin to press a button the database will reject, with
 * no explanation on screen for why.
 *
 * This read is a COURTESY, never the guard: between this render and the RPC
 * call the merchant can delete their rule, and the function re-checks it under
 * the business row lock. Exactly the relationship `loadClawbackEligibility`
 * has with `clawback_receipt_points`.
 */
async function loadBaseRules(
  deps: AdminBusinessDeps,
  businessIds: readonly string[],
): Promise<Map<string, BaseRuleShape>> {
  const { data, error } = await deps.supabase
    .from("points_rules")
    .select("business_id, rule_type, rate_centavos_per_point, fixed_points, tiers")
    .in("business_id", [...businessIds])
    .eq("kind", "base")
    .eq("is_active", true)
    .is("deleted_at", null);

  if (error !== null) {
    console.error("[admin/businesses] base rule read failed", error);
    return new Map();
  }

  const byBusiness = new Map<string, BaseRuleShape>();
  for (const row of (data ?? []) as Array<BaseRuleShape & { business_id: string }>) {
    byBusiness.set(row.business_id, {
      rule_type: row.rule_type,
      rate_centavos_per_point: row.rate_centavos_per_point,
      fixed_points: row.fixed_points,
      tiers: row.tiers,
    });
  }
  return byBusiness;
}

/** Which of these businesses have put anything on their menu. Context, not a gate. */
async function loadMenuPresence(
  deps: AdminBusinessDeps,
  businessIds: readonly string[],
): Promise<Set<string>> {
  const { data, error } = await deps.supabase
    .from("products")
    .select("business_id")
    .in("business_id", [...businessIds])
    .is("deleted_at", null);

  if (error !== null) {
    console.error("[admin/businesses] menu presence read failed", error);
    return new Set();
  }
  return new Set(((data ?? []) as Array<{ business_id: string }>).map((row) => row.business_id));
}
