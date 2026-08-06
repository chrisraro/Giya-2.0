import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/types";

// ===========================================================================
// The one place that knows the shape of a campaign lifecycle `audit_logs`
// row and the `campaign.<transition>` verb vocabulary. The REQUIREMENT is
// doc 34 section 2 line 23 ("write an `audit_logs` row (`action` =
// `campaign.<transition>`)") plus doc 25's `campaign.activated` example and
// 0022's action-shape constraint - NOT doc 34 section 10, which review
// caught this file misciting: section 10 is the *analytics event*
// taxonomy, a different sink entirely, and it lists `campaign.created` /
// `campaign.updated` alongside the five below even though those two are
// correctly NOT audit verbs (no lifecycle lands on either). Citing section
// 10 as "the registry" told a reader two verbs were missing that were never
// meant to exist here.
//
// Two callers share this module:
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
// before/after shape, and the two would drift the moment one changed.
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

/** Doc 34 section 2 line 23's `campaign.<transition>` requirement, restated
 * as code so no caller can typo a verb into a parallel string that never
 * matches the registered set. */
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
  /** Typed as the REGISTRY'S OWN value union (not `string`) so a typo'd verb
   * is a compile error, not a silent drift caught only by reading rows back.
   * Both callers already pass a registry value: exhaustion.ts passes
   * `CAMPAIGN_LIFECYCLE_ACTIONS.pause` directly, and service.ts passes
   * `CAMPAIGN_LIFECYCLE_ACTIONS[transition]` for whichever transition it is
   * running - neither ever had a reason to pass an arbitrary string. */
  action: (typeof CAMPAIGN_LIFECYCLE_ACTIONS)[CampaignLifecycleTransition];
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
  /** Correlates this row with the request log line (doc 25), the same field
   * `admin/consequences.ts` and `receipts/server/alias.ts` populate. null
   * for the system actor's post-commit pause, which runs outside any single
   * inbound request. */
  requestId: string | null;
}

export type AuditWriteOutcome = { ok: true } | { ok: false; message: string };

/**
 * Low-level writer: takes an ALREADY-RESOLVED SERVICE ROLE client. 0022
 * revokes `audit_logs` INSERT from every client role and keeps it for
 * `service_role` alone, so there is no session-scoped path to this table.
 *
 * NEVER THROWS - a failed insert is logged and returned as `{ ok: false }`
 * rather than surfaced as an exception, so a caller that cannot afford to
 * lose the failure (service.ts, since I1) can still act on it without this
 * writer itself needing to know what "acting on it" means for either caller.
 * A caller that treats the write as pure best-effort (exhaustion.ts) is free
 * to discard the resolved value, exactly as it did when this returned void.
 */
export async function writeCampaignLifecycleAuditRow(
  supabase: SupabaseClient<Database>,
  row: CampaignLifecycleAuditRow,
): Promise<AuditWriteOutcome> {
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
    request_id: row.requestId,
  });

  if (error !== null) {
    console.error(
      `[campaigns/audit] could not write the audit row for campaign ${row.campaignId}'s ${row.action}`,
      error,
    );
    return { ok: false, message: error.message };
  }

  return { ok: true };
}
