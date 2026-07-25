import type { BusinessRole } from "@/features/businesses/server/resolve-owner-business";

// Kept out of actions.ts because a "use server" module may only export async
// functions; the page needs both lists to decide whether to render the Manage
// action at all.

/**
 * Doc 01 matrix, "View customer list/profiles": owner, manager, marketing.
 * Mirrored by `business_customers_staff_select` (migration 0011).
 */
export const CUSTOMER_VIEW_ROLES: readonly BusinessRole[] = ["owner", "manager", "marketing"];

/**
 * Doc 01 matrix, "Segment (VIP/blacklist)": owner and manager only - marketing
 * can see the list but not change standing. Mirrored by
 * `business_customers_staff_update` (0011), which names the same two roles, so
 * a marketing session is refused in the action AND by RLS.
 */
export const CUSTOMER_WRITE_ROLES: readonly BusinessRole[] = ["owner", "manager"];
