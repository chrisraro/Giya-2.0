"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";

import { REWARD_CATALOG_ROLES } from "./roles";
import { createRewardSchema, setRewardActiveSchema, updateRewardSchema } from "./schemas";
import * as service from "./server/service";
import type { ActionResult, RewardRow } from "./types";

// Session check -> tenancy+role resolution -> Zod -> service -> revalidate,
// exactly the order src/features/campaigns/actions.ts uses. The business id is
// never taken from the input: it comes from `resolveStaffContext`, which reads
// `business_staff` under the caller's own session.

const REWARDS_PATH = "/business/rewards";

const NOT_ALLOWED: ActionResult<never> = {
  ok: false,
  message: "You do not have permission to manage rewards for this business.",
};

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

async function requireCatalogBusiness(): Promise<
  { ok: true; businessId: string } | { ok: false; result: ActionResult<never> }
> {
  const context = await resolveStaffContext(REWARD_CATALOG_ROLES);
  if (!context) return { ok: false, result: NOT_ALLOWED };
  return { ok: true, businessId: context.businessId };
}

export async function createReward(input: unknown): Promise<ActionResult<RewardRow>> {
  const auth = await requireCatalogBusiness();
  if (!auth.ok) return auth.result;

  const parsed = createRewardSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.createReward(auth.businessId, parsed.data);
  if (result.ok) revalidatePath(REWARDS_PATH);
  return result;
}

export async function updateReward(input: unknown): Promise<ActionResult<RewardRow>> {
  const auth = await requireCatalogBusiness();
  if (!auth.ok) return auth.result;

  const parsed = updateRewardSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.updateReward(auth.businessId, parsed.data);
  if (result.ok) revalidatePath(REWARDS_PATH);
  return result;
}

export async function setRewardActive(input: unknown): Promise<ActionResult<RewardRow>> {
  const auth = await requireCatalogBusiness();
  if (!auth.ok) return auth.result;

  const parsed = setRewardActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.setRewardActive(
    auth.businessId,
    parsed.data.rewardId,
    parsed.data.isActive,
  );
  if (result.ok) revalidatePath(REWARDS_PATH);
  return result;
}
