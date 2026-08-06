import type { BusinessRole } from "../server/resolve-owner-business";

// DTOs for the staff module (`/business/staff`, `/invite/[token]`, doc 32
// section 7.1). Same local `ActionResult<T>` shape every other feature slice
// (customers/types.ts, businesses/settings/types.ts) defines for itself
// rather than sharing one - see those files for why: each slice's `code` is
// its own small vocabulary.

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; message: string; code?: StaffErrorCode };

/**
 * Doc 30 section "Error codes" plus doc 32's module-local registry, restated
 * as a type so a typo'd code is a compile error rather than a silent drift
 * between what this module returns and what the docs promise:
 *   - INVITE_INVALID   consumed, unknown, or revoked token (422)
 *   - INVITE_EXPIRED   `invite_expires_at` has passed (422)
 *   - INVITE_DUPLICATE inviting an existing active/invited member (409)
 *   - OWNER_REQUIRED   any action that would leave zero owners (409)
 * `WRONG_ACCOUNT` is NOT in either doc's registry - it is this module's own
 * name for the case the brief calls out by name (accepting while signed in
 * as a different account than the invite names) and doc 30/32 do not
 * register a code for. See server/service.ts's `acceptInvite` for the
 * decision.
 */
export type StaffErrorCode =
  | "INVITE_INVALID"
  | "INVITE_EXPIRED"
  | "INVITE_DUPLICATE"
  | "OWNER_REQUIRED"
  | "WRONG_ACCOUNT"
  | "SIGN_IN_REQUIRED"
  | "NOT_ALLOWED";

export const STAFF_STATUSES = ["invited", "active", "disabled"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** One roster row - a mix of active members and pending invites, doc 32
 * section 7.1's single list ("Roster: business_staff rows"). */
export interface StaffRosterItem {
  id: string;
  role: BusinessRole;
  status: StaffStatus;
  /** Null for a member who accepted (or was created directly, e.g. the
   * founding owner via `register_business`); set for a pending or
   * once-pending invite. */
  invitedEmail: string | null;
  createdAt: string;
}
