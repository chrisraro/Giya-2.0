import { createClient } from "@/lib/supabase/server";

import type { Database, Json } from "@/lib/supabase/types";

export type BusinessRow = Database["public"]["Tables"]["businesses"]["Row"];

export type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

// ===========================================================================
// THE SECOND FENCE.
//
// schemas.ts refuses an input that even NAMES `status`, `verified_at` or
// `plan`. This module refuses a PATCH that names them, which is a different
// guarantee: it holds for any future caller that assembles an update by hand
// instead of going through the schema.
//
// It exists because `businesses_staff_update` is row-scoped and grants no
// column privileges - supabase/README.md's "Known limitations" names exactly
// these three columns as the gap and marks the fencing migration as owed. Until
// that migration lands, an owner's session is technically able to write them,
// and the only thing standing in the way is that no code path builds a patch
// containing them. This assertion is that promise, written down and tested.
// ===========================================================================

/**
 * The presentation columns this screen may write. Nothing else, ever.
 *
 * `lat` and `lng` were added here when the map picker landed, and the way they
 * were added is the point: they moved from FORBIDDEN_BUSINESS_COLUMNS to this
 * list as a pair, in one edit, with the schema's own reasoning updated in the
 * same change. Nothing about the assertion below was relaxed to let them
 * through. A future column follows the same route or it does not get written.
 */
export const EDITABLE_BUSINESS_COLUMNS = [
  "name",
  "description",
  "phone",
  "email",
  "website",
  "socials",
  "address_line",
  "barangay",
  "postal_code",
  "lat",
  "lng",
  "opening_hours",
] as const;

export type EditableBusinessColumn = (typeof EDITABLE_BUSINESS_COLUMNS)[number];

/**
 * A patch that is, by construction, confined to the allowlist: there is no key
 * on this type for `status`, `verified_at`, `plan` or anything else, so the
 * excluded columns are unspellable rather than merely discouraged.
 */
export interface BusinessProfilePatch {
  name: string;
  description: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  socials: Json;
  address_line: string | null;
  barangay: string | null;
  postal_code: string | null;
  /** Both or neither. The pairing is enforced by ../schemas.ts. */
  lat: number | null;
  lng: number | null;
  opening_hours: Json;
}

/**
 * Columns a client must never write from this screen, listed by name so the
 * failure message says which line was crossed rather than "unexpected key".
 * The first three are the documented column-granularity gap.
 */
export const FORBIDDEN_BUSINESS_COLUMNS = [
  "status",
  "verified_at",
  "plan",
  "plan_limits",
  "suspended_reason",
  "slug",
  // `lat`/`lng` are absent from this list on purpose: the map picker writes
  // them and they moved to EDITABLE_BUSINESS_COLUMNS above. `google_place_id`
  // did NOT move - the picker is not Google's, so nothing in this codebase can
  // mint a value for that column (see ../schemas.ts).
  "google_place_id",
  "city_id",
  "business_type_id",
  "logo_url",
  "cover_url",
  "gallery",
  "deleted_at",
] as const;

/**
 * Throws when a patch names a column outside the allowlist. Exported so the
 * test suite can assert the fence directly.
 */
export function assertEditableColumns(patch: object): void {
  const allowed: readonly string[] = EDITABLE_BUSINESS_COLUMNS;
  const trespassing = Object.keys(patch).filter((key) => !allowed.includes(key));
  if (trespassing.length > 0) {
    throw new Error(
      `businesses update tried to write ungranted column(s): ${trespassing.join(", ")}. ` +
        `The business profile form writes only ${allowed.join(", ")}.`,
    );
  }
}

/**
 * The profile the settings screen renders. `status`, `verified_at` and `plan`
 * ARE read (they are shown, read-only, so the merchant understands why an
 * activation button elsewhere is disabled) - the fence is on writes, not on
 * knowing.
 */
export async function getBusinessProfile(businessId: string): Promise<Result<BusinessRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  return { data, error };
}

export async function updateBusinessProfile(
  businessId: string,
  patch: BusinessProfilePatch,
): Promise<Result<BusinessRow>> {
  assertEditableColumns(patch);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("businesses")
    .update(patch)
    .eq("id", businessId)
    .select()
    .single();

  return { data, error };
}
