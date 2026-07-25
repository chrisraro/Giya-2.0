import type { BusinessRole } from "@/features/businesses/server/resolve-owner-business";

// Kept out of actions.ts because a "use server" module may only export async
// functions; the page and the tests both need this list, and both would
// otherwise have to restate it.

/**
 * Doc 00-product/01-personas-roles.md, "Manage reward catalog": owner, manager
 * and marketing. Mirrored by `rewards_staff_insert` / `rewards_staff_update`
 * in supabase/migrations/0012_campaigns.sql, which name the same three roles -
 * so `staff` is refused twice, in the action and by RLS.
 */
export const REWARD_CATALOG_ROLES: readonly BusinessRole[] = ["owner", "manager", "marketing"];
