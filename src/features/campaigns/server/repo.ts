import { createClient } from "@/lib/supabase/server";
import { resolveOwnerBusiness } from "@/features/businesses/server/resolve-owner-business";

import type {
  BaseRuleInput,
  CreateLoyaltyCampaignInput,
  CreatePromotionCampaignInput,
  CreateRewardCampaignInput,
} from "../schemas";
import type { CampaignStatus, PayloadPresence } from "../types";
import type { CampaignRow, PointsRuleRow } from "./types";
import type { Json } from "@/lib/supabase/types";

// Repo is the only layer in this feature that touches the Supabase client.
// Every function below returns the raw `{ data, error }` shape the
// supabase-js query builder yields; service.ts turns that into the
// { ok } | { ok: false, message } contract the UI expects. RLS
// (supabase/migrations/0012_campaigns.sql) is the real authorization
// boundary; the `.eq("business_id", businessId)` scoping below is
// defense-in-depth, not the sole gate - same convention as
// src/features/menu/server/repo.ts.

type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

export { resolveOwnerBusiness };

// ---------------------------------------------------------------------
// createCampaignWithPayload family
// ---------------------------------------------------------------------
// TRANSACTIONALITY NOTE (per task-5 brief): each of the three functions
// below inserts the campaigns row, THEN the type-specific payload row(s),
// as separate sequenced statements - not a single Postgres transaction. A
// Postgres RPC (`create_campaign_with_*`) would close this gap cleanly, but
// is deferred past this slice's scope; sequenced inserts + revalidate are
// accepted for MVP.
//
// Partial-row risk: if the campaign insert succeeds but a payload insert
// fails, the campaign row would otherwise be left behind as an orphaned
// draft with no payload (which G2 would catch at activation time, so it
// can never go live, but it would still clutter listCampaigns). Each
// function mitigates this with a best-effort compensating soft-delete of
// the campaign (and, for loyalty, the prize reward) when a later insert in
// the sequence fails. This is NOT atomic: if the process crashes between
// the failed insert and the compensating update, the orphaned draft row
// remains - only a real transaction (or RPC) closes that window entirely.
// The composite (id, business_id) FKs on promotions/rewards/loyalty_programs
// still guarantee that whatever payload row DOES get created belongs to the
// same tenant as its campaign, regardless of this ordering.
// ---------------------------------------------------------------------

async function softDeleteCampaign(
  supabase: Awaited<ReturnType<typeof createClient>>,
  campaignId: string,
): Promise<void> {
  await supabase
    .from("campaigns")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", campaignId);
}

export async function createPromotionCampaignWithPayload(
  businessId: string,
  input: CreatePromotionCampaignInput,
): Promise<Result<CampaignRow>> {
  const supabase = await createClient();

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .insert({
      business_id: businessId,
      type: "promotion",
      name: input.name,
      description: input.description ?? null,
      starts_at: input.startsAt ? input.startsAt.toISOString() : null,
      ends_at: input.endsAt ? input.endsAt.toISOString() : null,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    })
    .select()
    .single();

  if (campaignError || !campaign) {
    return { data: null, error: campaignError ?? { message: "Failed to create campaign." } };
  }

  const { error: promotionError } = await supabase.from("promotions").insert({
    business_id: businessId,
    campaign_id: campaign.id,
    offer_kind: input.promotion.offerKind,
    percent_off: input.promotion.percentOff ?? null,
    amount_off_centavos: input.promotion.amountOffCentavos ?? null,
    freebie_text: input.promotion.freebieText ?? null,
    terms: input.promotion.terms ?? null,
    product_ids: input.promotion.productIds ?? [],
    redemption_hint: input.promotion.redemptionHint ?? null,
  });

  if (promotionError) {
    await softDeleteCampaign(supabase, campaign.id);
    return { data: null, error: promotionError };
  }

  return { data: campaign, error: null };
}

export async function createRewardCampaignWithPayload(
  businessId: string,
  input: CreateRewardCampaignInput,
): Promise<Result<CampaignRow>> {
  const supabase = await createClient();

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .insert({
      business_id: businessId,
      type: "reward",
      name: input.name,
      description: input.description ?? null,
      starts_at: input.startsAt ? input.startsAt.toISOString() : null,
      ends_at: input.endsAt ? input.endsAt.toISOString() : null,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    })
    .select()
    .single();

  if (campaignError || !campaign) {
    return { data: null, error: campaignError ?? { message: "Failed to create campaign." } };
  }

  const { error: rewardError } = await supabase.from("rewards").insert({
    business_id: businessId,
    campaign_id: campaign.id,
    name: input.reward.name,
    description: input.reward.description ?? null,
    points_cost: input.reward.pointsCost,
    total_inventory: input.reward.totalInventory ?? null,
    remaining: input.reward.totalInventory ?? null,
    per_customer_limit: input.reward.perCustomerLimit,
    claim_expiry_days: input.reward.claimExpiryDays,
    terms: input.reward.terms ?? null,
  });

  if (rewardError) {
    await softDeleteCampaign(supabase, campaign.id);
    return { data: null, error: rewardError };
  }

  return { data: campaign, error: null };
}

