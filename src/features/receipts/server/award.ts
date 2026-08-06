import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isCampaignLive } from "@/features/campaigns/lifecycle";
import type { Campaign, CampaignType } from "@/features/campaigns/types";
import { pauseExhaustedCampaigns } from "@/features/campaigns/server/exhaustion";
import { manilaDayOf } from "@/features/analytics/manila-day";
import { computePoints } from "@/features/points/compute";
import { ruleConditionsSchema } from "@/features/points/conditions";
import type {
  PointsRule,
  RoundingMode,
  RuleConditions,
  RuleKind,
  RuleTier,
  RuleType,
} from "@/features/points/types";
import type { Database, Json } from "@/lib/supabase/types";

import { RECEIPT_TIMEZONE } from "../parse";

// ===========================================================================
// THE ONE AWARD PATH.
//
// Doc 36 Stage 9 states the constraint this module exists to make literally
// true: "Approve path is identical to auto-approval: the same service function
// transitions review to approved, sets reviewed_by/reviewed_at, persists
// edited fields, and invokes the points engine, no separate code path, so
// ledger invariants hold (one earn per receipt via pt_receipt_earn_once)."
//
// Two callers, one implementation:
//   * the OCR pipeline (`process.ts`), on an auto-approved receipt;
//   * the human review service, on a receipt a manager approved.
// Anything either of them needs to do DIFFERENTLY stays in the caller. This
// module knows nothing about OCR attempts, processing status transitions,
// reviewers, or audit rows.
//
// ---------------------------------------------------------------------------
// WHO WRITES status='approved': THE CALLER, BEFORE CALLING `awardPoints`.
// ---------------------------------------------------------------------------
// This is a contract, not an implementation detail, so it is stated here and
// asserted by the tests. 0018 step 2 loads the receipt `for update` and raises
// RECEIPT_NOT_AWARDABLE unless `status = 'approved'` and business_id/user_id
// are both set, so the row must already be approved in the database when the
// RPC runs.
//
// The write is left to the caller rather than performed here because neither
// caller can give it up:
//   * the pipeline writes the terminal status in ONE statement together with
//     business_id, every parsed field, both confidences and parse_meta,
//     because `receipts_number_unique` (0017) is a partial index over the live
//     statuses and a receipt losing that race has to land as 'rejected' in the
//     same statement that writes its number (see process.ts `persistOutcome`);
//   * the review service writes the reviewer's corrected fields plus
//     reviewed_by/reviewed_at in its own statement, and owns the guard order
//     that decides whether the transition is legal at all.
// An award function that also owned the status write would have to reproduce
// both, which is the drift this extraction exists to prevent.
//
// WHO WRITES `processed_at` ON AN APPROVED RECEIPT: THE RPC, NOT THE CALLER.
// Both RPCs stamp it (0018 step 7, 0023 step 3), so a caller that lands a
// receipt on 'approved' with a business and a consumer must leave the column
// null and let this module's call write it. Only the paths that never reach
// an RPC (rejected, review, an OCR dead end) stamp it themselves. Two values a
// few milliseconds apart would make doc 52's scan e2e latency ambiguous, and
// `processed_at is null` on an approved row is what makes a failed award or a
// failed visit record findable.
//
// `priceReceipt` is deliberately separable from `awardPoints` for the same
// ordering reason: the pipeline must know whether the receipt prices above
// zero BEFORE it writes the row. `awardApprovedReceipt` composes the two for
// callers that do not need the plan in advance.
//
// Docs: docs/30-modules/35-points-engine.md (sections 2-3 award pipeline,
// section 11 "one implementation of the rule math", section 12 error codes),
// docs/30-modules/34-campaign-engine.md section 6 (stacking),
// docs/30-modules/36-receipt-ocr-pipeline.md Stages 9-10,
// supabase/migrations/0018_award_receipt_points.sql (the RPC itself).
// ===========================================================================

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Everything the award path talks to that is not pure, injected in the same
 * shape `ProcessReceiptDeps` already uses so the two suites stay consistent.
 *
 * `supabase` MUST be the SERVICE ROLE client: 0018 revokes execute on
 * `award_receipt_points` from public/anon/authenticated and grants it to
 * service_role alone, because this function mints points.
 */
export interface AwardDeps {
  supabase: SupabaseClient<Database>;
  now: () => Date;
}

/**
 * The receipt facts pricing needs, and nothing else.
 *
 * Deliberately NOT the `receipts` row and NOT `ParsedReceipt`: the pipeline
 * prices the values it just parsed, while the review service prices the values
 * a manager corrected. Both flatten into these four fields, so neither caller
 * can accidentally price something the other could not.
 */
export interface AwardReceipt {
  id: string;
  /**
   * `receipts.user_id`. Needed only for the fixed_per_visit VISIT-DAY dedupe
   * precheck (task 1.1), which has to scope its `fixed_per_visit_already_paid`
   * check to this consumer; every other computation in this module already
   * gets the consumer from the caller (`isFirstVisit`) or from the RPC itself.
   */
  userId: string;
  /** `receipts.created_at`, the doc 40 event_ts fallback for a dateless receipt. */
  createdAt: string;
  totalCentavos: number | null;
  receiptDate: Date | null;
}

/** What `priceReceipt` decided, and what `awardPoints` sends to 0018/0038. */
export interface AwardPlan {
  points: number;
  ruleSnapshot: Json;
  campaignId: string | null;
  expiresAt: string | null;
  /**
   * Doc 35 task 1.1 (fixed_per_visit pays once per VISIT DAY). True only
   * when the winning base rule is `fixed_per_visit`, its own conditions are
   * met, AND `priceReceipt`'s own precheck found no prior PAID fixed_per_visit
   * earn for this receipt's visit day (so `points`/`ruleSnapshot` above were
   * priced WITHOUT the dedupe applied). "Visit day" is doc 35's own
   * definition - `manila_day(coalesce(receipt_date, created_at))` - not
   * processing time: a receipt approved a day (or several) after the one it
   * duplicates still needs to dedupe correctly, which is why this precheck
   * cannot be a simple "same processing day" read.
   *
   * That precheck is an ordinary, non-locked read and is explicitly NOT
   * race-safe on its own: two concurrent receipts for the same pair could
   * both read "not yet paid" before either commits. When this flag is true,
   * `awardPoints` asks 0038's `award_receipt_points` to re-verify under the
   * `business_customers` row lock it already holds and raise
   * `FIXED_PER_VISIT_RACE` rather than risk a second full award; `awardPoints`
   * then recovers using `dedupedFallback` below rather than stranding the
   * receipt. When this flag is false - either the base is not
   * fixed_per_visit, or the precheck already found a prior paid earn and
   * priced accordingly (0, or an independent bonus alone) - no
   * re-verification is requested, because re-verifying would find that SAME
   * prior earn and wrongly refuse a legitimate, already-deduped award.
   */
  verifyNoPriorFixedPerVisitEarn: boolean;
  /**
   * The alternate `{points, ruleSnapshot}` `priceReceipt` would have produced
   * had its precheck found a prior paid fixed_per_visit earn for this visit
   * day, computed with the SAME pure engine (`dedupeFixedPerVisit: true`) so
   * it is never a second implementation of the rule math (doc 35 section
   * 11). Present only when `verifyNoPriorFixedPerVisitEarn` is true - i.e.
   * only when there is something worth recovering to.
   *
   * `awardPoints` uses this, not a fresh price, when `award_receipt_points`
   * raises `FIXED_PER_VISIT_RACE`: the prior earn the RPC found under its
   * lock is exactly the fact this fallback already assumed, so replaying it
   * is authoritative, not a guess.
   */
  dedupedFallback: {
    points: number;
    ruleSnapshot: Json;
    /**
     * Review fix (task 1.2, I2): this fallback's OWN surviving campaign-capped
     * contributions, recomputed against ITS pricing (never `budgetChecks`
     * above verbatim - a deduped base collapses every multiplier's extra to
     * 0, so a capped MULTIPLIER contribution shrinks with it while a capped
     * BONUS does not). `awardAfterFixedPerVisitRace`'s retry sends this as
     * `p_campaign_budget_checks`, so recovering from one race never silently
     * drops the other guard.
     */
    budgetChecks: Array<{ campaignId: string; points: number }>;
  } | null;
  /**
   * Doc 34 section 5, task 1.2: distinct campaign ids whose surviving
   * (non-dropped) contribution to THIS receipt comes from a campaign with a
   * `max_total_points` and/or `per_customer_limit` cap, paired with that
   * contribution's point value. `awardPoints` sends this to 0040's
   * `award_receipt_points` as `p_campaign_budget_checks`, so the RPC can
   * re-verify each one under a `campaigns` row lock before minting -
   * `priceReceipt`'s own read of the running total is an ordinary, unlocked
   * one and is not race-safe against a DIFFERENT consumer's concurrent award
   * against the SAME campaign. Empty when no surviving contribution is
   * campaign-capped.
   */
  budgetChecks: Array<{ campaignId: string; points: number }>;
  /**
   * What this receipt would price at if EVERY campaign-capped contribution
   * above were dropped instead, computed by the SAME pure engine
   * (`resolveCampaignBudgets`'s `raceFallbackApplied`) so the RPC's
   * `CAMPAIGN_BUDGET_RACE` recovery in `awardPoints` never becomes a second
   * implementation of the rule math - the same shape `dedupedFallback` above
   * already established for the fixed_per_visit race. Present only when
   * `budgetChecks` is non-empty.
   */
  budgetRaceFallback: { points: number; ruleSnapshot: Json; campaignId: string | null } | null;
  /**
   * Review fix (task 1.2, I2): the FOURTH plan variant - both the
   * fixed_per_visit dedupe AND every campaign-capped contribution dropped.
   * Present only when BOTH races are actually possible for this receipt
   * (`verifyNoPriorFixedPerVisitEarn` is true AND `budgetChecks` is
   * non-empty). Used two ways, never as a THIRD RPC attempt:
   *   - `awardAfterFixedPerVisitRace`'s retry (which already carries
   *     `dedupedFallback.budgetChecks`) can still raise CAMPAIGN_BUDGET_RACE
   *     a second time; that compound race falls straight to the EXISTING
   *     terminal zero-point path, but priced/annotated from THIS variant
   *     rather than `dedupedFallback` alone, so the record correctly shows
   *     both facts (review I6) instead of just the one this function knew
   *     about.
   *   - `awardAfterCampaignBudgetRace`'s retry (which already carries
   *     `p_verify_no_prior_fixed_visit_earn` when applicable) falls to the
   *     same terminal path the same way if IT raises FIXED_PER_VISIT_RACE a
   *     second time.
   */
  bothDroppedFallback: { points: number; ruleSnapshot: Json; campaignId: string | null } | null;
  /**
   * Distinct campaign ids with a `max_total_points` cap that THIS receipt
   * considered, whether or not their contribution survived to the final
   * total. Doc 34 section 5's exhaustion pause is about the CAMPAIGN's
   * cumulative state, not this one receipt's outcome, so a campaign whose
   * contribution was dropped here still needs the post-commit check: it may
   * already be the reason for the drop. `per_customer_limit` alone is
   * deliberately excluded - doc 34: "per_customer_limit hitting for one
   * consumer is not exhaustion".
   */
  maxTotalPointsCampaignIds: string[];
}

