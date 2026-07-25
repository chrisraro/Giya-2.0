"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

import { claimRewardInputSchema } from "./schemas";
import * as service from "./server/service";
import type { ActionResult } from "./types";

// Matches src/features/campaigns/actions.ts's shape: session check -> Zod
// -> service call -> revalidate on success. Unlike the campaigns actions,
// this feature is consumer-facing, so there is no business-membership
// resolution step - just "is someone signed in".

const NOT_SIGNED_IN: ActionResult<never> = {
  ok: false,
  message: "Please sign in to claim rewards.",
  code: "UNAUTHENTICATED",
};

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

/**
 * Claims a reward for the signed-in consumer. On success, revalidates both
 * /rewards (remaining stock may have changed) and /wallet (the new claim
 * and balance).
 */
export async function claimReward(
  input: unknown,
): Promise<ActionResult<{ claimId: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NOT_SIGNED_IN;

  const parsed = claimRewardInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }

  const result = await service.claimReward(parsed.data.rewardId);
  if (result.ok) {
    revalidatePath("/rewards");
    revalidatePath("/wallet");
  }
  return result;
}
