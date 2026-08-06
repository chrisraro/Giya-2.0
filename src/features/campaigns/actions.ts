"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { BUSINESS_ROLES, resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";

import {
  baseRuleSchema,
  createLoyaltyCampaignSchema,
  createPromotionCampaignSchema,
  createRewardCampaignSchema,
  idSchema,
} from "./schemas";
import * as service from "./server/service";
import type { ActionResult, CampaignRow, PointsRuleRow } from "./server/types";

const CAMPAIGNS_PATH = "/business/campaigns";
/**
 * The base earning rule is now read on TWO screens, not one: the campaigns page
 * that has always owned the editor, and the dashboard's go-live checklist,
 * which embeds the same editor because that rule is the single precondition of
 * activation (migration 0033). Revalidating only the campaigns path would leave
 * a merchant who just set their rule from the dashboard looking at a checklist
 * that still says they have not.
 */
const DASHBOARD_PATH = "/business/dashboard";

const NOT_SIGNED_IN: ActionResult<never> = {
  ok: false,
  message: "You need to be signed in to do that.",
};

const NO_BUSINESS: ActionResult<never> = {
  ok: false,
  message: "No active business membership was found for your account.",
};

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

/**
 * Confirms the caller has a session and resolves their business server-side
 * (never trusting a business id supplied by the client). Every action below
 * calls this first; the business id it returns is the only one used in
 * subsequent repo/service calls. Same pattern as
 * src/features/menu/actions.ts's requireOwnerBusiness.
 *
 * ALSO returns `actor` (the caller's profile id + business_staff.role), via
 * `resolveStaffContext` with the full `BUSINESS_ROLES` list - i.e. still "any
 * active member", identical gating to the old `resolveOwnerBusiness` call
 * this replaces, just with the role read out at the same time. The lifecycle
 * actions (activate/pause/resume/end/archive) need it to write a real
 * actor_id/actor_role on their `audit_logs` row (task 1.7) instead of a null
 * "system" one; every other action ignores the field.
 */
async function requireOwnerBusiness(): Promise<
  | { ok: true; businessId: string; actor: { userId: string; role: string } }
  | { ok: false; result: ActionResult<never> }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, result: NOT_SIGNED_IN };
  }

  const staff = await resolveStaffContext(BUSINESS_ROLES);
  if (!staff) {
    return { ok: false, result: NO_BUSINESS };
  }

  return { ok: true, businessId: staff.businessId, actor: { userId: staff.userId, role: staff.role } };
}

const campaignIdInputSchema = z.object({ campaignId: idSchema });

// -------------------------------------------------------------- campaigns

export async function createPromotionCampaign(
  input: unknown,
): Promise<ActionResult<CampaignRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = createPromotionCampaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.createPromotionCampaign(auth.businessId, parsed.data);
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}

export async function createRewardCampaign(
  input: unknown,
): Promise<ActionResult<CampaignRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = createRewardCampaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.createRewardCampaign(auth.businessId, parsed.data);
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}

export async function createLoyaltyCampaign(
  input: unknown,
): Promise<ActionResult<CampaignRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = createLoyaltyCampaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.createLoyaltyCampaign(auth.businessId, parsed.data);
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}

export async function activateCampaign(input: {
  campaignId: string;
}): Promise<ActionResult<CampaignRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = campaignIdInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.activateCampaign(auth.businessId, parsed.data.campaignId, auth.actor);
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}

export async function pauseCampaign(input: {
  campaignId: string;
}): Promise<ActionResult<CampaignRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = campaignIdInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.pauseCampaign(auth.businessId, parsed.data.campaignId, auth.actor);
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}

export async function archiveCampaign(input: {
  campaignId: string;
}): Promise<ActionResult<CampaignRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = campaignIdInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.archiveCampaign(auth.businessId, parsed.data.campaignId, auth.actor);
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}

export async function resumeCampaign(input: {
  campaignId: string;
}): Promise<ActionResult<CampaignRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = campaignIdInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.resumeCampaign(auth.businessId, parsed.data.campaignId, auth.actor);
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}

export async function endCampaign(input: {
  campaignId: string;
}): Promise<ActionResult<CampaignRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = campaignIdInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.endCampaign(auth.businessId, parsed.data.campaignId, auth.actor);
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}

// ---------------------------------------------------------------- points

export async function upsertBaseRule(input: unknown): Promise<ActionResult<PointsRuleRow>> {
  const auth = await requireOwnerBusiness();
  if (!auth.ok) return auth.result;

  const parsed = baseRuleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.upsertBaseRule(auth.businessId, parsed.data);
  if (result.ok) {
    revalidatePath(CAMPAIGNS_PATH);
    revalidatePath(DASHBOARD_PATH);
  }
  return result;
}
