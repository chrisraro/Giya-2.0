import { createClient } from "@/lib/supabase/server";

import type { BusinessCustomerRow, CustomerSort, SegmentFilter } from "../types";

// Repo is the only layer in this feature that touches the Supabase client.
// RLS is the real authorization boundary: 0011 rewrote
// `business_customers_staff_select` to `private.is_active_staff(business_id,
// array['owner','manager','marketing'])` and `business_customers_staff_update`
// to the owner/manager pair, both table-truth rather than claim-based, so they
// hold even when the custom access token hook is not enabled. The explicit
// `.eq("business_id", businessId)` below is defense in depth.

export type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

// ===========================================================================
// THE COLUMN FENCE
// ===========================================================================
// supabase/migrations/0013_reward_claim_rpcs.sql, last two statements:
//
//   revoke update on public.business_customers from anon, authenticated;
//   grant update (segment, notes, updated_by) on public.business_customers
//     to authenticated;
//
// The point of that pair is that `points_balance`, `lifetime_points`,
// `visit_count` and `lifetime_spend_centavos` are DERIVED CACHES maintained by
// the points engine inside the same transaction as the ledger row. RLS is
// row-scoped and cannot express "this staff member may edit that column", so
// the privilege layer does it instead. An owner editing their own tenant passes
// every RLS predicate on this table; only the missing column privilege stops
// them minting a balance with no ledger row behind it.
//
// This module works INSIDE that grant rather than around it. Every update below
// builds its patch from `GRANTED_UPDATE_COLUMNS` and nothing else, and
// `assertGrantedColumns` fails loudly in development if a future edit adds a
// key - because the alternative failure mode is a 42501 surfaced to a merchant
// as an unexplained error at the exact moment they are trying to block a
// fraudulent customer.
// ===========================================================================

/** Exactly the columns 0013 grants `authenticated` on `business_customers`. */
export const GRANTED_UPDATE_COLUMNS = ["segment", "notes", "updated_by"] as const;

export type GrantedUpdateColumn = (typeof GRANTED_UPDATE_COLUMNS)[number];

/**
 * A patch that is, by construction, writable under the 0013 grant: the type has
 * no key for any other column, so `points_balance` and its siblings are not
 * merely discouraged here, they are unspellable.
 */
export interface GrantedCustomerPatch {
  segment?: string;
  notes?: string | null;
  updated_by?: string | null;
}

/**
 * Throws when a patch names a column outside the grant. Exported so the test
 * suite can assert the fence directly rather than inferring it from a mock.
 */
export function assertGrantedColumns(patch: object): void {
  const granted: readonly string[] = GRANTED_UPDATE_COLUMNS;
  const trespassing = Object.keys(patch).filter((key) => !granted.includes(key));
  if (trespassing.length > 0) {
    throw new Error(
      `business_customers update tried to write ungranted column(s): ${trespassing.join(", ")}. ` +
        `Migration 0013 grants only ${granted.join(", ")}.`,
    );
  }
}

/** Named sorts mapped to real columns; a query parameter never reaches `.order()`. */
const SORT_COLUMN: Record<CustomerSort, keyof BusinessCustomerRow> = {
  last_visit: "last_visit_at",
  points: "points_balance",
  visits: "visit_count",
  spend: "lifetime_spend_centavos",
  lifetime: "lifetime_points",
};

/**
 * Page size. Doc 32 section 8 specifies server-side cursor pagination through
 * `GET /api/v1/businesses/{businessId}/customers`; that route handler is not
 * this slice. Until it exists the screen reads a bounded first page rather than
 * an unbounded table scan, and says so on screen when it is full.
 */
export const CUSTOMER_PAGE_SIZE = 200;

export interface ListCustomersOptions {
  segment: SegmentFilter;
  sort: CustomerSort;
  limit?: number;
}

export async function listCustomers(
  businessId: string,
  options: ListCustomersOptions,
): Promise<Result<BusinessCustomerRow[]>> {
  const supabase = await createClient();

  let query = supabase
    .from("business_customers")
    .select("*")
    .eq("business_id", businessId);

  if (options.segment !== "all") {
    query = query.eq("segment", options.segment);
  }

  const { data, error } = await query
    .order(SORT_COLUMN[options.sort], { ascending: false, nullsFirst: false })
    .limit(options.limit ?? CUSTOMER_PAGE_SIZE);

  return { data, error };
}

export async function getCustomer(
  businessId: string,
  customerId: string,
): Promise<BusinessCustomerRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("business_customers")
    .select("*")
    .eq("id", customerId)
    .eq("business_id", businessId)
    .maybeSingle();

  return data ?? null;
}

/**
 * The single write path onto `business_customers`. Callers hand it a patch made
 * of granted columns only; it re-asserts that before the query, then scopes the
 * update by id AND business_id so a customer id from another tenant matches
 * nothing even before RLS is consulted.
 */
export async function updateGrantedColumns(
  businessId: string,
  customerId: string,
  patch: GrantedCustomerPatch,
): Promise<Result<BusinessCustomerRow>> {
  assertGrantedColumns(patch);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("business_customers")
    .update(patch)
    .eq("id", customerId)
    .eq("business_id", businessId)
    .select()
    .single();

  return { data, error };
}
