import type { Database } from "@/lib/supabase/types";

// DTOs for the business-portal CRM (`/business/customers`, doc 32 section 8).

export type BusinessCustomerRow = Database["public"]["Tables"]["business_customers"]["Row"];

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; message: string; code?: string };

/** `business_customers.segment`'s check constraint, verbatim. */
export const CUSTOMER_SEGMENTS = ["regular", "vip", "blacklisted"] as const;
export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

export function isCustomerSegment(value: string): value is CustomerSegment {
  return (CUSTOMER_SEGMENTS as readonly string[]).includes(value);
}

/** Segment filter for the list; "all" is the absence of a filter, not a value. */
export type SegmentFilter = CustomerSegment | "all";

export function isSegmentFilter(value: string): value is SegmentFilter {
  return value === "all" || isCustomerSegment(value);
}

/**
 * The sorts the list offers, mapped to real columns in server/repo.ts. Named
 * rather than free text because the value arrives in a query parameter, and a
 * caller-supplied string must never reach an `.order()` call.
 */
export const CUSTOMER_SORTS = ["last_visit", "points", "visits", "spend", "lifetime"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export function isCustomerSort(value: string): value is CustomerSort {
  return (CUSTOMER_SORTS as readonly string[]).includes(value);
}

/**
 * One CRM row.
 *
 * NO NAME, DELIBERATELY. Doc 32 section 8 lists "consumer display name" as the
 * first column, and it is absent here because the database will not give it to
 * a merchant: `public.profiles` carries exactly two select policies
 * (supabase/migrations/0002_identity.sql) - the consumer's own row, and platform
 * admins. There is no staff-read policy, so a tenant's session reading
 * `profiles` gets nothing back. The honest options were to invent a name, to
 * read names through the service role (which is how the receipt review queue
 * works, and which turns code into the tenancy fence for a screen that does not
 * need it), or to show a stable per-customer reference until a staff-read
 * policy exists. This slice took the third. `reference` is derived from the
 * consumer id, so it is stable across sessions and identifies the row in a
 * conversation ("customer 4F2A"), while leaking nothing the merchant could not
 * already see.
 */
export interface CustomerListItem {
  id: string;
  consumerId: string;
  reference: string;
  segment: CustomerSegment;
  pointsBalance: number;
  lifetimePoints: number;
  lifetimeSpendCentavos: number;
  visitCount: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  notes: string | null;
}
