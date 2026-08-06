import type { BusinessRole } from "../server/resolve-owner-business";

// Kept out of actions.ts (a "use server" module may only export async
// functions) - same reason src/features/businesses/settings/roles.ts and
// src/features/customers/roles.ts are their own files.

/**
 * Doc 01 matrix, "Staff" section: viewing the roster at all is owner and
 * manager only - marketing and staff have no roster-view grant, so
 * `/business/staff` itself is gated on this pair, same shape as
 * `BUSINESS_SETTINGS_ROLES`. Doc 32 section 7.1 states the same conclusion in
 * prose ("marketing/staff see the roster read-only? - no: matrix has no
 * roster-view grant... so /business/staff is owner+manager only").
 *
 * There is no RLS mirror to cite here the way settings.ts cites
 * `businesses_staff_update`: `business_staff` (0002) ships with NO client
 * write policy at all ("writes service-role only for now (invites/role
 * changes ship with the staff module)" - this module). Every write in
 * server/service.ts goes through a service-role client for that reason, and
 * this role gate is therefore the ONLY server-side fence on who may invite,
 * revoke or change a role - not a second layer behind RLS, as it is on
 * settings and customers. See server/service.ts's header.
 */
export const STAFF_ROSTER_ROLES: readonly BusinessRole[] = ["owner", "manager"];

/**
 * Doc 01 matrix, "Invite/remove staff": owner invites/removes any role;
 * manager is 🟡² - "Manager can invite `staff` role only, [V1]". This is the
 * SECOND gate an invite passes (the first is `STAFF_ROSTER_ROLES` above,
 * which only says "may reach this screen at all") - a manager reaches
 * `/business/staff` and can invite, but only ever a `staff` row, never a
 * `manager` or `marketing` one.
 *
 * DECISION (brief: "state what you chose"): the same restriction is applied
 * to REVOKING a pending invite, by symmetry - the matrix's "remove" half of
 * the same 🟡² row has no separate footnote, and the reading that a manager
 * could invite only `staff` but revoke ANY pending invite (including one a
 * fellow manager or the owner sent) would let a manager erase an invite they
 * had no power to create, which is a strictly larger grant than "invite
 * `staff` only" for no stated reason. Symmetric is the narrower, safer
 * reading and it is what's implemented.
 *
 * `owner` NEVER appears on the right-hand side of this map, for either actor:
 * doc 32 section 7.1 ("owner role is not assignable here; ownership transfer
 * is an atomic swap [V1] in settings") - inviting or promoting someone TO
 * owner is out of scope for this module entirely.
 */
const INVITABLE_ROLES: Record<BusinessRole, readonly BusinessRole[]> = {
  owner: ["manager", "marketing", "staff"],
  manager: ["staff"],
  marketing: [],
  staff: [],
};

export function rolesInvitableBy(actorRole: BusinessRole): readonly BusinessRole[] {
  return INVITABLE_ROLES[actorRole];
}

export function canActOnRole(actorRole: BusinessRole, targetRole: BusinessRole): boolean {
  return INVITABLE_ROLES[actorRole].includes(targetRole);
}

/**
 * Doc 01 matrix, "Change staff roles": owner only, no 🟡 for manager at all.
 * Doc 32 section 7.1's role-change bullet is owner-only for the same reason,
 * and explicitly excludes the owner role itself as a target (see above) - the
 * one member a role-change action here can never touch is the row whose role
 * already IS 'owner'.
 */
export const ROLE_CHANGE_ROLES: readonly BusinessRole[] = ["owner"];
