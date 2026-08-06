import { evaluateConditions } from "./conditions";
import type { ConditionContext } from "./conditions";
import type {
  ComputePointsInput,
  PointsResult,
  PointsRule,
  RoundingMode,
} from "./types";

// Pure points computation, per docs/30-modules/35-points-engine.md sections
// 2-4 and 11. ZERO IO: the award pipeline, the preview endpoint, and the
// consumer PWA all call this same function with rules they loaded themselves.
//
// Campaign liveness, audience, and budget filtering (34-campaign-engine.md)
// are the caller's job; candidateRules must arrive pre-filtered for those.
// This engine applies only the conditions DSL plus the arithmetic.

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

// Derive the receipt's wall-clock weekday and minutes-of-day in the business
// timezone, deterministically, using Intl.DateTimeFormat (works for any IANA
// zone, e.g. "Asia/Manila" = fixed UTC+8, no DST). Pure: same inputs always
// produce the same output. Throws RangeError on an invalid timezone id.
export function deriveLocalDayTime(
  receiptDate: Date,
  timeZone: string,
): { weekday: number; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(receiptDate);

  let weekday: number | undefined;
  let hour: number | undefined;
  let minute: number | undefined;
  for (const part of parts) {
    if (part.type === "weekday") weekday = WEEKDAY_TO_ISO[part.value];
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  if (weekday === undefined || hour === undefined || minute === undefined) {
    throw new Error(
      `Could not derive local day/time for timezone "${timeZone}"`,
    );
  }
  return { weekday, minutesOfDay: hour * 60 + minute };
}

function applyRounding(raw: number, mode: RoundingMode): number {
  switch (mode) {
    case "floor":
      return Math.floor(raw);
    case "round":
      // Math.round rounds halves toward +Infinity, which is exactly the
      // spec's half-up (0.5 -> 1). Sub-1x multipliers can produce negative
      // raw extras; halves still round up (-363.5 -> -363).
      return Math.round(raw);
    case "ceil":
      return Math.ceil(raw);
  }
}

// Base points per rule_type (doc 35 section 2). Misconfigured rules throw
// rather than silently awarding 0: rule validation happens at save time, so
// reaching here with a broken rule is a bug worth surfacing.
function computeBasePoints(rule: PointsRule, amountCentavos: number): number {
  switch (rule.rule_type) {
    case "amount_rate": {
      const rate = rule.rate_centavos_per_point;
      if (rate === undefined || rate <= 0) {
        throw new Error("amount_rate rule requires a positive rate_centavos_per_point");
      }
      return applyRounding(amountCentavos / rate, rule.rounding);
    }
    case "fixed_per_visit":
    case "fixed_per_receipt": {
      if (rule.fixed_points === undefined) {
        throw new Error(`${rule.rule_type} rule requires fixed_points`);
      }
      return rule.fixed_points;
    }
    case "tiered_amount": {
      if (rule.tiers === undefined) {
        throw new Error("tiered_amount rule requires tiers");
      }
      // Tier match is inclusive on both ends; maxCentavos null = open-ended
      // top tier. No matching tier (below the lowest min, inside a gap, or
      // above a closed top tier) awards 0: documented choice, since a closed
      // tier table expresses "nothing beyond this".
      for (const tier of rule.tiers) {
        if (
          amountCentavos >= tier.minCentavos &&
          (tier.maxCentavos === null || amountCentavos <= tier.maxCentavos)
        ) {
          return tier.points;
        }
      }
      return 0;
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// The award computation (doc 35 "Arithmetic (exact)" + doc 34 section 6
// additive-extras model):
//   1. base points from the base rule (its own conditions gate it; a failed
//      earning floor yields 0 base). base_points = round_base(raw_base) with
//      the BASE rule's rounding.
//   2. eligible candidates = multiplier/bonus rules whose conditions pass at
//      the receipt's wall clock in the business timezone.
//   3. each applied multiplier contributes its own extra:
//      extra_i = round_i(base_points * (multiplier_i - 1)) using THAT rule's
//      rounding column. Extras are summed per-rule-rounded; there is NO
//      single effective multiplier rounded once, and rounding never applies
//      to the running total.
//   4. bonuses contribute bonus_points verbatim: never multiplied, never
//      rounded.
//   5. TOTAL = max(0, base_points + sum(extra_i) + sum(bonus_points)),
//      always an integer >= 0.
export function computePoints(input: ComputePointsInput): PointsResult {
  const {
    amountCentavos,
    receiptDate,
    businessTimezone,
    baseRule,
    candidateRules,
    visitContext,
    dedupeFixedPerVisit,
  } = input;

  const { weekday, minutesOfDay } = deriveLocalDayTime(receiptDate, businessTimezone);
  const ctx: ConditionContext = {
    weekday,
    minutesOfDay,
    amountCentavos,
    ...(visitContext?.isBirthday !== undefined
      ? { isBirthday: visitContext.isBirthday }
      : {}),
    ...(visitContext?.isFirstVisit !== undefined
      ? { isFirstVisit: visitContext.isFirstVisit }
      : {}),
  };

  const baseEligible = evaluateConditions(baseRule.conditions ?? {}, ctx);
  // fixed_per_visit same-day dedupe (doc 35, task 1.1): only takes effect
  // when the base would otherwise contribute (baseEligible), the base IS a
  // fixed_per_visit rule, AND fixed_points is actually positive (M1: a rule
  // with fixed_points 0 or unset has nothing to suppress, so dedupe must not
  // claim it did; an unset fixed_points also has to reach computeBasePoints
  // below so its "requires fixed_points" throw still fires even when dedupe
  // was requested). A base that already fails its own conditions has
  // nothing to dedupe either, and the snapshot says so honestly rather than
  // claiming a dedupe that changed nothing.
  const fixedPerVisitDeduped =
    baseEligible &&
    baseRule.rule_type === "fixed_per_visit" &&
    baseRule.fixed_points !== undefined &&
    baseRule.fixed_points > 0 &&
    (dedupeFixedPerVisit ?? false);
  const basePoints =
    baseEligible && !fixedPerVisitDeduped ? computeBasePoints(baseRule, amountCentavos) : 0;

  const appliedMultipliers: Array<{ rule: PointsRule; multiplier: number }> = [];
  const appliedBonuses: Array<{ rule: PointsRule; bonusPoints: number }> = [];
  for (const rule of candidateRules) {
    if (!evaluateConditions(rule.conditions ?? {}, ctx)) continue;
    if (rule.kind === "multiplier" && rule.multiplier !== undefined) {
      appliedMultipliers.push({ rule, multiplier: rule.multiplier });
    } else if (rule.kind === "bonus" && rule.bonus_points !== undefined) {
      appliedBonuses.push({ rule, bonusPoints: rule.bonus_points });
    }
  }

  // Per-rule extras: each multiplier's contribution is rounded with its OWN
  // rounding mode, then the integer extras are summed (doc 35 arithmetic;
  // doc 34 section 6 additive-extras stacking).
  const multiplierBreakdowns = appliedMultipliers.map((m) => ({
    rule: m.rule,
    multiplier: m.multiplier,
    rounding: m.rule.rounding,
    extra: applyRounding(basePoints * (m.multiplier - 1), m.rule.rounding),
  }));
  const multiplierExtras = multiplierBreakdowns.reduce((sum, m) => sum + m.extra, 0);
  const bonusPoints = appliedBonuses.reduce((sum, b) => sum + b.bonusPoints, 0);
  const total = Math.max(0, basePoints + multiplierExtras + bonusPoints);

  // Frozen shape per doc 35 "rule_snapshot frozen shape". campaign_id,
  // priority, and is_stackable are added by the caller/service layer, which
  // owns campaign resolution; the pure engine does not see campaigns.
  const ruleSnapshot = deepFreeze({
    engine: "points/v1",
    amount_centavos: amountCentavos,
    receipt_date: receiptDate.toISOString(),
    timezone: businessTimezone,
    base: {
      rule_id: baseRule.id ?? null,
      rule_type: baseRule.rule_type,
      rounding: baseRule.rounding,
      eligible: baseEligible,
      points: basePoints,
      // Doc 35 task 1.1: true only when a fixed_per_visit base's own
      // fixed_points was suppressed because this consumer already earned at
      // this business earlier the same Manila day. Always present (rather
      // than omitted when inapplicable) so a review screen can read it
      // without first checking rule_type.
      fixed_per_visit_deduped: fixedPerVisitDeduped,
    },
    multipliers: multiplierBreakdowns.map((m) => ({
      rule_id: m.rule.id ?? null,
      multiplier: m.multiplier,
      rounding: m.rounding,
      points_delta: m.extra,
    })),
    bonuses: appliedBonuses.map((b) => ({
      rule_id: b.rule.id ?? null,
      bonus_points: b.bonusPoints,
    })),
    total_points: total,
  });

  return {
    points: total,
    breakdown: {
      basePoints,
      multipliers: multiplierBreakdowns.map((m) => ({
        multiplier: m.multiplier,
        rounding: m.rounding,
        extra: m.extra,
      })),
      multiplierExtras,
      bonusPoints,
      total,
    },
    ruleSnapshot,
  };
}
