import { z } from "zod";

// Zod schemas for the BUSINESS side of the rewards domain: the merchant's
// reward catalog (`/business/rewards`). The consumer side (claim/redeem) lives
// in ../schemas.ts and is untouched by this slice.
//
// Every bound below mirrors either a check constraint on `public.rewards`
// (supabase/migrations/0012_campaigns.sql) or a guard inside the
// `claim_reward` RPC (0013_reward_claim_rpcs.sql). The DB and the RPC remain
// the source of truth; these schemas exist so a merchant is told what is wrong
// in their own words instead of the app forwarding a Postgres error - and, more
// importantly, so the form cannot mint a reward that `claim_reward` would
// refuse on every single attempt for the rest of its life.

export const idSchema = z.string().uuid();

export const REWARD_NAME_MIN_LENGTH = 2;
export const REWARD_NAME_MAX_LENGTH = 120;

/** No DB cap on `rewards.description`; this is the app's own, matching campaigns. */
export const REWARD_DESCRIPTION_MAX_LENGTH = 2000;
export const REWARD_TERMS_MAX_LENGTH = 3000;

export const MIN_CLAIM_EXPIRY_DAYS = 1;
export const MAX_CLAIM_EXPIRY_DAYS = 365;

/**
 * `business_customers.points_balance` is a Postgres `integer` with a
 * `>= 0` check, so 2147483647 is the largest balance any customer can ever
 * hold. `claim_reward` refuses with POINTS_INSUFFICIENT whenever
 * `points_balance < points_cost`, which makes a cost above this ceiling
 * unsatisfiable by construction rather than merely expensive.
 */
export const MAX_POINTS_COST = 2_147_483_647;

/**
 * Zero is deliberately NOT a legal inventory. `claim_reward` step 2 decrements
 * conditionally (`where remaining is null or remaining > 0`) and raises
 * REWARD_OUT_OF_STOCK when nothing matched, so a reward created with
 * `total_inventory = 0` is born permanently unclaimable. Unlimited stock is
 * expressed by leaving the field empty (null), not by zero.
 */
export const MIN_TOTAL_INVENTORY = 1;

const rewardNameSchema = z
  .string()
  .trim()
  .min(REWARD_NAME_MIN_LENGTH, "Give the reward a name")
  .max(REWARD_NAME_MAX_LENGTH, `Keep the name under ${REWARD_NAME_MAX_LENGTH} characters`);

const optionalTextSchema = (max: number) => z.string().trim().max(max).optional();

// `per_customer_limit` has `check (per_customer_limit > 0)` in the DDL, and
// `claim_reward` compares `v_claim_count >= v_reward_limit` with the count
// starting at zero - so a limit of 0 raises REWARD_LIMIT_REACHED on the first
// attempt and every attempt after it.
const perCustomerLimitSchema = z
  .number()
  .int()
  .min(1, "Each customer must be able to claim this at least once");

const pointsCostSchema = z
  .number()
  .int()
  .min(0, "Points cost cannot be negative")
  .max(MAX_POINTS_COST, "That points cost is higher than any customer balance can ever reach");

const totalInventorySchema = z
  .number()
  .int()
  .min(MIN_TOTAL_INVENTORY, "Stock must be at least 1. Leave it blank for unlimited.")
  .nullable()
  .optional();

const claimExpiryDaysSchema = z
  .number()
  .int()
  .min(MIN_CLAIM_EXPIRY_DAYS, "Claims must stay valid for at least a day")
  .max(MAX_CLAIM_EXPIRY_DAYS, `Claims cannot stay valid longer than ${MAX_CLAIM_EXPIRY_DAYS} days`);

const rewardFields = {
  name: rewardNameSchema,
  description: optionalTextSchema(REWARD_DESCRIPTION_MAX_LENGTH),
  pointsCost: pointsCostSchema,
  totalInventory: totalInventorySchema,
  perCustomerLimit: perCustomerLimitSchema,
  claimExpiryDays: claimExpiryDaysSchema,
  terms: optionalTextSchema(REWARD_TERMS_MAX_LENGTH),
};

/**
 * `rewards.campaign_id` is NOT NULL with a composite (id, business_id) foreign
 * key, so every reward hangs off one of the tenant's own campaigns. The id is
 * validated for shape here and re-checked against the tenant, and against the
 * campaign's own claimability, in server/service.ts - shape validation is not
 * an authorization check.
 */
export const createRewardSchema = z.object({
  campaignId: idSchema,
  ...rewardFields,
});
export type CreateRewardInput = z.infer<typeof createRewardSchema>;

/**
 * Editing deliberately cannot re-parent a reward onto a different campaign:
 * `reward_claims` already made against it are scoped to the old campaign's
 * budget counters (doc 34 section 5), and moving the reward would silently
 * re-interpret those counts.
 */
export const updateRewardSchema = z.object({
  rewardId: idSchema,
  ...rewardFields,
});
export type UpdateRewardInput = z.infer<typeof updateRewardSchema>;

export const setRewardActiveSchema = z.object({
  rewardId: idSchema,
  isActive: z.boolean(),
});
export type SetRewardActiveInput = z.infer<typeof setRewardActiveSchema>;
