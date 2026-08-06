import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";

// ===========================================================================
// The one place that knows the shape of a `business_staff` mutation's
// `audit_logs` row and the `staff.<verb>` vocabulary. Same split
// src/features/campaigns/server/audit.ts documents: a low-level, never-throws
// writer here, callers (service.ts) decide what to do with a failure.
//
// `staff.role_changed` is doc 25's OWN example verb for this table
// (0022_audit_logs.sql's header cites it verbatim next to
// `campaign.activated`), so this module is completing a name the schema
// already reserved rather than inventing one.
//
// WHY SERVICE ROLE. Same reasoning as campaigns/audit.ts and
// customers/server/audit.ts: 0022 revokes every client write on `audit_logs`
// and keeps INSERT for `service_role` alone. Doubly true here because
// `business_staff` ITSELF has no client write policy either (0002) - service.ts
// is already holding a service-role client for the row mutation by the time it
// calls this, so passing that SAME client through (rather than resolving a
// second one) is what keeps the write and its audit row from being able to
// disagree about which credential wrote them.
// ===========================================================================

export const AUDIT_ENTITY_TYPE = "business_staff";

/** The `staff.<verb>` registry. Compile-time-checked so a typo'd verb can
 * never diverge from what a reader querying `action like 'staff.%'` expects. */
export const STAFF_AUDIT_ACTIONS = {
  invited: "staff.invited",
  invite_revoked: "staff.invite_revoked",
  invite_accepted: "staff.invite_accepted",
  role_changed: "staff.role_changed",
} as const;

export type StaffAuditVerb = keyof typeof STAFF_AUDIT_ACTIONS;

export interface StaffAuditRow {
  businessId: string;
  staffId: string;
  action: (typeof STAFF_AUDIT_ACTIONS)[StaffAuditVerb];
  /** The signed-in owner/manager who made the change. Never null: unlike
   * campaigns/exhaustion.ts's system actor, nothing in this module runs
   * outside a staff-initiated request. */
  actorId: string;
  actorRole: string;
  before: Json;
  after: Json;
  reason: string | null;
  requestId: string | null;
}

export type AuditWriteOutcome = { ok: true } | { ok: false; message: string };

/**
 * Low-level writer: takes an ALREADY-RESOLVED SERVICE ROLE client, exactly
 * like `writeCampaignLifecycleAuditRow`. NEVER THROWS - failure is a returned
 * `{ok: false}`, and it is service.ts's job (not this module's) to decide
 * whether that failure reverts the row it describes. See service.ts's header
 * for why THIS module's callers choose "revert", unlike campaigns'/
 * customers' "best effort, report and move on".
 */
export async function writeStaffAuditRow(
  supabase: SupabaseClient<Database>,
  row: StaffAuditRow,
): Promise<AuditWriteOutcome> {
  const { error } = await supabase.from("audit_logs").insert({
    actor_id: row.actorId,
    actor_kind: "user",
    actor_role: row.actorRole,
    business_id: row.businessId,
    action: row.action,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: row.staffId,
    before: row.before,
    after: row.after,
    reason: row.reason,
    request_id: row.requestId,
  });

  if (error !== null) {
    console.error(
      `[businesses/staff/audit] could not write the audit row for business_staff ${row.staffId}'s ${row.action}`,
      error,
    );
    return { ok: false, message: error.message };
  }

  return { ok: true };
}
