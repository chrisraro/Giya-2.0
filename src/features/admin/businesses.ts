import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { describeBaseRule } from "@/features/businesses/activation/presenter";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

import type { AdminBusinessReviewItem } from "./types";

const QUEUE_LIMIT = 100;

export interface AdminBusinessDeps {
  /** MUST be the service-role client. */
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
  status: string;
  created_at: string;
}

const BUSINESS_COLUMNS =
  "id, name, slug, email, phone, city_id, business_type_id, status, created_at";

export async function listBusinessesAwaitingReview(
  filterOrDeps?: "pending" | "active" | "all" | AdminBusinessDeps | null,
  depsParam?: AdminBusinessDeps | null,
): Promise<AdminBusinessReviewItem[] | null> {
  let filter: "pending" | "active" | "all" = "pending";
  let deps: AdminBusinessDeps | null = null;

  if (typeof filterOrDeps === "string") {
    filter = filterOrDeps;
    deps = depsParam !== undefined ? depsParam : defaultAdminBusinessDeps();
  } else {
    filter = "pending";
    deps = filterOrDeps !== undefined ? filterOrDeps : defaultAdminBusinessDeps();
  }

  if (deps === null) return null;

  let query = deps.supabase
    .from("businesses")
    .select(BUSINESS_COLUMNS)
    .is("deleted_at", null);

  if (filter === "pending") {
    query = query.in("status", ["pending", "pending_verification", "draft"]);
  } else if (filter === "active") {
    query = query.eq("status", "active");
  }

  const { data, error } = await query
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
      status: row.status,
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
    console.error("[admin/businesses] type name read failed", error);
    return new Map();
  }
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
}

async function loadOwnerNames(
  deps: AdminBusinessDeps,
  businessIds: readonly string[],
): Promise<Map<string, string>> {
  if (businessIds.length === 0) return new Map();

  const { data: staffData, error: staffError } = await deps.supabase
    .from("business_staff")
    .select("business_id, user_id")
    .in("business_id", businessIds)
    .eq("role", "owner")
    .eq("status", "active");

  if (staffError !== null || staffData === null || staffData.length === 0) {
    if (staffError !== null) console.error("[admin/businesses] owner staff read failed", staffError);
    return new Map();
  }

  const staffRows = staffData as Array<{ business_id: string; user_id: string }>;
  const userIds = Array.from(new Set(staffRows.map((r) => r.user_id)));

  const { data: profileData, error: profileError } = await deps.supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", userIds);

  if (profileError !== null || profileData === null) {
    if (profileError !== null) console.error("[admin/businesses] owner profile read failed", profileError);
    return new Map();
  }

  const profileMap = new Map(
    (profileData as Array<{ id: string; display_name: string | null }>).map((p) => [
      p.id,
      p.display_name,
    ]),
  );

  const out = new Map<string, string>();
  for (const s of staffRows) {
    const name = profileMap.get(s.user_id);
    if (name) out.set(s.business_id, name);
  }
  return out;
}

interface RoundRow {
  business_id: string;
  notes: string | null;
  created_at: string;
}

async function loadOpenRounds(
  deps: AdminBusinessDeps,
  businessIds: readonly string[],
): Promise<Map<string, { notes: string | null; createdAt: string }>> {
  if (businessIds.length === 0) return new Map();

  const { data, error } = await deps.supabase
    .from("business_verifications")
    .select("business_id, notes, created_at")
    .in("business_id", businessIds)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error !== null || data === null) {
    if (error !== null) console.error("[admin/businesses] open rounds read failed", error);
    return new Map();
  }

  const out = new Map<string, { notes: string | null; createdAt: string }>();
  for (const r of data as RoundRow[]) {
    if (!out.has(r.business_id)) {
      out.set(r.business_id, { notes: r.notes, createdAt: r.created_at });
    }
  }
  return out;
}

async function loadBaseRules(
  deps: AdminBusinessDeps,
  businessIds: readonly string[],
): Promise<Map<string, Database["public"]["Tables"]["points_rules"]["Row"]>> {
  if (businessIds.length === 0) return new Map();

  const { data, error } = await deps.supabase
    .from("points_rules")
    .select("*")
    .in("business_id", businessIds)
    .eq("kind", "base")
    .eq("is_active", true)
    .is("deleted_at", null);

  if (error !== null || data === null) {
    if (error !== null) console.error("[admin/businesses] base rules read failed", error);
    return new Map();
  }

  return new Map(
    (data as Array<Database["public"]["Tables"]["points_rules"]["Row"]>).map((r) => [
      r.business_id,
      r,
    ]),
  );
}

async function loadMenuPresence(
  deps: AdminBusinessDeps,
  businessIds: readonly string[],
): Promise<Set<string>> {
  if (businessIds.length === 0) return new Set();

  const { data, error } = await deps.supabase
    .from("products")
    .select("business_id")
    .in("business_id", businessIds)
    .is("deleted_at", null);

  if (error !== null || data === null) {
    if (error !== null) console.error("[admin/businesses] menu presence read failed", error);
    return new Set();
  }

  return new Set(
    (data as Array<{ business_id: string }>).map((r) => r.business_id),
  );
}
