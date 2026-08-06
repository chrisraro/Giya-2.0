import {
  activationGates,
  CampaignTransitionError,
  nextStatus,
} from "../lifecycle";
import type { Campaign, CampaignBudget, CampaignStatus, CampaignType } from "../types";
import type {
  BaseRuleInput,
  CreateLoyaltyCampaignInput,
  CreatePromotionCampaignInput,
  CreateRewardCampaignInput,
} from "../schemas";
import type { ActionResult, CampaignRow, LifecycleActor, PointsRuleRow } from "./types";
import * as repo from "./repo";
import {
  CAMPAIGN_LIFECYCLE_ACTIONS,
  writeCampaignLifecycleAuditRow,
  type CampaignLifecycleTransition,
} from "./audit";
import { createServiceRoleClient } from "@/lib/supabase/service";

// Thin orchestration over repo.ts: translate the repo's { data, error }
// shape into the { ok } | { ok: false, message, code? } contract actions.ts
// hands back to the UI, and run the pure lifecycle engine
// (../lifecycle.ts:activationGates/canTransition/nextStatus) against data
// this layer loads. NO points_transactions writes happen here - awarding
// points is the receipts slice's job; this slice only manages campaign
// configuration and lifecycle state.

/**
 * Notifies downstream consumers that a campaign's lifecycle state changed.
 * Today this is just a log line; it is the seam a future analytics/sweep
 * job hangs off of once it exists.
 */
export function emitLifecycleEvent(
  businessId: string,
  campaignId: string,
  action: string,
): void {
  console.info(`[campaigns] campaign.lifecycle business=${businessId} campaign=${campaignId} action=${action}`);
  // TODO(api): wire analytics + the ends_at sweep worker (doc 39)
}

// exactOptionalPropertyTypes is on for this project, so `{ code: maybeUndefined }`
// is a type error even though `code` is optional on ActionResult - the key
// must be omitted entirely rather than set to `undefined`. This helper (and
// `okResult` below) is the one place that builds the failure/success shape,
// so every call site can pass a possibly-undefined code/data without
// tripping that rule.
function failResult<T>(message: string, code?: string): ActionResult<T> {
  return code !== undefined ? { ok: false, message, code } : { ok: false, message };
}

function okResult<T>(data: T | null): ActionResult<T> {
  return data === null ? { ok: true } : { ok: true, data };
}

function toResult<T>(
  data: T | null,
  error: { message: string; code?: string } | null,
): ActionResult<T> {
  if (error) return failResult(error.message, error.code);
  return okResult(data);
}

export async function createPromotionCampaign(
  businessId: string,
  input: CreatePromotionCampaignInput,
): Promise<ActionResult<CampaignRow>> {
  const { data, error } = await repo.createPromotionCampaignWithPayload(businessId, input);
  return toResult(data, error);
}

export async function createRewardCampaign(
  businessId: string,
  input: CreateRewardCampaignInput,
): Promise<ActionResult<CampaignRow>> {
  const { data, error } = await repo.createRewardCampaignWithPayload(businessId, input);
  return toResult(data, error);
}

export async function createLoyaltyCampaign(
  businessId: string,
  input: CreateLoyaltyCampaignInput,
): Promise<ActionResult<CampaignRow>> {
  const { data, error } = await repo.createLoyaltyCampaignWithPayload(businessId, input);
  return toResult(data, error);
}

function toEngineCampaign(row: CampaignRow, evaluatedStatus: CampaignStatus): Campaign {
  return {
    id: row.id,
    type: row.type as CampaignType,
    status: evaluatedStatus,
    startsAt: row.starts_at ? new Date(row.starts_at) : null,
    endsAt: row.ends_at ? new Date(row.ends_at) : null,
    timezone: row.timezone,
    budget: (row.budget ?? {}) as CampaignBudget,
  };
}

/**
 * Writes the `audit_logs` row for a staff-initiated lifecycle transition
 * (task 1.7; doc 34 section 10's `campaign.<transition>` registry). Resolves
 * its own service-role client - 0022 revokes `audit_logs` INSERT from every
 * client role, and repo.ts's session-scoped client (the one every other
 * function in this file reads/writes campaigns through) cannot write it -
 * exactly the way src/features/customers/server/audit.ts's
 * recordSegmentChange resolves its own.
 *
 * BEST-EFFORT, NOT A GATE: called only AFTER repo.setCampaignStatus has
 * already returned success, and never rolls that transition back or turns
 * the caller's ActionResult into a failure if the write itself fails
 * (missing service-role key, or a genuine insert error) - audit is evidence
 * of a transition that happened, not a precondition for letting it happen.
 * Both failure modes are logged loudly so a missing/incomplete trail is
 * never silent. Same contract as ./exhaustion.ts's system-actor pause, which
 * shares ./audit.ts's row writer with this function so the two paths can
 * never drift into different shapes for the same `campaign.paused` verb.
 */
