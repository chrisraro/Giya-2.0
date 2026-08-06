import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";

// ===========================================================================
// The one place that knows the shape of a campaign lifecycle `audit_logs`
// row and the `campaign.<transition>` verb vocabulary (doc 25's
// `campaign.activated` example, doc 34 section 10's full list:
// `campaign.activated` / `campaign.paused` / `campaign.resumed` /
// `campaign.ended` / `campaign.archived`). Two callers share it:
//
//   * ./exhaustion.ts - the system actor's post-commit `campaign.paused` on
//     budget exhaustion (task 1.2), which already has a service-role client
//     handed to it via its own deps (the award pipeline runs with no
//     session).
//   * ./service.ts - every STAFF-INITIATED transition (activate, pause,
//     resume, end, archive), which runs under a session-scoped client and
//     resolves its own service-role client just before calling this (see its
//     own note on why that resolution lives there and not here).
//
// Sharing this module is the point: without it, a second lifecycle audit
// writer would have to reinvent the entity_type, the verb strings and the
// before/after shape, and the two would drift the moment one changed. See
// docs/30-modules/34-campaign-engine.md section 10's registry table.
//
// Deliberately NO dependency on @/lib/supabase/service here: that module
// loads @/lib/env, which throws when Supabase env vars are unset, and
// ./exhaustion.ts (whose tests never configure those vars, since it is
// always handed a client via its own deps) would fail to import this file at
// all if it pulled that in transitively. Resolving a service-role client is
// each caller's own concern; this module only ever writes through one it is
// given.
// ===========================================================================

export const AUDIT_ENTITY_TYPE = "campaign";

/** Doc 34 section 10's registry, restated as code so no caller can typo a
 * verb into a parallel string that never matches the doc's registered set. */
export const CAMPAIGN_LIFECYCLE_ACTIONS = {
  activate: "campaign.activated",
  pause: "campaign.paused",
  resume: "campaign.resumed",
  end: "campaign.ended",
  archive: "campaign.archived",
} as const;

export type CampaignLifecycleTransition = keyof typeof CAMPAIGN_LIFECYCLE_ACTIONS;

export interface CampaignLifecycleAuditRow {
  businessId: string;
  campaignId: string;
  /** One of CAMPAIGN_LIFECYCLE_ACTIONS's values; typed as `string` (not the
   * union) so exhaustion.ts's system pause - which is not itself a
   * CampaignLifecycleTransition value on the actor's action set but the
   * same `campaign.paused` verb - can share this writer too. */
  action: string;
  actorKind: "user" | "system";
  /** null for the system actor (0022/0012's documented meaning of
   * "system/worker"); the acting profile id for a staff-initiated one. */
  actorId: string | null;
  /** business_staff.role AT THE TIME OF THE ACTION (0022's denormalized
   * snapshot column) - null for the system actor, which has none. */
  actorRole: string | null;
  before: Json;
  after: Json;
  reason: string | null;
}

/**
 * Low-level writer: takes an ALREADY-RESOLVED SERVICE ROLE client. 0022
 * revokes `audit_logs` INSERT from every client role and keeps it for
 * `service_role` alone, so there is no session-scoped path to this table.
 *
 * NEVER THROWS. The state transition this records has already committed by
 * the time either caller reaches this function (see each caller's own
 * ordering note), so a failed insert is logged and swallowed rather than
 * surfaced as an exception - an unaudited transition (logged loudly) is a
 * smaller loss than one this function pretends never happened by throwing
 * mid-request. Same reasoning as ./exhaustion.ts's original inline writer,
 * which this replaces.
 */
export async function writeCampaignLifecycleAuditRow(
  supabase: SupabaseClient<Database>,
  row: CampaignLifecycleAuditRow,
): Promise<void> {
  const { error } = await supabase.from("audit_logs").insert({
    actor_id: row.actorId,
    actor_kind: row.actorKind,
    actor_role: row.actorRole,
    business_id: row.businessId,
    action: row.action,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: row.campaignId,
    before: row.before,
    after: row.after,
    reason: row.reason,
  });

  if (error !== null) {
    console.error(
      `[campaigns/audit] could not write the audit row for campaign ${row.campaignId}'s ${row.action}`,
      error,
    );
  }
}