/** How loudly a refused award is logged, and whether it is benign. */
export type AwardErrorSeverity = "info" | "warn" | "error";

/**
 * What happened at the ledger. Returned so the review service can audit it.
 *
 * `skipped_zero_points` means the LEDGER was skipped, not that nothing
 * happened: the receipt's visit and spend were still recorded against the
 * `business_customers` pair row by `record_receipt_visit` (0023). See
 * `awardPoints`.
 */
export type AwardResult =
  | { kind: "awarded"; points: number; transactionId: string | null }
  | { kind: "skipped_zero_points" }
  | { kind: "refused"; code: string; severity: AwardErrorSeverity };

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface PointsRuleRow {
  id: string;
  campaign_id: string | null;
  kind: string;
  rule_type: string;
  rate_centavos_per_point: number | null;
  fixed_points: number | null;
  tiers: Json | null;
  multiplier: number | null;
  bonus_points: number | null;
  conditions: Json;
  rounding: string;
}

export interface CampaignRow {
  id: string;
  type: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  timezone: string;
  priority: number;
  is_stackable: boolean;
  /** campaigns.budget jsonb (doc 34 section 5): `{max_total_points, max_redemptions,
   * per_customer_limit}`, all keys optional. Read here (task 1.2) so
   * `resolveCampaignBudgets` can enforce the two award-time guardrails
   * without a second query per candidate. */
  budget: Json;
}