export async function createLoyaltyCampaignWithPayload(
  businessId: string,
  input: CreateLoyaltyCampaignInput,
): Promise<Result<CampaignRow>> {
  const supabase = await createClient();

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .insert({
      business_id: businessId,
      type: "loyalty",
      name: input.name,
      description: input.description ?? null,
      starts_at: input.startsAt ? input.startsAt.toISOString() : null,
      ends_at: input.endsAt ? input.endsAt.toISOString() : null,
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    })
    .select()
    .single();

  if (campaignError || !campaign) {
    return { data: null, error: campaignError ?? { message: "Failed to create campaign." } };
  }

  // Step 2: the completion prize is itself a reward row (claim_kind =
  // 'loyalty_completion'), inserted before the loyalty_programs row since
  // the latter's reward_id is not-null.
  const { data: prizeReward, error: prizeError } = await supabase
    .from("rewards")
    .insert({
      business_id: businessId,
      campaign_id: campaign.id,
      name: input.loyaltyProgram.prizeReward.name,
      description: input.loyaltyProgram.prizeReward.description ?? null,
      points_cost: 0,
      claim_kind: "loyalty_completion",
      claim_expiry_days: input.loyaltyProgram.prizeReward.claimExpiryDays ?? 30,
      terms: input.loyaltyProgram.prizeReward.terms ?? null,
    })
    .select("id")
    .single();

  if (prizeError || !prizeReward) {
    await softDeleteCampaign(supabase, campaign.id);
    return { data: null, error: prizeError ?? { message: "Failed to create the completion prize reward." } };
  }

  const { error: programError } = await supabase.from("loyalty_programs").insert({
    business_id: businessId,
    campaign_id: campaign.id,
    program_type: input.loyaltyProgram.programType,
    target_value: input.loyaltyProgram.targetValue,
    reward_id: prizeReward.id,
    stamp_icon: input.loyaltyProgram.stampIcon ?? null,
    card_style: (input.loyaltyProgram.cardStyle ?? {}) as Json,
    min_amount_per_stamp_centavos: input.loyaltyProgram.minAmountPerStampCentavos ?? null,
    ...(input.loyaltyProgram.maxStampsPerDay !== undefined
      ? { max_stamps_per_day: input.loyaltyProgram.maxStampsPerDay }
      : {}),
    ...(input.loyaltyProgram.resetsOnCompletion !== undefined
      ? { resets_on_completion: input.loyaltyProgram.resetsOnCompletion }
      : {}),
  });

  if (programError) {
    // Chain cleanup: soft-delete the prize reward too, so a failed loyalty
    // program insert doesn't leave an orphaned reward row behind.
    await supabase
      .from("rewards")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", prizeReward.id);
    await softDeleteCampaign(supabase, campaign.id);
    return { data: null, error: programError };
  }

  return { data: campaign, error: null };
}

// ---------------------------------------------------------------------
// campaign reads / updates
// ---------------------------------------------------------------------

export async function getCampaignRow(
  businessId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  return data ?? null;
}

export async function listCampaigns(businessId: string): Promise<Result<CampaignRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  return { data, error };
}

export async function updateCampaign(
  businessId: string,
  campaignId: string,
  patch: Partial<Pick<CampaignRow, "name" | "description" | "starts_at" | "ends_at" | "timezone" | "budget" | "audience">>,
): Promise<Result<CampaignRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .update(patch)
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .select()
    .single();

  return { data, error };
}

// PostgREST's error code for "the query's .single() expected exactly one
// row but got zero (or more than one)". Here it can only mean zero: our own
// .eq("id", ...).eq("business_id", ...) already scope to a single row by
// primary key, so the only way this update matches nothing is the added
// .eq("status", expectedFrom) predicate below missing because another
// request changed the status first.
const NO_ROWS_MATCHED_CODE = "PGRST116";

const STALE_STATUS_MESSAGE =
  "This campaign changed while you were working on it. Refresh and try again.";

/**
 * Thin status/column update; service.ts decides the patch (e.g. whether to
 * also stamp starts_at/archived_at) since that decision needs the
 * currently-loaded row, which the service layer already has.
 *
 * OPTIMISTIC CONCURRENCY: `expectedFrom` (the status the service layer read
 * the row as being in) is folded into the update's WHERE clause via
 * `.eq("status", expectedFrom)`, not just checked in memory beforehand.
 * Without this, two interleaved requests - e.g. one activating, one
 * archiving the same campaign - could both pass their own in-memory gate
 * checks against the same stale row and then both write, letting a
 * "archived -> active" write through and violating archived's terminal
 * state. With the predicate, only the request that still finds the row in
 * `expectedFrom` actually updates it; the loser's update matches zero rows,
 * `.single()` surfaces that as a PGRST116 error, and this function turns
 * that into a CAMPAIGN_INVALID_STATE conflict rather than a generic DB
 * error or (worse) a silent no-op success.
 */
