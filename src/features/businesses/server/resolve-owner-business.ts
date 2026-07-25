import { createClient } from "@/lib/supabase/server";

// Shared by every feature slice (menu, campaigns, ...) whose server actions
// need to know "whose" business they are acting on. Lifted out of
// src/features/menu/server/repo.ts (its original home) so the campaigns
// slice can reuse the exact same resolution instead of duplicating it;
// menu/server/repo.ts now re-exports this module's `resolveOwnerBusiness`
// so its own callers/tests are unaffected.

export type OwnerBusiness = {
  id: string;
  slug: string;
  name: string;
  status: string;
};

/**
 * Resolves the signed-in caller's business by looking up their first active
 * `business_staff` row, then loading that business's id/slug/name/status.
 * Returns null if the caller has no session or no active membership. Never
 * accepts a business id from the client - this is the only path server
 * actions use to learn "whose" business they're mutating.
 */
export async function resolveOwnerBusiness(): Promise<OwnerBusiness | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("business_staff")
    .select("business_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (!membership) return null;

  const { data: business } = await supabase
    .from("businesses")
    .select("id, slug, name, status")
    .eq("id", membership.business_id)
    .maybeSingle();

  return business ?? null;
}
