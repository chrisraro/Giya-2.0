"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

import { cancelClaimInputSchema, claimRewardInputSchema } from "./schemas";
import { assertClaimOwner } from "./server/claim-ownership";
import * as repo from "./server/repo";
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

/**
 * Poll-fallback status read for the redemption QR screen
 * (src/features/rewards/components/redemption-qr.tsx): when the Supabase
 * Realtime subscription on the claim row fails to connect (or never fires),
 * the client falls back to calling this every few seconds instead. Applies
 * the exact same ownership rule as the token-mint route (doc 35 s12: the
 * claim owner only) - repo.getClaim's RLS is a UNION of the consumer-self
 * and staff-of-business policies, so a staff member's session could
 * otherwise poll a customer's claim status too. Returns null for "no
 * session", "claim not found", or "not the owner" alike, matching doc 13's
 * never-distinguish-absent-from-outside-scope rule; the QR screen treats a
 * null result as "keep waiting", not an error.
 */
export async function getClaimStatus(claimId: string): Promise<{ status: string } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  let claim;
  try {
    claim = await repo.getClaim(claimId);
  } catch {
    return null;
  }
  if (!claim || !assertClaimOwner(claim, user.id)) return null;

  return { status: claim.status };
}

/**
 * Cancels the signed-in consumer's own unredeemed claim (0050 cancel_claim
 * RPC) and gets their points back immediately - doc 03 Key Finding 1's top
 * complaint driver: "points debited on intent and never returned". On
 * success, revalidates /rewards and /wallet (mirrors claimReward - the
 * catalog's remaining stock and the wallet's restored balance both change),
 * plus the claim's own detail route so a consumer who cancels from there
 * sees the claim's new state on refresh rather than a stale one.
 */
export async function cancelClaim(
  input: unknown,
): Promise<ActionResult<{ claimId: string }>> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NOT_SIGNED_IN;

  const parsed = cancelClaimInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: firstIssueMessage(parsed.error) };
  }

  const result = await service.cancelClaim(parsed.data.claimId);
  if (result.ok) {
    revalidatePath("/rewards");
    revalidatePath("/wallet");
    revalidatePath(`/rewards/claims/${parsed.data.claimId}`);
  }
  return result;
}
