import type { BusinessRole } from "@/features/businesses/server/resolve-owner-business";

// Kept out of actions.ts because a "use server" module may only export async
// functions. Same reason as features/businesses/settings/roles.ts.

/**
 * Who may post a campaign announcement to a connected Facebook Page.
 *
 * Doc 32 section 11.1 puts the campaign composer in front of owner, manager and
 * marketing, and that is what this list is: the audience for COMPOSING and
 * SENDING a campaign message, which is what publishing to a Page is.
 *
 * IT IS NOT DOC 01'S "Connect Meta/IG" ROW, which is narrower (owner and
 * marketing, manager excluded) and governs a different verb: establishing or
 * removing the OAuth grant. That still lives on /business/settings and this
 * slice does not touch it. The distinction is worth keeping: granting a third
 * party access to a Page is a different decision from using access that has
 * already been granted, and collapsing the two would either lock managers out
 * of routine marketing or hand them the connection controls.
 *
 * `staff` is absent from both lists. A counter seat has no business posting to
 * the shop's Page.
 */
export const BUSINESS_MARKETING_ROLES: readonly BusinessRole[] = [
  "owner",
  "manager",
  "marketing",
];
