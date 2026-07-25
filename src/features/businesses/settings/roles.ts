import type { BusinessRole } from "../server/resolve-owner-business";

// Kept out of actions.ts because a "use server" module may only export async
// functions.

/**
 * Doc 01 matrix, "Edit profile/hours/gallery": owner and manager. Mirrored by
 * `businesses_staff_update` (migration 0011), which names the same pair - so
 * marketing and staff are refused in the action AND by RLS.
 *
 * Note this is NOT the owner-only row: doc 32 section 13 reserves the settings
 * DANGER ZONE for owners, and this screen deliberately contains no danger zone.
 * The destructive verbs that would need one run through `businesses.status`,
 * which this slice does not write at all - see schemas.ts for why.
 */
export const BUSINESS_SETTINGS_ROLES: readonly BusinessRole[] = ["owner", "manager"];
