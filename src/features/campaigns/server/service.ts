import {
  activationGates,
  CampaignTransitionError,
  nextStatus,
} from "../lifecycle";
import type {
  Campaign,
  CampaignBudget,
  CampaignStatus,
  CampaignType,
  PayloadPresence,
} from "../types";
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
  type AuditWriteOutcome,
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
 *
 * `requestId` is logged alongside the rest (review round 2, item 4) so this
 * line can be correlated with the request log and with the `audit_logs` row
 * `writeLifecycleAuditRow` writes for the SAME call - same pattern
 * `receipts/server/review.ts`'s `request=${requestId}` suffix uses. null for
 * a caller with no single inbound request to correlate to.
 */
export function emitLifecycleEvent(
  businessId: string,
  campaignId: string,
  action: string,
  requestId: string | null,
): void {
  console.info(
    `[campaigns] campaign.lifecycle business=${businessId} campaign=${campaignId} action=${action} request=${requestId}`,
  );
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
 * G1-G4 (`../lifecycle.ts:activationGates`), shared by `activateCampaign` and
 * `resumeCampaign` (task 1.7 review M6) so the two can never drift back apart
 * the way the original resume skip happened in the first place - resume
 * re-running gates activate already ran was the entire point of this task,
 * so the two call sites now share one implementation rather than two
 * hand-kept-identical copies of it.
 *
 * CALLER-CONTRACT: both callers evaluate with `status: 'active'` (see each
 * one's own note on why) - never the row's actual draft/scheduled/paused
 * status - so this always builds the Campaign shape that way too. Returns
 * `null` when every gate passes; otherwise the `ActionResult` failure the
 * caller should return as-is (first failure only, matching
 * `activationGates`' own "all gates run, failures collected" contract - this
 * layer still only ever surfaces the first).
 */
function runActivationGates(
  row: CampaignRow,
  presence: PayloadPresence,
  business: { status: string },
  now: Date,
): { ok: false; message: string; code?: string } | null {
  const evaluatedCampaign = toEngineCampaign(row, "active");
  const gateResult = activationGates(evaluatedCampaign, presence, business, now);
  if (gateResult.ok) return null;

  // Inlined rather than routed through `failResult` (per exactOptionalPropertyTypes,
  // same reason `failResult` itself omits `code` entirely rather than setting it
  // to `undefined`): `failResult`'s own return type is `ActionResult<T>`, whose
  // `{ ok: true }` branch is not assignable to this function's narrower
  // `{ ok: false } | null` return type no matter what T is instantiated to.
  //
  // `GateResult.ok` is DEFINED as `failures.length === 0` (../lifecycle.ts),
  // so `gateResult.ok === false` on the line above already guarantees
  // `failures[0]` exists - there is no second, fallback-message branch to
  // maintain here. (Review round 2: the prior version hardcoded "...not
  // ready to activate.", which was wrong for the resume caller and
  // unreachable from either - dropped rather than reworded.) The non-null
  // assertion documents that guarantee instead of restating a message that
  // can never be read.
  const first = gateResult.failures[0]!;
  return first.code !== undefined
    ? { ok: false, message: first.message, code: first.code }
    : { ok: false, message: first.message };
}

/**
 * ATOMICITY DEBT (task 1.7 review I2): doc 34 section 2 line 23 says
 * transitions "execute in the service layer inside one DB transaction,
 * write an audit_logs row" - that is the normative target, not what runs
 * today. `repo.setCampaignStatus` and this function are two separate
 * PostgREST statements, not one transaction, for the same structural reason
 * every other multi-statement writer in this codebase is (menu/rewards/
 * loyalty inserts in ./repo.ts, admin/consequences.ts's toggles): a Postgres
 * transaction needs a single round trip, which means a SECURITY DEFINER RPC,
 * and this task's migration sequence is frozen - no RPC ships from here.
 *
 * THE LONG-TERM ANSWER, recorded rather than built: a `set_campaign_status`
 * RPC holding the status update and this audit insert in one transaction,
 * `service_role`-only, with the pgTAP privilege assertions the standing
 * constraints require (anon/authenticated denied, service_role allowed).
 * Doc 34 section 2 line 23 already mandates this normatively; once it ships,
 * `writeLifecycleAuditRow` and the five call sites below collapse into one
 * RPC call and the "surface ok:false, do not revert" policy two paragraphs
 * down becomes moot - the transaction makes an unaudited transition
 * impossible rather than merely reported.
 *
 * GIVEN THAT IT IS NOT ATOMIC, WHAT HAPPENS WHEN THE AUDIT INSERT FAILS?
 * (task 1.7 review I1) Surface `ok: false` to the caller; never revert the
 * status write already committed. The criterion this codebase already states
 * (`receipts/server/review.ts`'s ordering note vs `receipts/server/
 * escalate.ts`'s): abort/report when continuing would mint something
 * unaudited, stay best-effort when nothing is minted and no privilege
 * changes. Activating or resuming a campaign switches on a points-minting
 * rule for every subsequent receipt, which is `review.ts`'s side of that
 * line - and the decisive fact is `campaigns.updated_by` is never written by
 * `repo.setCampaignStatus` (it patches only status/starts_at/archived_at),
 * so a lost audit row would be the ONLY record anywhere of who ran this
 * transition. That is `review.ts`'s "unrecoverable", not `escalate.ts`'s
 * "nothing minted" - hence `ok: false`, matching `src/features/customers/
 * server/audit.ts`'s `recordSegmentChange` convention (state stands, the
 * caller is told plainly that it did, and that the log entry did not).
 *
 * A REVERT (the `admin/consequences.ts` pattern) was considered and
 * rejected - NOT because "nothing reads mid-request" (`consequences.ts`'s
 * own columns are read mid-request too: `profiles.is_suspended` gates every
 * authenticated request and `consumers.scan_blocked_until` gates every scan,
 * both during its own revert window - that argument does not distinguish
 * the two files). Two arguments that do:
 *   (a) `receipts/server/award.ts`'s `loadCampaigns` reads a campaign by id
 *       with NO status predicate and decides liveness engine-side
 *       (`isCampaignLive`, reading status/startsAt/endsAt off the row it
 *       got). A receipt landing inside a write-then-revert window would be
 *       priced against a campaign that both the reverted row AND the
 *       now-absent audit trail say was never active - a self-contradicting
 *       evidence state, strictly worse than "it activated and the log
 *       failed". `consequences.ts`'s toggles mint nothing in their window,
 *       so they have no analogous reader to contradict.
 *   (b) The revert would not be a clean undo here anyway: it would have to
 *       un-stamp `starts_at`/`archived_at` (not just `status`) and would
 *       itself race `repo.setCampaignStatus`'s own optimistic
 *       `.eq("status", expectedFrom)` predicate - a second write competing
 *       with whatever already changed the row in between, exactly the
 *       hazard that predicate exists to catch on the FORWARD path.
 *
 * A MISSING SERVICE-ROLE KEY is the separate, already-documented degraded
 * path (`customers/server/audit.ts`'s same distinction): the credential
 * simply is not deployed yet, which is not evidence anything is wrong with
 * this write, so it does not fail the transition - logged loudly instead.
 */
async function writeLifecycleAuditRow(
  businessId: string,
  campaignId: string,
  transition: CampaignLifecycleTransition,
  actor: LifecycleActor,
  fromStatus: CampaignStatus,
  toStatus: CampaignStatus,
): Promise<AuditWriteOutcome> {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.warn(
      `[campaigns] no service-role key: campaign ${campaignId}'s ${transition} was applied but not audited request=${actor.requestId}`,
    );
    return { ok: true };
  }

  return writeCampaignLifecycleAuditRow(supabase, {
    businessId,
    campaignId,
    action: CAMPAIGN_LIFECYCLE_ACTIONS[transition],
    actorKind: "user",
    actorId: actor.userId,
    actorRole: actor.role,
    before: { status: fromStatus },
    // `trigger: "manual"` (doc 34's transition-row discriminator, task 1.7
    // review M5): every transition through this file is staff-initiated, so
    // it is always "manual" here - "budget"/"sweep"/"admin_policy" belong to
    // ./exhaustion.ts's system actor and a future sweep worker, neither of
    // which calls this function.
    after: { status: toStatus, trigger: "manual" },
    reason: null,
    requestId: actor.requestId,
  });
}

/** The friendly message `activateCampaign`/`transitionCampaign`/
 * `resumeCampaign` return when the state change committed but its audit row
 * did not (I1 above) - same shape as `customers/server/service.ts`'s
 * `changeSegment` ("The segment was changed, but it could not be written to
 * your activity log. Tell the owner."), so the two staff-initiated audit
 * failures in this codebase read as one convention rather than two. */
function auditFailureMessage(transition: CampaignLifecycleTransition): string {
  const verb = CAMPAIGN_LIFECYCLE_ACTIONS[transition].slice("campaign.".length);
  return `The campaign was ${verb}, but it could not be written to your activity log. Tell the owner.`;
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
  const gateFailure = runActivationGates(row, presence, business, new Date());
  if (gateFailure) return gateFailure;

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

  // Emitted BEFORE the audit check (review round 2, item 1): the transition
  // committed on the line above, so the lifecycle event is true regardless
  // of whether the audit row lands - it is a fact about the state change,
  // not about the logging. Emitting after would drop the one remaining
  // record of this transition in exactly the case (an audit failure) where
  // losing it matters most.
  emitLifecycleEvent(businessId, campaignId, "activate", actor.requestId);

  const audit = await writeLifecycleAuditRow(businessId, campaignId, "activate", actor, fromStatus, target);
  if (!audit.ok) return failResult(auditFailureMessage("activate"));

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

  // See activateCampaign's note: emitted before the audit check so a lost
  // audit row never also costs the lifecycle event.
  emitLifecycleEvent(businessId, campaignId, action, actor.requestId);

  const audit = await writeLifecycleAuditRow(businessId, campaignId, action, actor, expectedFrom, target);
  if (!audit.ok) return failResult(auditFailureMessage(action));

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
  const gateFailure = runActivationGates(row, presence, business, new Date());
  if (gateFailure) return gateFailure;

  const { data, error } = await repo.setCampaignStatus(businessId, campaignId, expectedFrom, {
    status: target,
  });
  if (error) return failResult(error.message, error.code);

  // See activateCampaign's note: emitted before the audit check so a lost
  // audit row never also costs the lifecycle event.
  emitLifecycleEvent(businessId, campaignId, "resume", actor.requestId);

  const audit = await writeLifecycleAuditRow(businessId, campaignId, "resume", actor, expectedFrom, target);
  if (!audit.ok) return failResult(auditFailureMessage("resume"));

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