async function writeLifecycleAuditRow(
  businessId: string,
  campaignId: string,
  transition: CampaignLifecycleTransition,
  actor: LifecycleActor,
  fromStatus: CampaignStatus,
  toStatus: CampaignStatus,
): Promise<void> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.warn(
      `[campaigns] no service-role key: campaign ${campaignId}'s ${transition} was applied but not audited`,
    );
    return;
  }

  await writeCampaignLifecycleAuditRow(supabase, {
    businessId,
    campaignId,
    action: CAMPAIGN_LIFECYCLE_ACTIONS[transition],
    actorKind: "user",
    actorId: actor.userId,
    actorRole: actor.role,
    before: { status: fromStatus },
    after: { status: toStatus },
    reason: null,
  });
}

/**
 * Activates a campaign (draft -> active or scheduled -> active; doc 34 T2/T3).
 *
 * CALLER-CONTRACT for activationGates (per review): G3's "a scheduled
 * campaign requires startsAt" check keys off the *evaluated* status passed
 * in, not the row's current status. Since this action always targets
 * 'active' (there is no separate "schedule for later" action in this
 * slice), the Campaign shape built for the gate always carries
 * `status: 'active'` - never the row's actual draft/scheduled status. That
 * is what lets a draft campaign with no startsAt activate immediately
 * without G3 wrongly demanding one (it would, if we evaluated with
 * status: 'scheduled' or the row's own 'draft'/'scheduled' value). A future
 * "schedule for later" action would instead evaluate with
 * `status: 'scheduled'` so G3's startsAt-required check applies.
 */
export async function activateCampaign(
  businessId: string,
  campaignId: string,
  actor: LifecycleActor,
): Promise<ActionResult<CampaignRow>> {
  const row = await repo.getCampaignRow(businessId, campaignId);
  if (!row) return { ok: false, message: "Campaign not found." };

  const business = await repo.getBusinessStatus(businessId);
  if (!business) return { ok: false, message: "Business not found." };

  const presence = await repo.getCampaignPayloadPresence(businessId, campaignId);
  const evaluatedCampaign = toEngineCampaign(row, "active");

  const gateResult = activationGates(evaluatedCampaign, presence, business, new Date());
  if (!gateResult.ok) {
    const first = gateResult.failures[0];
    if (first) return failResult(first.message, first.code);
    return failResult("Campaign is not ready to activate.");
  }

  const fromStatus = row.status as CampaignStatus;
  let target: CampaignStatus;
  try {
    target = nextStatus({ status: fromStatus }, "activate");
  } catch (err) {
    if (err instanceof CampaignTransitionError) {
      return failResult(err.message, err.code);
    }
    throw err;
  }

  const patch: { status: CampaignStatus; starts_at?: string } = { status: target };
  if (row.starts_at === null) {
    patch.starts_at = new Date().toISOString();
  }

  const { data, error } = await repo.setCampaignStatus(businessId, campaignId, fromStatus, patch);
  if (error) return failResult(error.message, error.code);

  await writeLifecycleAuditRow(businessId, campaignId, "activate", actor, fromStatus, target);
  emitLifecycleEvent(businessId, campaignId, "activate");
  return okResult(data);
}

async function transitionCampaign(
  businessId: string,
  campaignId: string,
  action: "pause" | "end" | "archive",
  actor: LifecycleActor,
): Promise<ActionResult<CampaignRow>> {
  const row = await repo.getCampaignRow(businessId, campaignId);
  if (!row) return { ok: false, message: "Campaign not found." };

  const expectedFrom = row.status as CampaignStatus;

  let target: CampaignStatus;
  try {
    target = nextStatus({ status: expectedFrom }, action);
  } catch (err) {
    if (err instanceof CampaignTransitionError) {
      return failResult(err.message, err.code);
    }
    throw err;
  }

  const patch: { status: CampaignStatus; archived_at?: string } = { status: target };
  if (target === "archived") {
    patch.archived_at = new Date().toISOString();
  }

  const { data, error } = await repo.setCampaignStatus(businessId, campaignId, expectedFrom, patch);
  if (error) return failResult(error.message, error.code);

  await writeLifecycleAuditRow(businessId, campaignId, action, actor, expectedFrom, target);
  emitLifecycleEvent(businessId, campaignId, action);
  return okResult(data);
}