interface PostgrestFailure {
  message: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Round-trip through JSON exactly as the wire would. `rule_snapshot` is a jsonb
 * column and doc 35 calls it a FROZEN record, so it is proven serializable and
 * stripped of `undefined` keys here rather than at the driver.
 */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// points_rules rows -> the pure engine's shapes
// ---------------------------------------------------------------------------

const RULE_KINDS: readonly RuleKind[] = ["base", "multiplier", "bonus"];
const RULE_TYPES: readonly RuleType[] = [
  "amount_rate",
  "fixed_per_visit",
  "fixed_per_receipt",
  "tiered_amount",
];
const ROUNDING_MODES: readonly RoundingMode[] = ["floor", "round", "ceil"];

/**
 * Zod hands back an object whose optional keys are PRESENT with the value
 * `undefined`; `exactOptionalPropertyTypes` (on for this project) treats that
 * as different from an absent key. Rebuild explicitly so an unset condition is
 * genuinely absent, which is what `evaluateConditions` tests for.
 */
function toRuleConditions(parsed: {
  days?: number[] | undefined;
  time_from?: string | undefined;
  time_to?: string | undefined;
  min_amount_centavos?: number | undefined;
  birthday?: boolean | undefined;
  first_visit?: boolean | undefined;
}): RuleConditions {
  const conditions: RuleConditions = {};
  if (parsed.days !== undefined) conditions.days = parsed.days;
  if (parsed.time_from !== undefined) conditions.time_from = parsed.time_from;
  if (parsed.time_to !== undefined) conditions.time_to = parsed.time_to;
  if (parsed.min_amount_centavos !== undefined) {
    conditions.min_amount_centavos = parsed.min_amount_centavos;
  }
  if (parsed.birthday !== undefined) conditions.birthday = parsed.birthday;
  if (parsed.first_visit !== undefined) conditions.first_visit = parsed.first_visit;
  return conditions;
}

function toTiers(raw: Json | null): RuleTier[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tiers: RuleTier[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const min = optionalNumber(entry.min_centavos);
    const points = optionalNumber(entry.points);
    if (min === undefined || points === undefined) continue;
    const max = optionalNumber(entry.max_centavos);
    tiers.push({ minCentavos: min, maxCentavos: max ?? null, points });
  }
  return tiers.length > 0 ? tiers : undefined;
}

/**
 * A `points_rules` row as the pure engine wants it. Returns null for a row the
 * engine could not evaluate (an unknown kind/type/rounding, i.e. a value the
 * check constraints should have refused): dropping it under-awards, whereas
 * guessing a default would mint points from a row nobody authored.
 */
export function toPointsRule(row: PointsRuleRow): PointsRule | null {
  const kind = RULE_KINDS.find((candidate) => candidate === row.kind);
  const ruleType = RULE_TYPES.find((candidate) => candidate === row.rule_type);
  const rounding = ROUNDING_MODES.find((candidate) => candidate === row.rounding);
  if (kind === undefined || ruleType === undefined || rounding === undefined) {
    return null;
  }

  const parsedConditions = ruleConditionsSchema.safeParse(row.conditions ?? {});
  const rule: PointsRule = {
    id: row.id,
    kind,
    rule_type: ruleType,
    rounding,
    // A conditions blob that fails the DSL schema is treated as "always
    // applies" ONLY for the base rule's sake; for a multiplier or bonus that
    // would over-award, so the rule is dropped instead.
    conditions: parsedConditions.success ? toRuleConditions(parsedConditions.data) : {},
  };
  if (!parsedConditions.success && kind !== "base") return null;

  if (row.rate_centavos_per_point !== null) {
    rule.rate_centavos_per_point = row.rate_centavos_per_point;
  }
  if (row.fixed_points !== null) rule.fixed_points = row.fixed_points;
  const tiers = toTiers(row.tiers);
  if (tiers !== undefined) rule.tiers = tiers;
  if (row.multiplier !== null) rule.multiplier = row.multiplier;
  if (row.bonus_points !== null) rule.bonus_points = row.bonus_points;

  return rule;
}

/**
 * Doc 34 section 6 stacking, in its minimal form: campaign-attached candidate
 * rules are considered in campaign priority order (lower number wins, doc 34),
 * the first campaign always applies, and a later campaign joins it only when
 * every campaign involved is `is_stackable`. A non-stackable campaign
 * therefore applies alone.
 *
 * Rules with no campaign (business-default multipliers and bonuses) always
 * apply: they are not campaign offers and have nothing to stack against.
 *
 * This is deliberately conservative. Doc 34's full stacking engine is not part
 * of this slice and no shared pure implementation exists yet; handing every
 * live candidate to `computePoints` instead would silently ignore
 * `is_stackable` and OVER-award, which on a ledger is the expensive direction
 * to be wrong in.
 */
export function resolveStacking<T extends { campaignId: string | null }>(
  candidates: readonly T[],
  campaigns: ReadonlyMap<string, CampaignRow>,
): T[] {
  const ordered = [...candidates].sort((a, b) => {
    const left = a.campaignId === null ? null : campaigns.get(a.campaignId);
    const right = b.campaignId === null ? null : campaigns.get(b.campaignId);
    const leftPriority = left?.priority ?? Number.NEGATIVE_INFINITY;
    const rightPriority = right?.priority ?? Number.NEGATIVE_INFINITY;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return (a.campaignId ?? "").localeCompare(b.campaignId ?? "");
  });

  const applied: T[] = [];
  const acceptedCampaignIds = new Set<string>();
  let acceptedIsExclusive = false;

  for (const candidate of ordered) {
    if (candidate.campaignId === null) {
      applied.push(candidate);
      continue;
    }
    if (acceptedCampaignIds.has(candidate.campaignId)) {
      applied.push(candidate);
      continue;
    }
    if (acceptedIsExclusive) continue;

    const campaign = campaigns.get(candidate.campaignId);
    if (campaign === undefined) continue;
    if (acceptedCampaignIds.size > 0 && !campaign.is_stackable) continue;

    acceptedCampaignIds.add(candidate.campaignId);
    if (!campaign.is_stackable) acceptedIsExclusive = true;
    applied.push(candidate);
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Runs the SHARED pure engine (doc 35 section 11 requires exactly one
 * implementation, serving both the consumer's optimistic preview and this
 * award) over the business's active rules.
 *
 * Returns a plan with `points: 0` rather than null when there is nothing to
 * award, so the caller can still record that pricing ran. Zero is a legitimate
 * outcome, not a failure: see `awardPoints`.
 *
 * `isFirstVisit` is the caller's to supply because both callers have already
 * read `business_customers` for their own reasons (the pipeline for the
 * blacklist check, the review service for the same tenancy row), and reading
 * it twice would be a second source of truth for the same fact.
 */
export async function priceReceipt(input: {
  deps: AwardDeps;
  businessId: string;
  receipt: AwardReceipt;
  isFirstVisit: boolean;
}): Promise<AwardPlan> {
  const { deps, businessId, receipt } = input;
  const empty: AwardPlan = {
    points: 0,
    ruleSnapshot: toJson({ engine: "points/v1", total_points: 0, base: null }),
    campaignId: null,
    expiresAt: null,
    verifyNoPriorFixedPerVisitEarn: false,
    dedupedFallback: null,
    budgetChecks: [],
    budgetRaceFallback: null,
    bothDroppedFallback: null,
    maxTotalPointsCampaignIds: [],
  };

  const { data, error } = await deps.supabase
    .from("points_rules")
    .select(
      "id, campaign_id, kind, rule_type, rate_centavos_per_point, fixed_points, tiers, multiplier, bonus_points, conditions, rounding",
    )
    .eq("business_id", businessId)
    .eq("is_active", true)
    .is("deleted_at", null);

  if (error !== null) {
    console.error(
      `[receipts/award] could not load points rules for business ${businessId}`,
      error,
    );
    return empty;
  }

  const rows = (data ?? []) as PointsRuleRow[];
  const baseRow = rows.find((row) => row.kind === "base");
  const baseRule = baseRow === undefined ? null : toPointsRule(baseRow);
  if (baseRule === null) {
    // No active base rule means the business has not configured earning at all
    // (`points_rules_one_base` guarantees at most one). That is a legitimate
    // configuration, not an error: the receipt is still a real, approved
    // purchase and still belongs in the consumer's history and the tenant's
    // analytics. See the zero-point handling in `awardPoints`.
    console.info(
      `[receipts/award] business ${businessId} has no active base points rule; approving receipt ${receipt.id} with 0 points`,
    );
    return empty;
  }

  // Doc 35 section 2: conditions are evaluated at receipts.receipt_date, never
  // at processing time. A dateless receipt falls back to created_at, which is
  // the same event_ts rule doc 40 gives and the same one 0018 uses for the
  // visit day, so the two can never disagree.
  const receiptDate = receipt.receiptDate ?? new Date(receipt.createdAt);

  const campaignIds = [
    ...new Set(
      rows
        .filter((row) => row.kind !== "base")
        .map((row) => row.campaign_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const campaigns = await loadCampaigns(deps.supabase, campaignIds);

  const candidates: Array<{ campaignId: string | null; rule: PointsRule }> = [];
  for (const row of rows) {
    if (row.kind === "base") continue;
    const rule = toPointsRule(row);
    if (rule === null) continue;
    if (row.campaign_id !== null) {
      const campaign = campaigns.get(row.campaign_id);
      if (campaign === undefined) continue;
      if (!isCampaignLive(toEngineCampaign(campaign), receiptDate)) continue;
    }
    candidates.push({ campaignId: row.campaign_id, rule });
  }

  const applied = resolveStacking(candidates, campaigns);
  const timezone =
    applied
      .map((candidate) =>
        candidate.campaignId === null
          ? undefined
          : campaigns.get(candidate.campaignId)?.timezone,
      )
      .find((zone): zone is string => zone !== undefined) ?? RECEIPT_TIMEZONE;

  // Doc 35 task 1.1: fixed_per_visit pays once per VISIT DAY, not once per
  // receipt and not once per processing day. This is the ADVISORY half of
  // that fix - an ordinary read, not under any lock - so it is skipped
  // entirely unless it could matter (a fixed_per_visit base rule), both to
  // avoid a wasted query on every other rule type and because a false "true"
  // here for an ineligible rule_type would incorrectly ask the RPC to
  // re-verify a fact that has nothing to do with this receipt. See
  // `awardPoints` and `AwardPlan.verifyNoPriorFixedPerVisitEarn` for the
  // race-safe half, done under the RPC's `business_customers` lock.
  const visitDay = manilaDayOf(receiptDate);
  const dedupeFixedPerVisit =
    baseRule.rule_type === "fixed_per_visit"
      ? await hasPaidFixedPerVisitEarn({
          supabase: deps.supabase,
          businessId,
          consumerId: receipt.userId,
          visitDay,
        })
      : false;

  // Shared by every computePoints call below (the trial pass, the final
  // pass, and both fallbacks) so all of them price from identical inputs -
  // the only thing that ever varies between calls is which candidateRules
  // survive and dedupeFixedPerVisit.
  const engineInputBase = {
    amountCentavos: receipt.totalCentavos ?? 0,
    receiptDate,
    businessTimezone: timezone,
    baseRule,
    visitContext: { isFirstVisit: input.isFirstVisit },
  };

  // Doc 34 section 5, task 1.2: a TRIAL pass over the FULL stacked set,
  // before any campaign-budget filtering. This is what lets
  // `resolveCampaignBudgets` learn each campaign-linked rule's raw
  // contribution (a multiplier's `points_delta`, a bonus's `bonus_points`)
  // from the ONE pure engine's own frozen snapshot rather than a second,
  // parallel implementation of the additive-extras arithmetic doc 34
  // section 6 defines.
  const trial = computePoints({
    ...engineInputBase,
    candidateRules: applied.map((candidate) => candidate.rule),
    dedupeFixedPerVisit,
  });

  const {
    finalApplied,
    budgetDropped,
    budgetChecks,
    raceFallbackApplied,
    maxTotalPointsCampaignIds,
    campaignIdByRuleId,
    cappedSurvivingIds,
  } = await resolveCampaignBudgets({
    supabase: deps.supabase,
    businessId,
    consumerId: receipt.userId,
    applied,
    campaigns,
    trialSnapshot: trial.ruleSnapshot,
  });

  // Review fix (task 1.2, M6): what a race-fallback variant's OWN
  // budget_dropped must additionally record, beyond the advisory pass's own
  // `budgetDropped` - every campaign a race-fallback variant drops that the
  // advisory pass did NOT already drop (it survived there; a race-fallback
  // variant drops it anyway, by construction).
  const raceDroppedEntries: BudgetDrop[] = [...cappedSurvivingIds].map((id) => {
    const campaign = campaigns.get(id);
    return {
      campaignId: id,
      reason: campaign === undefined ? "max_total_points" : raceDropReason(campaign),
    };
  });

  const engineInput = {
    ...engineInputBase,
    candidateRules: finalApplied.map((candidate) => candidate.rule),
  };

  // Nothing was budget-dropped: the trial pass above already IS the correct
  // final pricing, so it is reused rather than re-running the identical
  // computation a second time.
  const result =
    finalApplied.length === applied.length
      ? trial
      : computePoints({ ...engineInput, dedupeFixedPerVisit });

  // Doc 35 step 9: campaign_id on the ledger row is "the primary applied
  // campaign or null". `resolveStacking` already emitted the candidates in
  // campaign priority order, so the first SURVIVING one that names a
  // campaign is it - a campaign whose entire contribution was dropped for
  // budget reasons cannot be the primary one (task 1.2).
  const campaignId =
    finalApplied.find((candidate) => candidate.campaignId !== null)?.campaignId ?? null;

  // True only when the base COULD have contributed a fixed_per_visit amount
  // and this precheck believed nothing was already paid for this visit day:
  // exactly the case a same-request race could get wrong. When the precheck
  // instead found a prior paid earn (dedupeFixedPerVisit true),
  // `result.breakdown.basePoints` is already 0 here and no re-verification is
  // asked for - see `AwardPlan`'s own doc comment for why that direction must
  // stay false.
  const verifyNoPriorFixedPerVisitEarn =
    baseRule.rule_type === "fixed_per_visit" &&
    !dedupeFixedPerVisit &&
    result.breakdown.basePoints > 0;

  // C2 fix: precompute what this receipt would have priced at HAD the
  // precheck found a prior paid earn, using the SAME pure engine. This is
  // the number/snapshot `awardPoints` replays (never recomputed in SQL) if
  // 0038 raises FIXED_PER_VISIT_RACE - i.e. if a concurrent request commits
  // that prior earn between this precheck and the RPC's lock. Priced over
  // `finalApplied` (task 1.2): a budget-dropped campaign stays dropped in
  // this fallback too.
  let dedupedFallback: AwardPlan["dedupedFallback"] = null;
  if (verifyNoPriorFixedPerVisitEarn) {
    const fallbackResult = computePoints({ ...engineInput, dedupeFixedPerVisit: true });
    dedupedFallback = {
      points: fallbackResult.points,
      ruleSnapshot: enrichRuleSnapshot({
        snapshot: fallbackResult.ruleSnapshot,
        now: deps.now(),
        receipt,
        applied: finalApplied,
        campaigns,
        budgetDropped,
      }),
      // Review fix (task 1.2, I2): recomputed from THIS fallback's OWN
      // snapshot, not copied from the primary pass's `budgetChecks` - a
      // deduped base collapses every multiplier's contribution to 0, which a
      // capped multiplier's own re-check must see.
      budgetChecks: contributionsForCampaigns(
        fallbackResult.ruleSnapshot,
        campaignIdByRuleId,
        cappedSurvivingIds,
      ),
    };
  }

  // Doc 34 section 5, task 1.2: precomputed recovery for 0040's
  // CAMPAIGN_BUDGET_RACE - what this receipt prices at if EVERY
  // campaign-capped contribution were dropped instead, computed with the
  // SAME pure engine so `awardPoints`'s race recovery is never a second
  // implementation of the rule math. Present only when there is a capped
  // contribution to fall back FROM.
  let budgetRaceFallback: AwardPlan["budgetRaceFallback"] = null;
  if (raceFallbackApplied !== null) {
    const raceFallbackResult = computePoints({
      ...engineInputBase,
      candidateRules: raceFallbackApplied.map((candidate) => candidate.rule),
      dedupeFixedPerVisit,
    });
    budgetRaceFallback = {
      points: raceFallbackResult.points,
      ruleSnapshot: enrichRuleSnapshot({
        snapshot: raceFallbackResult.ruleSnapshot,
        now: deps.now(),
        receipt,
        applied: raceFallbackApplied,
        campaigns,
        // Review fix (task 1.2, M6): this variant's snapshot must ALSO
        // record the campaigns dropped BECAUSE of the race, not only the
        // advisory pass's own drops - otherwise a review reading this
        // snapshot alone would see a total that looks short with no
        // explanation for the missing points.
        budgetDropped: [...budgetDropped, ...raceDroppedEntries],
      }),
      campaignId:
        raceFallbackApplied.find((candidate) => candidate.campaignId !== null)?.campaignId ?? null,
    };
  }

  // Review fix (task 1.2, I2): the fourth plan variant - both the
  // fixed_per_visit dedupe AND every campaign-capped contribution dropped.
  // Precomputed only when BOTH races are actually reachable for this
  // receipt, so a compound race never falls back to a second implementation
  // of the rule math, and its zero-point provenance (I6) records both facts
  // rather than just one.
  let bothDroppedFallback: AwardPlan["bothDroppedFallback"] = null;
  if (verifyNoPriorFixedPerVisitEarn && raceFallbackApplied !== null) {
    const bothResult = computePoints({
      ...engineInputBase,
      candidateRules: raceFallbackApplied.map((candidate) => candidate.rule),
      dedupeFixedPerVisit: true,
    });
    bothDroppedFallback = {
      points: bothResult.points,
      ruleSnapshot: enrichRuleSnapshot({
        snapshot: bothResult.ruleSnapshot,
        now: deps.now(),
        receipt,
        applied: raceFallbackApplied,
        campaigns,
        budgetDropped: [...budgetDropped, ...raceDroppedEntries],
      }),
      campaignId:
        raceFallbackApplied.find((candidate) => candidate.campaignId !== null)?.campaignId ?? null,
    };
  }

  return {
    points: result.points,
    ruleSnapshot: enrichRuleSnapshot({
      snapshot: result.ruleSnapshot,
      now: deps.now(),
      receipt,
      applied: finalApplied,
      campaigns,
      budgetDropped,
    }),
    campaignId,
    // Doc 35 section 3 sets expires_at from "the base rule's expiry setting",
    // which lives under that doc's "Schema deltas proposed" and has no column
    // on `points_rules` (0012). Until that column exists there is no policy to
    // read, and null is the documented "never expires".
    expiresAt: null,
    verifyNoPriorFixedPerVisitEarn,
    dedupedFallback,
    budgetChecks,
    budgetRaceFallback,
    bothDroppedFallback,
    maxTotalPointsCampaignIds,
  };
}

/**
 * The ADVISORY half of the fixed_per_visit VISIT-DAY dedupe (doc 35 task
 * 1.1): does this consumer already have a PAID fixed_per_visit earn at this
 * business for this receipt's visit day? "Paid" excludes an earn whose own
 * fixed base was itself deduped to 0 (a prior receipt on the SAME visit day
 * that only collected an independent bonus must not suppress this one's
 * base too - I3). "Visit day" is doc 35's own definition,
 * `manila_day(coalesce(receipt_date, created_at))`, deliberately NOT
 * processing time: doc 35 says conditions are evaluated at `receipt_date`,
 * "never at processing time", and a human-reviewed receipt routinely lands a
 * day (or more) after the one it duplicates.
 *
 * Delegates to `public.fixed_per_visit_already_paid` (0038), a thin wrapper
 * over `private.fixed_per_visit_already_paid`, so this advisory check and the
 * RPC's own authoritative re-check (inside `award_receipt_points`, under the
 * `business_customers` lock) share ONE definition of the predicate rather
 * than two hand-maintained copies that could drift apart. `private.manila_day`
 * itself lives in the `private` schema, which PostgREST does not expose, so
 * there is no direct RPC route to it - this wrapper is the seam.
 *
 * Ordinary read, no lock - explicitly NOT race-safe on its own, which is why
 * `priceReceipt` also threads `verifyNoPriorFixedPerVisitEarn` through for the
 * RPC-side backstop. Fails OPEN to "not yet paid" on a read error, for the
 * same reason `priceReceipt` already does when the points_rules read itself
 * fails: the RPC-side verification this produces is the actual over-award
 * guard, not this read.
 */
async function hasPaidFixedPerVisitEarn(input: {
  supabase: SupabaseClient<Database>;
  businessId: string;
  consumerId: string;
  visitDay: string;
}): Promise<boolean> {
  const { data, error } = await input.supabase.rpc("fixed_per_visit_already_paid", {
    p_business_id: input.businessId,
    p_consumer_id: input.consumerId,
    p_visit_day: input.visitDay,
  });

  if (error !== null) {
    console.error(
      `[receipts/award] could not check for a prior paid fixed_per_visit earn for business ${input.businessId}; pricing as if not yet paid (0038's RPC-side check under the business_customers lock is the authoritative guard)`,
      error,
    );
    return false;
  }
  return data === true;
}

async function loadCampaigns(
  supabase: SupabaseClient<Database>,
  campaignIds: readonly string[],
): Promise<Map<string, CampaignRow>> {
  const campaigns = new Map<string, CampaignRow>();
  if (campaignIds.length === 0) return campaigns;

  const { data, error } = await supabase
    .from("campaigns")
    .select("id, type, status, starts_at, ends_at, timezone, priority, is_stackable, budget")
    .in("id", [...campaignIds])
    .is("deleted_at", null);

  if (error !== null) {
    console.error("[receipts/award] could not load campaigns for pricing", error);
    return campaigns;
  }
  for (const row of (data ?? []) as CampaignRow[]) {
    campaigns.set(row.id, row);
  }
  return campaigns;
}

function toEngineCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    type: row.type as CampaignType,
    // isCampaignLive only reads status/startsAt/endsAt; a status outside the
    // enum can never equal "active", so it is safely inert.
    status: row.status as Campaign["status"],
    startsAt: row.starts_at === null ? null : new Date(row.starts_at),
    endsAt: row.ends_at === null ? null : new Date(row.ends_at),
    timezone: row.timezone,
    budget: {},
  };
}

/**
 * `computePoints` returns the pure half of doc 35's frozen `rule_snapshot`
 * shape and says so in its own comment: "campaign_id, priority, and
 * is_stackable are added by the caller/service layer, which owns campaign
 * resolution". This is that caller. It also adds `computed_at` and the
 * `receipt` block, which the pure engine cannot know.
 */
function enrichRuleSnapshot(input: {
  snapshot: unknown;
  now: Date;
  receipt: AwardReceipt;
  applied: ReadonlyArray<{ campaignId: string | null; rule: PointsRule }>;
  campaigns: ReadonlyMap<string, CampaignRow>;
  /** Doc 34 section 5, task 1.2: every campaign-linked contribution this
   * receipt dropped for a budget reason, "so reviews can explain totals". */
  budgetDropped: ReadonlyArray<BudgetDrop>;
}): Json {
  const campaignByRuleId = new Map<string, CampaignRow | null>();
  for (const candidate of input.applied) {
    if (candidate.rule.id === undefined) continue;
    campaignByRuleId.set(
      candidate.rule.id,
      candidate.campaignId === null
        ? null
        : (input.campaigns.get(candidate.campaignId) ?? null),
    );
  }

  const decorate = (entries: unknown): Json => {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => {
      if (!isRecord(entry)) return toJson(entry);
      const ruleId = typeof entry.rule_id === "string" ? entry.rule_id : null;
      const campaign = ruleId === null ? undefined : campaignByRuleId.get(ruleId);
      return toJson({
        ...entry,
        campaign_id: campaign?.id ?? null,
        priority: campaign?.priority ?? null,
        is_stackable: campaign?.is_stackable ?? null,
      });
    }) as Json;
  };

  const base = isRecord(input.snapshot) ? input.snapshot : {};
  return toJson({
    ...base,
    computed_at: input.now.toISOString(),
    receipt: {
      id: input.receipt.id,
      total_centavos: input.receipt.totalCentavos,
      receipt_date: input.receipt.receiptDate?.toISOString() ?? null,
    },
    multipliers: decorate(base.multipliers),
    bonuses: decorate(base.bonuses),
    budget_dropped: input.budgetDropped.map((drop) => ({
      campaign_id: drop.campaignId,
      reason: drop.reason,
    })) as Json,
  });
}

// ---------------------------------------------------------------------------
// Campaign budget guardrails (doc 34 section 5, task 1.2)
// ---------------------------------------------------------------------------

/** Why a campaign-linked contribution was dropped entirely rather than
 * partially awarded (doc 34: "skip, do not partially award"). */
export interface BudgetDrop {
  campaignId: string;
  reason: "max_total_points" | "per_customer_limit";
}

interface CampaignBudgetCaps {
  maxTotalPoints: number | null;
  perCustomerLimit: number | null;
}

/** `campaigns.budget` jsonb, parsed per the budgetSchema (doc 34 section 5):
 * both keys optional, and a present key is only ever a positive integer -
 * anything else (a stale/hand-edited row) is treated as absent rather than
 * trusted. */
function parseCampaignBudget(budget: unknown): CampaignBudgetCaps {
  if (!isRecord(budget)) return { maxTotalPoints: null, perCustomerLimit: null };
  // Review fix (task 1.2, M5): Number.isInteger, not just Number.isFinite - a
  // hand-edited `100.5` must be treated as absent here rather than reach the
  // RPC's `::integer` cast and throw 22P02 into the award path.
  const toCap = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
  return {
    maxTotalPoints: toCap(budget.max_total_points),
    perCustomerLimit: toCap(budget.per_customer_limit),
  };
}

/**
 * The running total doc 34 section 5 defines for `max_total_points`,
 * CORRECTLY ATTRIBUTED (review C1, 0041's `private.campaign_points_awarded`):
 * the sum, over this business's earn rows, of what EACH row's own
 * `rule_snapshot` attributes to this campaign - never the row's whole-receipt
 * `points` column, which doc 34's naive formula wrongly used and which
 * charges a capped campaign for points a different campaign or the base rule
 * actually granted. One SQL aggregate (review I3), never an unbounded
 * fetch-all-rows-and-sum-in-JS.
 *
 * Returns null on a read failure so the caller can fail CLOSED (drop the
 * contribution) rather than risk an over-award on a total it could not
 * verify - the opposite posture from `hasPaidFixedPerVisitEarn`'s fail-open,
 * because THAT check has an unconditional RPC-side backstop (0038) while an
 * advisory budget read that fails open here could let an uncapped-looking
 * contribution reach the RPC with no `p_campaign_budget_checks` entry to
 * catch it.
 */
async function campaignPointsAwarded(
  supabase: SupabaseClient<Database>,
  businessId: string,
  campaignId: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("campaign_points_awarded", {
    p_business_id: businessId,
    p_campaign_id: campaignId,
  });

  if (error !== null) {
    console.error(
      `[receipts/award] could not sum awarded points for campaign ${campaignId}; dropping its contribution rather than risk an over-award`,
      error,
    );
    return null;
  }
  return typeof data === "number" ? data : null;
}

/**
 * Doc 34 section 5's award-time `per_customer_limit`, CORRECTLY ATTRIBUTED
 * (review C1, 0041's `private.campaign_customer_earn_count`): counts this
 * consumer's earn rows whose OWN `rule_snapshot` attributes a positive
 * contribution to this campaign - never rows that merely name it as the
 * receipt's primary `campaign_id`. Same fail-closed posture as
 * `campaignPointsAwarded` and for the same reason.
 */
async function campaignCustomerEarnCount(
  supabase: SupabaseClient<Database>,
  businessId: string,
  campaignId: string,
  consumerId: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc("campaign_customer_earn_count", {
    p_business_id: businessId,
    p_campaign_id: campaignId,
    p_consumer_id: consumerId,
  });

  if (error !== null) {
    console.error(
      `[receipts/award] could not count prior positive earns for campaign ${campaignId}/consumer ${consumerId}; dropping its contribution rather than risk an over-award`,
      error,
    );
    return null;
  }
  return typeof data === "number" ? data : null;
}

interface CampaignBudgetResolution {
  /** `applied`, minus every candidate whose campaign's contribution was
   * dropped entirely for a budget reason. */
  finalApplied: Array<{ campaignId: string | null; rule: PointsRule }>;
  budgetDropped: BudgetDrop[];
  /** Surviving campaign-capped contributions, for 0040's authoritative
   * re-check (`AwardPlan.budgetChecks`). */
  budgetChecks: Array<{ campaignId: string; points: number }>;
  /** `finalApplied` with every campaign in `budgetChecks` ALSO dropped, for
   * `AwardPlan.budgetRaceFallback`; null when `budgetChecks` is empty (there
   * is nothing left a race could take away). */
  raceFallbackApplied: Array<{ campaignId: string | null; rule: PointsRule }> | null;
  maxTotalPointsCampaignIds: string[];
  /** Which campaign each candidate rule (by rule id) belongs to - exposed so
   * `priceReceipt` can recompute a DIFFERENT pricing pass's own per-campaign
   * contributions (review I2: `dedupedFallback`'s and `bothDroppedFallback`'s
   * own `budgetChecks`/`budget_dropped` must reflect THEIR OWN numbers, not
   * the primary pass's, since a deduped base changes every multiplier's
   * contribution). */
  campaignIdByRuleId: ReadonlyMap<string, string>;
  /** Every campaign id that carried EITHER cap and survived the advisory
   * drop (i.e. exactly the ids `budgetChecks` names) - the set a race-fallback
   * variant drops IN ADDITION to `budgetDropped` above. */
  cappedSurvivingIds: ReadonlySet<string>;
}

/**
 * Recomputes each named campaign's OWN contribution from a SPECIFIC pricing
 * pass's own raw `multipliers`/`bonuses` arrays (i.e. `computePoints`'s
 * un-enriched `ruleSnapshot`, before `enrichRuleSnapshot` decorates it).
 * Review fix (task 1.2, I2): a deduped base collapses every multiplier's
 * `points_delta` to 0 while leaving `bonus_points` untouched, so a capped
 * campaign's contribution DIFFERS between the primary pass and the deduped
 * fallback - `dedupedFallback.budgetChecks` must be computed from the
 * fallback's OWN snapshot, never copied from the primary pass's
 * `budgetChecks`.
 */
function contributionsForCampaigns(
  snapshot: unknown,
  campaignIdByRuleId: ReadonlyMap<string, string>,
  campaignIds: ReadonlySet<string>,
): Array<{ campaignId: string; points: number }> {
  const totals = new Map<string, number>();
  const add = (ruleId: unknown, amount: unknown): void => {
    if (typeof ruleId !== "string" || typeof amount !== "number") return;
    const campaignId = campaignIdByRuleId.get(ruleId);
    if (campaignId === undefined || !campaignIds.has(campaignId)) return;
    totals.set(campaignId, (totals.get(campaignId) ?? 0) + amount);
  };
  if (isRecord(snapshot)) {
    for (const entry of Array.isArray(snapshot.multipliers) ? snapshot.multipliers : []) {
      if (isRecord(entry)) add(entry.rule_id, entry.points_delta);
    }
    for (const entry of Array.isArray(snapshot.bonuses) ? snapshot.bonuses : []) {
      if (isRecord(entry)) add(entry.rule_id, entry.bonus_points);
    }
  }
  // Every named campaign id gets an entry, even 0 (a multiplier collapsed by
  // dedupe): the RPC re-check is harmless at 0 and this keeps the guarded set
  // identical across every variant rather than silently shrinking it.
  return [...campaignIds].map((campaignId) => ({
    campaignId,
    points: totals.get(campaignId) ?? 0,
  }));
}

/**
 * Doc 34 section 5's "the reason a race-fallback drop was made", for a
 * campaign in `cappedSurvivingIds` that a race-fallback variant drops IN
 * ADDITION to the advisory pass's own `budgetDropped` (review M6: the race
 * fallback's snapshot must record these too, not just the advisory drops).
 * A campaign with both caps set reports `max_total_points` first, since that
 * is the cap this receipt's OWN contribution actually threatens; a
 * `per_customer_limit`-only campaign was never going to be re-checked for
 * anything else.
 */
function raceDropReason(campaign: CampaignRow): BudgetDrop["reason"] {
  const caps = parseCampaignBudget(campaign.budget);
  return caps.maxTotalPoints !== null ? "max_total_points" : "per_customer_limit";
}

/**
 * Doc 34 section 5's two award-time budget guardrails, task 1.2:
 * `max_total_points` (a running cap across every consumer) and
 * `per_customer_limit` (this consumer's own count of prior positive earns
 * from this campaign). Given the FULL stacked candidate set and a TRIAL
 * pricing pass over it (`trialSnapshot`, so each campaign-linked rule's raw
 * contribution is read from the frozen snapshot the pure engine already
 * produced rather than a second implementation of the additive-extras
 * arithmetic), decides which campaigns' contributions must be dropped
 * ENTIRELY - doc 34: "skip, do not partially award" - and returns the
 * filtered candidate list plus what `awardPoints` needs for the RPC-side
 * race guard (0040) and the post-commit exhaustion pause.
 *
 * ADVISORY, exactly like `hasPaidFixedPerVisitEarn`: an ordinary, unlocked
 * read, priced as of this moment. `award_receipt_points` re-verifies every
 * surviving campaign-capped contribution under a `campaigns` row lock before
 * minting (0040) - this function only has to get the common, non-racing case
 * right, which is most receipts.
 */
async function resolveCampaignBudgets(input: {
  supabase: SupabaseClient<Database>;
  businessId: string;
  consumerId: string;
  applied: ReadonlyArray<{ campaignId: string | null; rule: PointsRule }>;
  campaigns: ReadonlyMap<string, CampaignRow>;
  trialSnapshot: unknown;
}): Promise<CampaignBudgetResolution> {
  const { supabase, businessId, consumerId, applied, campaigns, trialSnapshot } = input;

  // Which campaign each candidate rule belongs to, so the trial snapshot's
  // per-rule entries (keyed by rule_id) can be rolled up into a per-campaign
  // contribution total.
  const campaignIdByRuleId = new Map<string, string>();
  for (const candidate of applied) {
    if (candidate.campaignId !== null && candidate.rule.id !== undefined) {
      campaignIdByRuleId.set(candidate.rule.id, candidate.campaignId);
    }
  }

  const contributionByCampaign = new Map<string, number>();
  const addContribution = (ruleId: unknown, amount: unknown): void => {
    if (typeof ruleId !== "string" || typeof amount !== "number") return;
    const campaignId = campaignIdByRuleId.get(ruleId);
    if (campaignId === undefined) return;
    contributionByCampaign.set(campaignId, (contributionByCampaign.get(campaignId) ?? 0) + amount);
  };
  if (isRecord(trialSnapshot)) {
    for (const entry of Array.isArray(trialSnapshot.multipliers) ? trialSnapshot.multipliers : []) {
      if (isRecord(entry)) addContribution(entry.rule_id, entry.points_delta);
    }
    for (const entry of Array.isArray(trialSnapshot.bonuses) ? trialSnapshot.bonuses : []) {
      if (isRecord(entry)) addContribution(entry.rule_id, entry.bonus_points);
    }
  }

  const droppedCampaignIds = new Set<string>();
  const budgetDropped: BudgetDrop[] = [];
  const budgetChecks: Array<{ campaignId: string; points: number }> = [];
  const maxTotalPointsCampaignIds: string[] = [];
  const cappedSurvivingIds = new Set<string>();

  for (const [campaignId, contribution] of contributionByCampaign) {
    const campaign = campaigns.get(campaignId);
    if (campaign === undefined) continue;
    const caps = parseCampaignBudget(campaign.budget);
    if (caps.maxTotalPoints === null && caps.perCustomerLimit === null) continue;

    // Tracked regardless of outcome below: the post-commit exhaustion pause
    // (task 1.2, `pauseExhaustedCampaigns`) is about the CAMPAIGN's
    // cumulative state, not this one receipt's, so a campaign whose
    // contribution gets dropped here for either reason may still need it.
    if (caps.maxTotalPoints !== null) {
      maxTotalPointsCampaignIds.push(campaignId);
    }

    let dropped = false;

    if (caps.perCustomerLimit !== null) {
      const count = await campaignCustomerEarnCount(supabase, businessId, campaignId, consumerId);
      if (count === null || count >= caps.perCustomerLimit) {
        droppedCampaignIds.add(campaignId);
        budgetDropped.push({ campaignId, reason: "per_customer_limit" });
        dropped = true;
      }
    }

    if (!dropped && caps.maxTotalPoints !== null) {
      const awarded = await campaignPointsAwarded(supabase, businessId, campaignId);
      if (awarded === null || awarded + contribution > caps.maxTotalPoints) {
        droppedCampaignIds.add(campaignId);
        budgetDropped.push({ campaignId, reason: "max_total_points" });
        dropped = true;
      }
    }

    // Review fix (task 1.2, I1): armed whenever EITHER cap is configured and
    // survived, not only max_total_points - a per_customer_limit-only
    // campaign must reach 0040's RPC-side re-check too, or nothing under the
    // business_customers lock ever verifies it (two concurrent receipts for
    // the same consumer could both pass the unlocked advisory read above).
    if (!dropped) {
      budgetChecks.push({ campaignId, points: contribution });
      cappedSurvivingIds.add(campaignId);
    }
  }

  const finalApplied = applied.filter(
    (candidate) => candidate.campaignId === null || !droppedCampaignIds.has(candidate.campaignId),
  );

  const raceFallbackApplied =
    cappedSurvivingIds.size === 0
      ? null
      : finalApplied.filter(
          (candidate) =>
            candidate.campaignId === null || !cappedSurvivingIds.has(candidate.campaignId),
        );

  return {
    finalApplied,
    budgetDropped,
    budgetChecks,
    raceFallbackApplied,
    maxTotalPointsCampaignIds,
    campaignIdByRuleId,
    cappedSurvivingIds,
  };
}

// ---------------------------------------------------------------------------
// The two RPCs
// ---------------------------------------------------------------------------

/**
 * Every P0001 message 0018, 0023 and 0037/0038 raise, verified against the
 * migrations line by line. 0023 deliberately introduces no new string: it
 * reuses RECEIPT_NOT_AWARDABLE, AWARD_RECEIPT_ID_REQUIRED and
 * CUSTOMER_RECORD_MISSING so both RPCs share one taxonomy and one severity
 * map. 0037 (task 1.1, fixed_per_visit dedupe) adds exactly one:
 * FIXED_PER_VISIT_RACE, raised by award_receipt_points only when the caller
 * sets p_verify_no_prior_fixed_visit_earn; 0038 changes what that check keys
 * on (visit day, not processing day - see `hasPaidFixedPerVisitEarn`) but
 * introduces no new message.
 *
 * Note this map is NOT the whole story for FIXED_PER_VISIT_RACE: unlike every
 * other code here, it is not a terminal refusal. `awardPoints` intercepts it
 * before it would ever reach `refuseRpc` and recovers via
 * `awardAfterFixedPerVisitRace` (C2 fix) instead of stranding the receipt.
 * The entry stays in this map only as the documented severity for the rare
 * case that recovery itself fails and the error is genuinely surfaced.
 *
 * Each one is a distinct operational fact, and none of them may take a caller
 * down: the receipt is already 'approved' in the database by the time either
 * RPC is called, so the worst case is an approved receipt that needs support
 * attention, which is recoverable, whereas a thrown error would strand the
 * whole job (or, for the review service, lose the reviewer's decision after it
 * was already persisted).
 */
export const AWARD_ERROR_HANDLING: Record<string, AwardErrorSeverity> = {
  // The idempotent case: a replayed job, or a race between two workers. The
  // pt_receipt_earn_once index did its job and there is nothing to fix.
  RECEIPT_ALREADY_AWARDED: "info",
  // Someone moved the receipt out of 'approved' between our update and the
  // RPC, or nulled its business/user. Nothing was minted; a reviewer decides.
  RECEIPT_NOT_AWARDABLE: "warn",
  // Doc 37 ladder step 3. The blacklist is checked before routing, so reaching
  // here means the segment changed mid-flight.
  CUSTOMER_BLACKLISTED: "warn",
  CUSTOMER_RECORD_MISSING: "error",
  // Guarded against upstream (points > 0 is checked before calling), so this
  // is a bug in this file if it ever appears.
  AWARD_POINTS_INVALID: "error",
  AWARD_RECEIPT_ID_REQUIRED: "error",
  // 0037/0038 (task 1.1): kept here for documentation/completeness only.
  // Unlike every other entry in this map, this severity is never actually
  // LOOKED UP: `awardPoints` intercepts `error.message === "FIXED_PER_VISIT_RACE"`
  // before `refuseRpc` could ever be called with it, routing instead to
  // `awardAfterFixedPerVisitRace`; and that recovery path never calls
  // `refuseRpc` either - even a failed retry resolves through
  // `awardZeroPoints` (the zero-point path), not through this map. The entry
  // stays so the "every P0001 message this migration can raise is mapped"
  // contract (and its own test) stays complete, and so the severity
  // classification for this code is documented in one place even though it
  // is currently unreachable via `refuseRpc`.
  FIXED_PER_VISIT_RACE: "warn",
  // 0040 (task 1.2): raised only when the caller sends
  // p_campaign_budget_checks and the RPC's own re-check, under a `campaigns`
  // row lock, finds LESS room than `priceReceipt`'s unlocked advisory read
  // believed - a concurrent award against a DIFFERENT consumer having spent
  // the remaining `max_total_points` budget (or reached `per_customer_limit`)
  // in the gap between the two reads. Exactly the same non-terminal shape as
  // FIXED_PER_VISIT_RACE above: `awardPoints` intercepts it before `refuseRpc`
  // and recovers via `awardAfterCampaignBudgetRace`, replaying
  // `plan.budgetRaceFallback` (every campaign-capped contribution dropped)
  // rather than stranding the receipt or minting past a budget a concurrent
  // request already exhausted.
  CAMPAIGN_BUDGET_RACE: "warn",
  // Review fix (task 1.2, N5): synthetic, never raised by any RPC. Only
  // `awardPoints`'s own catch around `awardPointsInner` produces this
  // message, when that function's "NEVER THROWS" contract is somehow
  // violated. Documented here so it is a first-class member of this
  // taxonomy rather than a bare literal `refuseRpc` would otherwise look up
  // and silently default to "error" for anyway - the explicit entry is what
  // makes the default the DOCUMENTED severity rather than a coincidence.
  AWARD_INTERNAL_ERROR: "error",
};

/**
 * What a refused RPC costs, and how it is recorded. Shared by both calls
 * because the consequences are identical: nothing was rolled back, the receipt
 * keeps status='approved', and the operator needs to find it later.
 *
 * `notePrefix` is the only difference, and it exists so support can tell which
 * half failed: `award_failed:` means no ledger row, `visit_failed:` means no
 * CRM counter movement. Both leave `processed_at` null on an approved row,
 * which 0018 calls the difference between "approved and paid" and "approved,
 * award pending" and 0023 keeps meaning the same thing.
 */
async function refuseRpc(input: {
  deps: AwardDeps;
  receiptId: string;
  error: PostgrestFailure;
  notePrefix: string;
}): Promise<AwardResult> {
  const { deps, receiptId, error, notePrefix } = input;
  const severity = AWARD_ERROR_HANDLING[error.message] ?? "error";
  const line = `[receipts/award] ${notePrefix} for receipt ${receiptId}: ${error.message}`;
  if (severity === "info") {
    console.info(line);
  } else if (severity === "warn") {
    console.warn(line);
  } else {
    console.error(line, error);
  }

  // Only RECEIPT_ALREADY_AWARDED is benign; annotating it would put a scary
  // reject_note on a receipt that is correctly paid.
  if (severity !== "info") {
    const { error: noteError } = await deps.supabase
      .from("receipts")
      .update({ reject_note: `${notePrefix}:${error.message}` })
      .eq("id", receiptId);
    if (noteError !== null) {
      console.error(
        `[receipts/award] could not annotate the failed ${notePrefix} of ${receiptId}`,
        noteError,
      );
    }
  }

  return { kind: "refused", code: error.message, severity };
}

/**
 * The MONEY write. Everything before this point has been reversible; this is
 * the point where a consumer's balance changes.
 *
 * PRECONDITION: `receipts.status` is already 'approved' in the database, with
 * business_id and user_id set. 0018 step 2 checks exactly that under a row
 * lock and raises RECEIPT_NOT_AWARDABLE otherwise. See the module header for
 * why that write belongs to the caller.
 *
 * ZERO POINTS SKIPS THE LEDGER AND RECORDS THE VISIT INSTEAD. 0018 step 1
 * raises AWARD_POINTS_INVALID for `p_points <= 0`, and it is right to: a
 * zero-point earn row would violate the ledger's `points <> 0` check and would
 * say nothing. But zero is a legitimate outcome here, not a failure - a
 * business with no active base rule, an earning floor the receipt does not
 * clear (`min_amount_centavos`), or a tier table that stops below this amount
 * all price a real purchase at nothing. The receipt stays APPROVED because it
 * is approved: it is a genuine, validated purchase that belongs in the
 * consumer's history, in `receipts_biz_status_idx` reporting, and in the
 * store's analytics.
 *
 * What it must NOT do is skip the CRM half. Every `business_customers` counter
 * used to be maintained only inside 0018 step 6, so a tenant with no base rule
 * accumulated approved receipts whose pair rows never advanced: a wrong
 * customer list, a wrong lifetime spend, a wrong last-visit sort, and - because
 * `visit_count` stayed 0 - an `isFirstVisit` that was permanently true, so the
 * day that owner configured a `first_visit` bonus EVERY existing customer would
 * collect it. `record_receipt_visit` (0023) performs exactly that maintenance
 * with no ledger write, and this is the path that calls it.
 *
 * NEVER THROWS, for either caller.
 */
export async function awardPoints(input: {
  deps: AwardDeps;
  receiptId: string;
  plan: AwardPlan;
}): Promise<AwardResult> {
  // Review fix (task 1.2, M9/N5): wrapped so a broken "never throws" contract
  // somewhere inside `awardPointsInner` cannot silently skip the exhaustion
  // check below. This function's own doc says "NEVER THROWS, for either
  // caller" - if that promise is ever violated by a future change, the
  // pause/notify check still runs rather than being skipped along with it.
  //
  // N5: the caught error is routed through the SAME `refuseRpc` every other
  // refusal in this module uses, rather than a hand-built result literal -
  // so AWARD_INTERNAL_ERROR gets the same `reject_note` breadcrumb
  // (`award_failed:AWARD_INTERNAL_ERROR`) and the same severity lookup
  // (AWARD_ERROR_HANDLING above) as every other code, instead of silently
  // proceeding to the consumer notification unrecorded. The real thrown
  // value is logged separately, first, because `refuseRpc` only ever sees
  // the synthetic `{message: "AWARD_INTERNAL_ERROR"}` it is handed below,
  // never the actual exception/stack trace.
  let result: AwardResult;
  try {
    result = await awardPointsInner(input);
  } catch (error) {
    console.error(
      `[receipts/award] awardPointsInner threw unexpectedly for receipt ${input.receiptId}; this violates its own "never throws" contract`,
      error,
    );
    result = await refuseRpc({
      deps: input.deps,
      receiptId: input.receiptId,
      error: { message: "AWARD_INTERNAL_ERROR" },
      notePrefix: "award_failed",
    });
  }
  // Doc 34 section 5, task 1.2: the post-commit exhaustion pause. Runs AFTER
  // every path above has settled (awarded, refused, zero-point, or a race
  // recovery of either kind), because the check reads the CAMPAIGN's current
  // cumulative total - which, for a surviving contribution, only reflects
  // THIS receipt once its own RPC call has actually committed. Restricted to
  // `max_total_points`-capped campaigns this receipt considered
  // (`maxTotalPointsCampaignIds`, populated whether or not the contribution
  // survived - a drop can itself be the reason the campaign is now
  // exhausted); `per_customer_limit` alone is never exhaustion (doc 34).
  // `pauseExhaustedCampaigns` never throws and must not - the award above is
  // already committed and cannot be unwound by a pause/notify failure.
  if (input.plan.maxTotalPointsCampaignIds.length > 0) {
    await pauseExhaustedCampaigns(
      { supabase: input.deps.supabase },
      input.plan.maxTotalPointsCampaignIds,
    );
  }
  return result;
}

async function awardPointsInner(input: {
  deps: AwardDeps;
  receiptId: string;
  plan: AwardPlan;
}): Promise<AwardResult> {
  const { deps, receiptId, plan } = input;

  if (plan.points <= 0) {
    return awardZeroPoints({ deps, receiptId, points: plan.points, ruleSnapshot: plan.ruleSnapshot });
  }

  // 0018 declares p_campaign_id and p_expires_at as `default null`, and the
  // generated Args render a defaulted argument as OMITTABLE rather than
  // nullable. Omitting the key and sending null are the same call at the
  // function (the default IS null), so the keys are dropped when there is
  // nothing to say rather than the argument list being widened by hand.
  // p_verify_no_prior_fixed_visit_earn (0037/0038, default false) is omitted
  // the same way whenever the plan does not ask for it, which keeps this
  // call's argument list identical to 0018's original five keys for every
  // rule type other than fixed_per_visit. p_campaign_budget_checks (0040,
  // task 1.2) is omitted the same way whenever no surviving contribution is
  // campaign-capped.
  const { data, error } = await deps.supabase.rpc("award_receipt_points", {
    p_receipt_id: receiptId,
    p_points: plan.points,
    p_rule_snapshot: plan.ruleSnapshot,
    ...(plan.campaignId === null ? {} : { p_campaign_id: plan.campaignId }),
    ...(plan.expiresAt === null ? {} : { p_expires_at: plan.expiresAt }),
    ...(plan.verifyNoPriorFixedPerVisitEarn
      ? { p_verify_no_prior_fixed_visit_earn: true }
      : {}),
    ...(plan.budgetChecks.length > 0
      ? {
          p_campaign_budget_checks: plan.budgetChecks.map((check) => ({
            campaign_id: check.campaignId,
            points: check.points,
          })),
        }
      : {}),
  });

  if (error !== null) {
    // C2 fix: FIXED_PER_VISIT_RACE is not a terminal refusal. It means a
    // concurrent request's earn for the SAME visit day became visible under
    // the lock between our precheck and this call - the prior earn is now a
    // committed fact, so replaying `plan.dedupedFallback` (computed by the
    // same pure engine, never recomputed in SQL) is authoritative, not a
    // guess.
    if (error.message === "FIXED_PER_VISIT_RACE") {
      return awardAfterFixedPerVisitRace({ deps, receiptId, plan });
    }
    // 0040 (task 1.2): the same non-terminal shape, for the campaign-budget
    // guard - see CAMPAIGN_BUDGET_RACE's own doc comment on
    // AWARD_ERROR_HANDLING above.
    if (error.message === "CAMPAIGN_BUDGET_RACE") {
      return awardAfterCampaignBudgetRace({ deps, receiptId, plan });
    }
    return refuseRpc({ deps, receiptId, error, notePrefix: "award_failed" });
  }

  // 0018 step 6b keeps the CRM counters in the same transaction as the ledger
  // row, so the awarding path needs no second call.
  console.info(
    `[receipts/award] receipt ${receiptId} awarded ${plan.points} points (ledger row ${String(data)})`,
  );
  return {
    kind: "awarded",
    points: plan.points,
    transactionId: typeof data === "string" ? data : null,
  };
}

/**
 * The zero-point path (0023's `record_receipt_visit`), extracted so both the
 * ordinary zero-price case and every race-recovery zero case (fixed_per_visit
 * C2, campaign budget task 1.2) call the exact same code. Also where C3 is
 * fixed, generalized by review I6: `rule_snapshot` is only ever persisted by
 * `award_receipt_points`, so a deduped-to-zero or budget-dropped-to-zero
 * receipt - which never reaches that RPC - would otherwise discard the
 * `fixed_per_visit_deduped`/`budget_dropped` facts entirely.
 * `persistAwardEvidenceMarker` merges them into `receipts.parse_meta`
 * instead, best-effort, after the visit is recorded.
 */
async function awardZeroPoints(input: {
  deps: AwardDeps;
  receiptId: string;
  points: number;
  ruleSnapshot: Json;
}): Promise<AwardResult> {
  const { deps, receiptId, points, ruleSnapshot } = input;

  const { error } = await deps.supabase.rpc("record_receipt_visit", {
    p_receipt_id: receiptId,
  });
  if (error !== null) {
    return refuseRpc({ deps, receiptId, error, notePrefix: "visit_failed" });
  }

  await persistAwardEvidenceMarker({ deps, receiptId, points, ruleSnapshot });

  console.info(
    `[receipts/award] receipt ${receiptId} priced at 0 points; visit recorded without a ledger row`,
  );
  return { kind: "skipped_zero_points" };
}

/**
 * C2 recovery for `FIXED_PER_VISIT_RACE`. The RPC's own re-check (under the
 * `business_customers` lock it already holds) found a prior paid
 * fixed_per_visit earn for this receipt's visit day that `priceReceipt`'s
 * unlocked precheck missed - almost always because a concurrent request for
 * the SAME pair committed that earn in the gap between the two. That prior
 * earn is now a committed, visible fact, so `plan.dedupedFallback` (computed
 * by `priceReceipt` with the SAME pure engine, `dedupeFixedPerVisit: true`)
 * is the authoritative repricing, not a second implementation of the rule
 * math and not a guess.
 *
 *   - fallback total <= 0 (the common case: nothing but the fixed base was on
 *     offer) -> the zero-point path, exactly as if `priceReceipt` had priced
 *     it that way from the start. Logged at `warn` (not the zero-point
 *     path's usual `info`), so a genuinely recovered race is grep-able and
 *     distinguishable from an ordinary zero-price receipt that was never in
 *     a race at all.
 *   - fallback total > 0 (an independent bonus still applies) -> retry
 *     `award_receipt_points` ONCE with the fallback's own points/snapshot.
 *     `p_verify_no_prior_fixed_visit_earn` is deliberately omitted: the prior
 *     earn that caused THIS race is precisely what the fallback already
 *     accounts for, so re-verifying would find that SAME earn and refuse
 *     again in a loop.
 *   - if that retry somehow still fails (any reason, including a second
 *     FIXED_PER_VISIT_RACE) - a `reject_note: award_retry_failed:<code>`
 *     breadcrumb is left on the receipt (best-effort) before a terminal
 *     fallback to the zero-point path, rather than ever returning to the
 *     stranded state this whole fix exists to close. The specific failure
 *     is logged and annotated, not silently lost.
 */
async function awardAfterFixedPerVisitRace(input: {
  deps: AwardDeps;
  receiptId: string;
  plan: AwardPlan;
}): Promise<AwardResult> {
  const { deps, receiptId, plan } = input;
  const fallback = plan.dedupedFallback;

  if (fallback === null || fallback.points <= 0) {
    // M-c (review): distinguish a REAL recovered race from an ordinary
    // zero-price receipt in the logs - `awardZeroPoints` below only ever
    // logs the generic "priced at 0 points" line, which would otherwise
    // read identically to a receipt that was never in a race at all.
    console.warn(
      `[receipts/award] fixed_per_visit race recovered for receipt ${receiptId}: a prior paid earn was confirmed for this visit day, falling back to 0 points (visit still recorded)`,
    );
    return awardZeroPoints({
      deps,
      receiptId,
      points: fallback?.points ?? 0,
      ruleSnapshot: fallback?.ruleSnapshot ?? plan.ruleSnapshot,
    });
  }

  const { data, error } = await deps.supabase.rpc("award_receipt_points", {
    p_receipt_id: receiptId,
    p_points: fallback.points,
    p_rule_snapshot: fallback.ruleSnapshot,
    ...(plan.campaignId === null ? {} : { p_campaign_id: plan.campaignId }),
    ...(plan.expiresAt === null ? {} : { p_expires_at: plan.expiresAt }),
    // Review fix (task 1.2, I2): the OTHER guard (campaign budget) must not
    // be silently dropped just because THIS retry is recovering from the
    // fixed_per_visit one. Re-armed with the dedupedFallback's OWN
    // contributions (recomputed against its deduped pricing, since a
    // deduped base collapses a capped multiplier's contribution to 0 while
    // leaving a capped bonus untouched) rather than reusing the primary
    // plan's `budgetChecks` verbatim.
    ...(fallback.budgetChecks.length > 0
      ? {
          p_campaign_budget_checks: fallback.budgetChecks.map((check) => ({
            campaign_id: check.campaignId,
            points: check.points,
          })),
        }
      : {}),
  });

  if (error !== null) {
    // Review fix (task 1.2, I2): a SECOND race - the campaign budget guard
    // tripping on THIS retry, or any other failure - falls through to the
    // EXISTING terminal path below. No third RPC attempt is made; instead the
    // zero-point path is priced/annotated from `bothDroppedFallback` when it
    // exists, so its provenance correctly records BOTH the dedupe and the
    // budget drop rather than just the one this function already knew about
    // (review I6).
    const terminal = plan.bothDroppedFallback ?? fallback;
    console.error(
      `[receipts/award] retry after FIXED_PER_VISIT_RACE failed for receipt ${receiptId}; falling back to the zero-point path rather than stranding it`,
      error,
    );
    // M-b (review): leave a row-level breadcrumb before the terminal
    // fallback swallows this specific failure into a generic
    // skipped_zero_points result, so support can still find WHY the retry
    // did not land just by reading the receipt. Best-effort, like every
    // other annotation in this module: logs and continues on its own
    // failure rather than turning a successful visit-record into a
    // reported error.
    const { error: noteError } = await deps.supabase
      .from("receipts")
      .update({ reject_note: `award_retry_failed:${error.message}` })
      .eq("id", receiptId);
    if (noteError !== null) {
      console.error(
        `[receipts/award] could not annotate the failed retry of ${receiptId}`,
        noteError,
      );
    }
    return awardZeroPoints({
      deps,
      receiptId,
      points: 0,
      ruleSnapshot: terminal.ruleSnapshot,
    });
  }

  console.info(
    `[receipts/award] receipt ${receiptId} awarded ${fallback.points} points after a fixed_per_visit dedupe race (ledger row ${String(data)})`,
  );
  return {
    kind: "awarded",
    points: fallback.points,
    transactionId: typeof data === "string" ? data : null,
  };
}

/**
 * Recovery for 0040's `CAMPAIGN_BUDGET_RACE` (doc 34 section 5, task 1.2),
 * the same shape as `awardAfterFixedPerVisitRace` above: the RPC's own
 * re-check, under a `campaigns` row lock, found LESS room in a campaign's
 * `max_total_points` budget (or the consumer already at `per_customer_limit`)
 * than `priceReceipt`'s unlocked advisory read believed - almost always
 * because a DIFFERENT consumer's concurrent award against the SAME campaign
 * committed in the gap between the two. `plan.budgetRaceFallback` (computed
 * by `priceReceipt` with the SAME pure engine, every campaign-capped
 * contribution dropped) is the authoritative repricing, not a second
 * implementation of the rule math and not a guess.
 *
 *   - fallback null or <= 0 (nothing survives once every capped campaign's
 *     contribution is gone) -> the zero-point path.
 *   - fallback > 0 (base and/or an uncapped candidate still applies) ->
 *     retry `award_receipt_points` ONCE with the fallback's own
 *     points/snapshot/campaignId. `p_campaign_budget_checks` is deliberately
 *     omitted: the fallback already dropped every campaign this receipt had
 *     anything to re-verify, so there is nothing left to check.
 *   - if that retry somehow still fails - the same `award_retry_failed`
 *     breadcrumb and terminal zero-point fallback as the fixed_per_visit
 *     recovery, rather than ever stranding the receipt.
 */
async function awardAfterCampaignBudgetRace(input: {
  deps: AwardDeps;
  receiptId: string;
  plan: AwardPlan;
}): Promise<AwardResult> {
  const { deps, receiptId, plan } = input;
  const fallback = plan.budgetRaceFallback;

  if (fallback === null || fallback.points <= 0) {
    console.warn(
      `[receipts/award] campaign budget race recovered for receipt ${receiptId}: a concurrent award exhausted a campaign this receipt's advisory check believed had room, falling back to ${fallback?.points ?? 0} points (visit still recorded)`,
    );
    return awardZeroPoints({
      deps,
      receiptId,
      points: fallback?.points ?? 0,
      ruleSnapshot: fallback?.ruleSnapshot ?? plan.ruleSnapshot,
    });
  }

  const { data, error } = await deps.supabase.rpc("award_receipt_points", {
    p_receipt_id: receiptId,
    p_points: fallback.points,
    p_rule_snapshot: fallback.ruleSnapshot,
    ...(fallback.campaignId === null ? {} : { p_campaign_id: fallback.campaignId }),
    ...(plan.expiresAt === null ? {} : { p_expires_at: plan.expiresAt }),
    // Review fix (task 1.2, I2): the OTHER guard (fixed_per_visit dedupe)
    // must not be silently dropped just because THIS retry is recovering
    // from the campaign budget race. `budgetRaceFallback` does not assume
    // dedupe (only the capped contributions are dropped), so if the primary
    // call still needed the RPC to verify no prior paid earn, this retry
    // needs the SAME verification - reusing `plan.verifyNoPriorFixedPerVisitEarn`
    // verbatim, since that fact depends only on the base rule and is
    // unaffected by which campaigns survived.
    ...(plan.verifyNoPriorFixedPerVisitEarn ? { p_verify_no_prior_fixed_visit_earn: true } : {}),
  });

  if (error !== null) {
    // Review fix (task 1.2, I2): a SECOND race - the fixed_per_visit guard
    // tripping on THIS retry, or any other failure - falls through to the
    // EXISTING terminal path below, priced/annotated from
    // `bothDroppedFallback` when it exists (same reasoning as the mirror
    // image in `awardAfterFixedPerVisitRace`).
    const terminal = plan.bothDroppedFallback ?? fallback;
    console.error(
      `[receipts/award] retry after CAMPAIGN_BUDGET_RACE failed for receipt ${receiptId}; falling back to the zero-point path rather than stranding it`,
      error,
    );
    const { error: noteError } = await deps.supabase
      .from("receipts")
      .update({ reject_note: `award_retry_failed:${error.message}` })
      .eq("id", receiptId);
    if (noteError !== null) {
      console.error(
        `[receipts/award] could not annotate the failed retry of ${receiptId}`,
        noteError,
      );
    }
    return awardZeroPoints({
      deps,
      receiptId,
      points: 0,
      ruleSnapshot: terminal.ruleSnapshot,
    });
  }

  console.info(
    `[receipts/award] receipt ${receiptId} awarded ${fallback.points} points after a campaign budget race (ledger row ${String(data)})`,
  );
  return {
    kind: "awarded",
    points: fallback.points,
    transactionId: typeof data === "string" ? data : null,
  };
}

/**
 * C3 fix, generalized (task 1.2, review I6): `rule_snapshot.base.
 * fixed_per_visit_deduped` and `rule_snapshot.budget_dropped` are only ever
 * written by `award_receipt_points`, so a zero-point award - which never
 * reaches that RPC - would silently discard whichever of those facts applies:
 * the ONE thing a review screen needs to explain why 0 was paid. Merges
 * `{ award: { total, fixed_per_visit_deduped, budget_dropped } }` into the
 * receipt's existing `parse_meta` (read-modify-write, since PostgREST cannot
 * express a partial jsonb merge from the client) whenever EITHER fact is
 * non-trivial. A no-op, not an error, when neither is (nothing to record) - a
 * receipt priced at 0 for an unrelated reason (no active base rule, an
 * earning floor) must not claim a dedupe or a drop that never happened.
 * Best-effort and never throws: this is provenance for humans, not a ledger
 * write, so a failure here logs and moves on rather than turning a
 * successful visit-record into a reported failure.
 */
async function persistAwardEvidenceMarker(input: {
  deps: AwardDeps;
  receiptId: string;
  points: number;
  ruleSnapshot: Json;
}): Promise<void> {
  const { deps, receiptId, points, ruleSnapshot } = input;
  if (!isRecord(ruleSnapshot)) return;
  const base = ruleSnapshot.base;
  const fixedPerVisitDeduped = isRecord(base) && base.fixed_per_visit_deduped === true;
  const budgetDropped = Array.isArray(ruleSnapshot.budget_dropped) ? ruleSnapshot.budget_dropped : [];
  if (!fixedPerVisitDeduped && budgetDropped.length === 0) return;

  const { data, error: readError } = await deps.supabase
    .from("receipts")
    .select("parse_meta")
    .eq("id", receiptId)
    .single();
  if (readError !== null) {
    console.error(
      `[receipts/award] could not read parse_meta to record award evidence for receipt ${receiptId}`,
      readError,
    );
    return;
  }

  const currentParseMeta = isRecord(data?.parse_meta) ? data.parse_meta : {};
  const mergedParseMeta = toJson({
    ...currentParseMeta,
    award: {
      total: points,
      fixed_per_visit_deduped: fixedPerVisitDeduped,
      budget_dropped: budgetDropped,
    },
  });

  const { error: writeError } = await deps.supabase
    .from("receipts")
    .update({ parse_meta: mergedParseMeta })
    .eq("id", receiptId);
  if (writeError !== null) {
    console.error(
      `[receipts/award] could not persist the award evidence marker for receipt ${receiptId}`,
      writeError,
    );
  }
}

/**
 * Price and award in one call, for callers that do not need the plan before
 * they write the row.
 *
 * PRECONDITION, identical to `awardPoints`: the receipt is ALREADY
 * 'approved' in the database. The human review service is the intended caller
 * - it persists the reviewer's corrected fields, `reviewed_by`, `reviewed_at`
 * and `status='approved'` in its own statement, then calls this with the
 * corrected values.
 *
 * The pipeline calls the two halves separately instead, because it has to know
 * whether points are due BEFORE it writes the row. Either way `processed_at`
 * belongs to the RPC (0018 step 7, 0023 step 3), so the caller leaves it null
 * on an approved receipt. This function is exactly
 * `awardPoints(await priceReceipt(...))` and duplicates none of it.
 */
export async function awardApprovedReceipt(input: {
  deps: AwardDeps;
  businessId: string;
  receipt: AwardReceipt;
  isFirstVisit: boolean;
}): Promise<AwardResult> {
  const plan = await priceReceipt(input);
  return awardPoints({ deps: input.deps, receiptId: input.receipt.id, plan });
}
