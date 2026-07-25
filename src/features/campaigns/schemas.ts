import { z } from "zod";

// Zod schemas for the campaigns domain: creating a promotion / reward /
// loyalty campaign, and the business's single base points rule. Mirrors the
// DB checks in supabase/migrations/0012_campaigns.sql so invalid input is
// rejected before it ever reaches Postgres; the DB constraints remain the
// source of truth. Money fields are integer centavos (see src/lib/money.ts
// pesoToCentavos) - the peso-to-centavos conversion happens at the form
// boundary, never in here.

export const idSchema = z.string().uuid();

export const CAMPAIGN_NAME_MIN_LENGTH = 2;
export const CAMPAIGN_NAME_MAX_LENGTH = 120;
export const CAMPAIGN_DESCRIPTION_MAX_LENGTH = 2000;
export const REWARD_NAME_MIN_LENGTH = 2;
export const REWARD_NAME_MAX_LENGTH = 120;
export const PROMOTION_TERMS_MAX_LENGTH = 3000;

// -------------------------------------------------------------- shared bits

const campaignNameSchema = z.string().min(CAMPAIGN_NAME_MIN_LENGTH).max(CAMPAIGN_NAME_MAX_LENGTH);
const campaignDescriptionSchema = z.string().max(CAMPAIGN_DESCRIPTION_MAX_LENGTH).optional();

// Absolute instants (campaigns.starts_at / ends_at are timestamptz). Accepts
// a Date or an ISO string from the client and coerces to Date, which is what
// the pure lifecycle engine (activationGates/isCampaignLive) expects.
const optionalInstantSchema = z.coerce.date().nullable().optional();

const campaignScheduleFields = {
  description: campaignDescriptionSchema,
  startsAt: optionalInstantSchema,
  endsAt: optionalInstantSchema,
  timezone: z.string().min(1).optional(),
};

// ------------------------------------------------------------- promotions

// Exactly promotions.offer_kind's check constraint.
export const offerKindSchema = z.enum([
  "percent_off",
  "amount_off",
  "bundle",
  "freebie",
  "announcement",
]);
export type OfferKind = z.infer<typeof offerKindSchema>;

// offer_kind determines which of percent_off / amount_off_centavos is
// required; the other must be absent. bundle/freebie/announcement offers use
// neither (freebie_text / product_ids / terms carry their payload instead).
export const promotionPayloadSchema = z
  .object({
    offerKind: offerKindSchema,
    percentOff: z.number().int().min(1).max(100).optional(),
    amountOffCentavos: z.number().int().min(1).optional(),
    freebieText: z.string().optional(),
    terms: z.string().max(PROMOTION_TERMS_MAX_LENGTH).optional(),
    productIds: z.array(idSchema).optional(),
    redemptionHint: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.offerKind === "percent_off") {
      if (value.percentOff === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["percentOff"],
          message: "percentOff (1-100) is required for a percent_off offer.",
        });
      }
      if (value.amountOffCentavos !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["amountOffCentavos"],
          message: "amountOffCentavos must not be set for a percent_off offer.",
        });
      }
    } else if (value.offerKind === "amount_off") {
      if (value.amountOffCentavos === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["amountOffCentavos"],
          message: "amountOffCentavos (>0) is required for an amount_off offer.",
        });
      }
      if (value.percentOff !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["percentOff"],
          message: "percentOff must not be set for an amount_off offer.",
        });
      }
    } else if (value.percentOff !== undefined || value.amountOffCentavos !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["offerKind"],
        message: `percentOff/amountOffCentavos must not be set for a '${value.offerKind}' offer.`,
      });
    }
  });
export type PromotionPayloadInput = z.infer<typeof promotionPayloadSchema>;

export const createPromotionCampaignSchema = z.object({
  name: campaignNameSchema,
  ...campaignScheduleFields,
  promotion: promotionPayloadSchema,
});
export type CreatePromotionCampaignInput = z.infer<typeof createPromotionCampaignSchema>;

// ----------------------------------------------------------------- rewards