export async function pauseCampaign(
  businessId: string,
  campaignId: string,
  actor: LifecycleActor,
): Promise<ActionResult<CampaignRow>> {
  return transitionCampaign(businessId, campaignId, "pause", actor);
}

export async function archiveCampaign(
  businessId: string,
  campaignId: string,
  actor: LifecycleActor,
): Promise<ActionResult<CampaignRow>> {
  return transitionCampaign(businessId, campaignId, "archive", actor);
}

/**
 * Resumes a paused campaign (paused -> active; doc 34 T6).
 *
 * Review fix (task 1.7, doc 34 T6): a previously-validated campaign does NOT
 * skip activationGates on resume. The original reasoning ("it already
 * cleared the gates once to activate") ignored that time passes while a
 * campaign sits paused - its business can lose active status, and its
 * `ends_at` can pass - so re-running G1-G4 here is what stops a paused
 * campaign from resuming into a live state it could never reach via
 * activateCampaign. Same CALLER-CONTRACT as activateCampaign: this action's
 * only target is 'active', so the Campaign shape passed to the gate always
 * carries `status: 'active'`, never the row's actual 'paused'.
 *
 * ORDER: the transition-validity check (nextStatus) runs BEFORE the gates,
 * not after as in activateCampaign. A campaign that isn't even paused isn't
 * "resuming" at all, so there is no reason to load its business/payload just
 * to report a gate failure instead of the more useful CAMPAIGN_INVALID_STATE.
 */
export async function resumeCampaign(
  businessId: string,
  campaignId: string,
  actor: LifecycleActor,
): Promise<ActionResult<CampaignRow>> {
  const row = await repo.getCampaignRow(businessId, campaignId);
  if (!row) return { ok: false, message: "Campaign not found." };

  const expectedFrom = row.status as CampaignStatus;

  let target: CampaignStatus;
  try {
    target = nextStatus({ status: expectedFrom }, "resume");
  } catch (err) {
    if (err instanceof CampaignTransitionError) {
      return failResult(err.message, err.code);
    }
    throw err;
  }

  const business = await repo.getBusinessStatus(businessId);
  if (!business) return { ok: false, message: "Business not found." };

  const presence = await repo.getCampaignPayloadPresence(businessId, campaignId);
  const evaluatedCampaign = toEngineCampaign(row, "active");

  const gateResult = activationGates(evaluatedCampaign, presence, business, new Date());
  if (!gateResult.ok) {
    const first = gateResult.failures[0];
    if (first) return failResult(first.message, first.code);
    return failResult("Campaign is not ready to resume.");
  }

  const { data, error } = await repo.setCampaignStatus(businessId, campaignId, expectedFrom, {
    status: target,
  });
  if (error) return failResult(error.message, error.code);

  await writeLifecycleAuditRow(businessId, campaignId, "resume", actor, expectedFrom, target);
  emitLifecycleEvent(businessId, campaignId, "resume");
  return okResult(data);
}

/**
 * Ends a running campaign (active|paused -> ended; doc 34 T7). This is the
 * only path off active/paused besides pausing/resuming each other - without
 * it, `ended` and `archived` (which requires `ended` or `draft`, per the
 * doc 34 edge set) are unreachable from the portal for any campaign that
 * ever activated. Ending is one-way: doc 34 has no `ended -> active` edge,
 * so relaunching the same offer means duplicating it into a new draft
 * (T9), not resuming this row.
 */
export async function endCampaign(
  businessId: string,
  campaignId: string,
  actor: LifecycleActor,
): Promise<ActionResult<CampaignRow>> {
  return transitionCampaign(businessId, campaignId, "end", actor);
}

export async function upsertBaseRule(
  businessId: string,
  input: BaseRuleInput,
): Promise<ActionResult<PointsRuleRow>> {
  const { data, error } = await repo.upsertBaseRule(businessId, input);
  return toResult(data, error);
}
