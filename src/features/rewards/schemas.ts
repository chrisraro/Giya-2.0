import { z } from "zod";

// Zod schemas for the consumer-facing rewards slice: claiming a reward
// (server action input) and validating a redemption (API route body).
// Mirrors src/features/campaigns/schemas.ts's conventions.

export const idSchema = z.string().uuid();

// ------------------------------------------------------------ claim action

export const claimRewardInputSchema = z.object({
  rewardId: idSchema,
});
export type ClaimRewardActionInput = z.infer<typeof claimRewardInputSchema>;

// -------------------------------------------------------- validate route

// supabase/migrations/0013_reward_claim_rpcs.sql's validate_redemption RPC
// accepts p_method in ('qr','manual_code') with a default of 'qr'; the
// schema mirrors that check constraint so an invalid method is rejected
// before it ever reaches the RPC.
export const redemptionMethodSchema = z.enum(["qr", "manual_code"]);
export type RedemptionMethod = z.infer<typeof redemptionMethodSchema>;

export const validateRedemptionBodySchema = z.object({
  token: z.string().min(1, "token is required."),
  method: redemptionMethodSchema.optional(),
});
export type ValidateRedemptionInput = z.infer<typeof validateRedemptionBodySchema>;