export async function setCampaignStatus(
  businessId: string,
  campaignId: string,
  expectedFrom: CampaignStatus,
  patch: { status: CampaignStatus; starts_at?: string; archived_at?: string },
): Promise<Result<CampaignRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .update(patch)
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .eq("status", expectedFrom)
    .select()
    .single();

  if (error && error.code === NO_ROWS_MATCHED_CODE) {
    return {
      data: null,
      error: { code: "CAMPAIGN_INVALID_STATE", message: STALE_STATUS_MESSAGE },
    };
  }

  return { data, error };
}

/**
 * Resolves the type-specific payload presence booleans/counts the pure
 * lifecycle gate G2 needs (see PayloadPresence in ../types), by querying the
 * promotions / rewards / loyalty_programs / points_rules tables scoped to
 * this campaign. Row-internal validity (e.g. percent_off set for a
 * percent_off offer) is enforced by the payload schemas at save time, not
 * here - this only checks presence, matching the pure gate's contract.
 */
export async function getCampaignPayloadPresence(
  businessId: string,
  campaignId: string,
): Promise<PayloadPresence> {
  const supabase = await createClient();

  const [{ data: promotion }, { data: rewards }, { data: loyaltyProgram }, { data: pointsRules }] =
    await Promise.all([
      supabase
        .from("promotions")
        .select("id")
        .eq("campaign_id", campaignId)
        .eq("business_id", businessId)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("rewards")
        .select("id")
        .eq("campaign_id", campaignId)
        .eq("business_id", businessId)
        .eq("is_active", true)
        .is("deleted_at", null),
      supabase
        .from("loyalty_programs")
        .select("id, reward_id")
        .eq("campaign_id", campaignId)
        .eq("business_id", businessId)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("points_rules")
        .select("id")
        .eq("campaign_id", campaignId)
        .eq("business_id", businessId)
        .eq("is_active", true)
        .is("deleted_at", null),
    ]);

  let hasLoyaltyPrize = false;
  if (loyaltyProgram) {
    const { data: prize } = await supabase
      .from("rewards")
      .select("id")
      .eq("id", loyaltyProgram.reward_id)
      .eq("business_id", businessId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle();
    hasLoyaltyPrize = prize !== null;
  }

  return {
    hasPromotion: promotion !== null,
    rewardCount: (rewards ?? []).length,
    hasLoyaltyProgram: loyaltyProgram !== null,
    hasLoyaltyPrize,
    pointsRuleCount: (pointsRules ?? []).length,
  };
}

export async function getBusinessStatus(businessId: string): Promise<{ status: string } | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("businesses")
    .select("status")
    .eq("id", businessId)
    .maybeSingle();

  return data ?? null;
}

// ---------------------------------------------------------------------
// base points rule
// ---------------------------------------------------------------------

function baseRulePatch(input: BaseRuleInput) {
  if (input.ruleType === "amount_rate") {
    return {
      rule_type: input.ruleType,
      rounding: input.rounding,
      rate_centavos_per_point: input.rateCentavosPerPoint,
      fixed_points: null,
    };
  }
  return {
    rule_type: input.ruleType,
    rounding: input.rounding,
    fixed_points: input.fixedPoints,
    rate_centavos_per_point: null,
  };
}

// Postgres error code for a unique-constraint violation, e.g. the partial
// unique index points_rules_one_base (one active base rule per business).
const UNIQUE_VIOLATION = "23505";
const BASE_RULE_EXISTS_MESSAGE = "A base earning rule already exists";

function friendlyRuleError(error: { message: string; code?: string }): { message: string; code?: string } {
  if (error.code === UNIQUE_VIOLATION) {
    return { message: BASE_RULE_EXISTS_MESSAGE };
  }
  return error;
}

/**
 * Insert-or-update the business's single active base rule. Checks for an
 * existing active base rule first (the common, non-racy path uses an
 * UPDATE, not an INSERT-then-catch); the points_rules_one_base partial
 * unique index (business_id where kind='base' and is_active and not
 * deleted) is still the source of truth, so a concurrent insert racing this
 * check surfaces as a 23505, which is translated into a friendly message
 * rather than a raw Postgres error.
 */
export async function upsertBaseRule(
  businessId: string,
  input: BaseRuleInput,
): Promise<Result<PointsRuleRow>> {
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("points_rules")
    .select("id")
    .eq("business_id", businessId)
    .eq("kind", "base")
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();

  const patch = baseRulePatch(input);

  if (existing) {
    const { data, error } = await supabase
      .from("points_rules")
      .update(patch)
      .eq("id", existing.id)
      .eq("business_id", businessId)
      .select()
      .single();

    return { data, error: error ? friendlyRuleError(error) : null };
  }

  const { data, error } = await supabase
    .from("points_rules")
    .insert({ business_id: businessId, kind: "base", campaign_id: null, ...patch })
    .select()
    .single();

  return { data, error: error ? friendlyRuleError(error) : null };
}

export async function getBaseRule(businessId: string): Promise<PointsRuleRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("points_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("kind", "base")
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();

  return data ?? null;
}

export async function listPointsRules(businessId: string): Promise<Result<PointsRuleRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("points_rules")
    .select("*")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  return { data, error };
}