export const rewardPayloadSchema = z.object({
  name: z.string().min(REWARD_NAME_MIN_LENGTH).max(REWARD_NAME_MAX_LENGTH),
  description: z.string().optional(),
  pointsCost: z.number().int().min(0),
  totalInventory: z.number().int().min(0).nullable().optional(),
  perCustomerLimit: z.number().int().min(1),
  claimExpiryDays: z.number().int().min(1).max(365),
  terms: z.string().optional(),
});
export type RewardPayloadInput = z.infer<typeof rewardPayloadSchema>;

export const createRewardCampaignSchema = z.object({
  name: campaignNameSchema,
  ...campaignScheduleFields,
  reward: rewardPayloadSchema,
});
export type CreateRewardCampaignInput = z.infer<typeof createRewardCampaignSchema>;

// --------------------------------------------------------- loyalty programs

// Exactly loyalty_programs.program_type's check constraint.
export const programTypeSchema = z.enum([
  "visit_count",
  "points_target",
  "receipt_count",
  "spend_amount",
  "custom",
]);
export type ProgramType = z.infer<typeof programTypeSchema>;

// The completion prize is itself a reward row (claim_kind='loyalty_completion'),
// but it's granted on completion rather than bought with points, so unlike
// rewardPayloadSchema it has no pointsCost/perCustomerLimit of its own.
const loyaltyPrizeRewardSchema = z.object({
  name: z.string().min(REWARD_NAME_MIN_LENGTH).max(REWARD_NAME_MAX_LENGTH),
  description: z.string().optional(),
  claimExpiryDays: z.number().int().min(1).max(365).optional(),
  terms: z.string().optional(),
});
export type LoyaltyPrizeRewardInput = z.infer<typeof loyaltyPrizeRewardSchema>;

export const loyaltyProgramPayloadSchema = z.object({
  programType: programTypeSchema,
  targetValue: z.number().int().min(1),
  stampIcon: z.string().optional(),
  cardStyle: z.record(z.string(), z.unknown()).optional(),
  minAmountPerStampCentavos: z.number().int().min(1).optional(),
  maxStampsPerDay: z.number().int().min(1).optional(),
  resetsOnCompletion: z.boolean().optional(),
  prizeReward: loyaltyPrizeRewardSchema,
});
export type LoyaltyProgramPayloadInput = z.infer<typeof loyaltyProgramPayloadSchema>;

export const createLoyaltyCampaignSchema = z.object({
  name: campaignNameSchema,
  ...campaignScheduleFields,
  loyaltyProgram: loyaltyProgramPayloadSchema,
});
export type CreateLoyaltyCampaignInput = z.infer<typeof createLoyaltyCampaignSchema>;

// ------------------------------------------------------------ points rules

// Exactly points_rules.rounding's check constraint (RoundingMode in
// src/features/points/types.ts).
export const roundingSchema = z.enum(["floor", "round", "ceil"]);

// Base rule shape mirrors points_rules for kind='base': exactly one of
// rate_centavos_per_point (amount_rate) or fixed_points (fixed_per_visit /
// fixed_per_receipt) is meaningful, discriminated on rule_type so the wrong
// pairing is a parse error rather than a silently-ignored extra field.
const amountRateBaseRuleSchema = z.object({
  ruleType: z.literal("amount_rate"),
  rateCentavosPerPoint: z.number().int().min(1),
  rounding: roundingSchema,
});
const fixedPerVisitBaseRuleSchema = z.object({
  ruleType: z.literal("fixed_per_visit"),
  fixedPoints: z.number().int().min(1),
  rounding: roundingSchema,
});
const fixedPerReceiptBaseRuleSchema = z.object({
  ruleType: z.literal("fixed_per_receipt"),
  fixedPoints: z.number().int().min(1),
  rounding: roundingSchema,
});

export const baseRuleSchema = z.discriminatedUnion("ruleType", [
  amountRateBaseRuleSchema,
  fixedPerVisitBaseRuleSchema,
  fixedPerReceiptBaseRuleSchema,
]);
export type BaseRuleInput = z.infer<typeof baseRuleSchema>;
