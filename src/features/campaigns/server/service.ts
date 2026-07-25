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
import type { ActionResult, CampaignRow, PointsRuleRow } from "./types";
import * as repo from "./repo";

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

  let target: CampaignStatus;
  try {
    target = nextStatus({ status: row.status as CampaignStatus }, "activate");
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

  const { data, error } = await repo.setCampaignStatus(businessId, campaignId, patch);
  if (error) return failResult(error.message, error.code);

  emitLifecycleEvent(businessId, campaignId, "activate");
  return okResult(data);
}

async function transitionCampaign(
  businessId: string,
  campaignId: string,
  action: "pause" | "resume" | "end" | "archive",
): Promise<ActionResult<CampaignRow>> {
  const row = await repo.getCampaignRow(businessId, campaignId);
  if (!row) return { ok: false, message: "Campaign not found." };

  let target: CampaignStatus;
  try {
    target = nextStatus({ status: row.status as CampaignStatus }, action);
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

  const { data, error } = await repo.setCampaignStatus(businessId, campaignId, patch);
  if (error) return failResult(error.message, error.code);

  emitLifecycleEvent(businessId, campaignId, action);
  return okResult(data);
}

export async function pauseCampaign(
  businessId: string,
  campaignId: string,
): Promise<ActionResult<CampaignRow>> {
  return transitionCampaign(businessId, campaignId, "pause");
}

export async function archiveCampaign(
  businessId: string,
  campaignId: string,
): Promise<ActionResult<CampaignRow>> {
  return transitionCampaign(businessId, campaignId, "archive");
}

export async function upsertBaseRule(
  businessId: string,
  input: BaseRuleInput,
): Promise<ActionResult<PointsRuleRow>> {
  const { data, error } = await repo.upsertBaseRule(businessId, input);
  return toResult(data, error);
}
