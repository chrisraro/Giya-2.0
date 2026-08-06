import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isCampaignLive } from "@/features/campaigns/lifecycle";
import type { Campaign, CampaignType } from "@/features/campaigns/types";
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
  dedupedFallback: { points: number; ruleSnapshot: Json } | null;
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

  // Shared by both computePoints calls below so the deduped fallback is
  // priced from the identical inputs as the primary result - the ONLY
  // difference between the two calls is dedupeFixedPerVisit itself.
  const engineInput = {
    amountCentavos: receipt.totalCentavos ?? 0,
    receiptDate,
    businessTimezone: timezone,
    baseRule,
    candidateRules: applied.map((candidate) => candidate.rule),
    visitContext: { isFirstVisit: input.isFirstVisit },
  };

  const result = computePoints({ ...engineInput, dedupeFixedPerVisit });

  // Doc 35 step 9: campaign_id on the ledger row is "the primary applied
  // campaign or null". `resolveStacking` already emitted the candidates in
  // campaign priority order, so the first one that names a campaign is it.
  const campaignId =
    applied.find((candidate) => candidate.campaignId !== null)?.campaignId ?? null;

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
  // that prior earn between this precheck and the RPC's lock.
  let dedupedFallback: AwardPlan["dedupedFallback"] = null;
  if (verifyNoPriorFixedPerVisitEarn) {
    const fallbackResult = computePoints({ ...engineInput, dedupeFixedPerVisit: true });
    dedupedFallback = {
      points: fallbackResult.points,
      ruleSnapshot: enrichRuleSnapshot({
        snapshot: fallbackResult.ruleSnapshot,
        now: deps.now(),
        receipt,
        applied,
        campaigns,
      }),
    };
  }

  return {
    points: result.points,
    ruleSnapshot: enrichRuleSnapshot({
      snapshot: result.ruleSnapshot,
      now: deps.now(),
      receipt,
      applied,
      campaigns,
    }),
    campaignId,
    // Doc 35 section 3 sets expires_at from "the base rule's expiry setting",
    // which lives under that doc's "Schema deltas proposed" and has no column
    // on `points_rules` (0012). Until that column exists there is no policy to
    // read, and null is the documented "never expires".
    expiresAt: null,
    verifyNoPriorFixedPerVisitEarn,
    dedupedFallback,
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
    .select("id, type, status, starts_at, ends_at, timezone, priority, is_stackable")
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
  });
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
  // rule type other than fixed_per_visit.
  const { data, error } = await deps.supabase.rpc("award_receipt_points", {
    p_receipt_id: receiptId,
    p_points: plan.points,
    p_rule_snapshot: plan.ruleSnapshot,
    ...(plan.campaignId === null ? {} : { p_campaign_id: plan.campaignId }),
    ...(plan.expiresAt === null ? {} : { p_expires_at: plan.expiresAt }),
    ...(plan.verifyNoPriorFixedPerVisitEarn
      ? { p_verify_no_prior_fixed_visit_earn: true }
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
 * ordinary zero-price case and the C2 race-recovery zero case call the exact
 * same code. Also where C3 is fixed: `rule_snapshot` is only ever persisted by
 * `award_receipt_points`, so a deduped-to-zero receipt - which never reaches
 * that RPC - would otherwise discard the `fixed_per_visit_deduped` fact
 * entirely. `persistFixedPerVisitDedupeMarker` merges it into
 * `receipts.parse_meta` instead, best-effort, after the visit is recorded.
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

  await persistFixedPerVisitDedupeMarker({ deps, receiptId, points, ruleSnapshot });

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
  });

  if (error !== null) {
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
      ruleSnapshot: fallback.ruleSnapshot,
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
 * C3 fix: `rule_snapshot.base.fixed_per_visit_deduped` is only ever written
 * by `award_receipt_points`, so a zero-point award - which never reaches that
 * RPC - would silently discard the ONE fact a review screen needs to explain
 * why 0 was paid. Merges `{ award: { total, fixed_per_visit_deduped: true } }`
 * into the receipt's existing `parse_meta` (read-modify-write, since
 * PostgREST cannot express a partial jsonb merge from the client) whenever
 * the snapshot says the dedupe actually fired. A no-op, not an error, when it
 * did not (nothing to record) - a receipt priced at 0 for an unrelated reason
 * (no active base rule, an earning floor) must not claim a dedupe that never
 * happened. Best-effort and never throws: this is provenance for humans, not
 * a ledger write, so a failure here logs and moves on rather than turning a
 * successful visit-record into a reported failure.
 */
async function persistFixedPerVisitDedupeMarker(input: {
  deps: AwardDeps;
  receiptId: string;
  points: number;
  ruleSnapshot: Json;
}): Promise<void> {
  const { deps, receiptId, points, ruleSnapshot } = input;
  if (!isRecord(ruleSnapshot)) return;
  const base = ruleSnapshot.base;
  if (!isRecord(base) || base.fixed_per_visit_deduped !== true) return;

  const { data, error: readError } = await deps.supabase
    .from("receipts")
    .select("parse_meta")
    .eq("id", receiptId)
    .single();
  if (readError !== null) {
    console.error(
      `[receipts/award] could not read parse_meta to record the fixed_per_visit dedupe for receipt ${receiptId}`,
      readError,
    );
    return;
  }

  const currentParseMeta = isRecord(data?.parse_meta) ? data.parse_meta : {};
  const mergedParseMeta = toJson({
    ...currentParseMeta,
    award: { total: points, fixed_per_visit_deduped: true },
  });

  const { error: writeError } = await deps.supabase
    .from("receipts")
    .update({ parse_meta: mergedParseMeta })
    .eq("id", receiptId);
  if (writeError !== null) {
    console.error(
      `[receipts/award] could not persist the fixed_per_visit dedupe marker for receipt ${receiptId}`,
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
