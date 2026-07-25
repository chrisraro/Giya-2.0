"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

import {
  baseRuleSchema,
  createLoyaltyCampaignSchema,
  createPromotionCampaignSchema,
  createRewardCampaignSchema,
  idSchema,
} from "./schemas";
import * as repo from "./server/repo";
import * as service from "./server/service";
import type { ActionResult, CampaignRow, PointsRuleRow } from "./server/types";

const CAMPAIGNS_PATH = "/business/campaigns";

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
 */
async function requireOwnerBusiness(): Promise<
  { ok: true; businessId: string } | { ok: false; result: ActionResult<never> }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, result: NOT_SIGNED_IN };
  }

  const business = await repo.resolveOwnerBusiness();
  if (!business) {
    return { ok: false, result: NO_BUSINESS };
  }

  return { ok: true, businessId: business.id };
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

  const result = await service.activateCampaign(auth.businessId, parsed.data.campaignId);
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

  const result = await service.pauseCampaign(auth.businessId, parsed.data.campaignId);
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

  const result = await service.archiveCampaign(auth.businessId, parsed.data.campaignId);
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

  const result = await service.resumeCampaign(auth.businessId, parsed.data.campaignId);
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

  const result = await service.endCampaign(auth.businessId, parsed.data.campaignId);
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
  if (result.ok) revalidatePath(CAMPAIGNS_PATH);
  return result;
}
