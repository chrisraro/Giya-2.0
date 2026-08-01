import { formatPeso } from "@/lib/money";

// ===========================================================================
// The implied economics of a reward: how much a customer has to spend before
// they can claim it.
//
// WHY THIS EXISTS. The rewards form already refuses the configurations
// `claim_reward` would refuse forever (server/service.ts). It says nothing at
// all about the configurations that are perfectly claimable and lose the
// merchant money on every claim. Earning rate and points cost are set on two
// different screens, weeks apart, and neither one shows what the other implies:
// "2 points per peso" sounds generous, "250 points" is a round number, and
// together they hand out a PHP 145 drink for PHP 125 of spend.
//
// So this module states the consequence and nothing else. It is NOT a
// validation, it has no threshold, and it never refuses: a loss leader is a
// legitimate acquisition strategy and a product that argues with it is wrong.
// The merchant reads the number next to a price they already know and decides.
//
// PURE. No IO, no React, no clock. `formatPeso` is the only import, because a
// second peso formatter is how two screens start disagreeing about money.
//
// ---------------------------------------------------------------------------
// THE INVERSION
//
// src/features/points/compute.ts is the authority, and the arithmetic below is
// derived from `computeBasePoints` rather than assumed:
//
//   amount_rate       -> applyRounding(amountCentavos / rate, rounding)
//   fixed_per_visit   -> fixed_points, verbatim, no rounding applied
//   fixed_per_receipt -> fixed_points, verbatim, no rounding applied
//   tiered_amount     -> the matching tier's points, or 0 outside every tier
//
// Inverting `amount_rate` for the minimum spend A that awards P points:
//
//   floor: floor(A/r) >= P  <=>  A >= P*r                 -> A = P*r
//   round: round(A/r) >= P  <=>  A >= (2P-1)*r/2          -> A = ceil((2P-1)*r/2)
//   ceil:  ceil(A/r)  >= P  <=>  A > (P-1)*r              -> A = (P-1)*r + 1
//
// WHERE IT IS EXACT, and where it is not:
//
//   * floor, no conditions. Exact. A single receipt of exactly P*r awards
//     exactly P, and because floor throws away the remainder of every receipt,
//     splitting the same money across more receipts can only award less. P*r is
//     therefore both reachable and the true minimum. A figure worth stating.
//
//   * round or ceil. NOT exact, and the error runs downward. Under `ceil` any
//     receipt of one centavo awards a whole point, so P separate receipts reach
//     the reward for P centavos, nowhere near the single-receipt figure. The
//     number is still the honest single-receipt answer, so it is stated with
//     "about" and with the direction of the error named.
//
//   * conditions present. NOT exact, and the error runs upward: a receipt that
//     misses the rule's days, hours, or minimum amount awards nothing, so the
//     figure becomes a floor. Stated as "at least".
//
//   * tiered_amount. Not invertible without deciding which tier a customer
//     shops in, which is a guess about their behaviour rather than arithmetic.
//     No figure is offered at all.
//
// A confidently wrong peso figure is worse than a hedged one here, because the
// merchant is about to make a pricing decision on it.
//
// SCOPE: the BASE rule only. Multiplier and bonus campaigns can only accelerate
// a customer toward the reward, never slow them, so every figure below is the
// unaccelerated case. Saying so on the form would be a lecture; the numbers a
// merchant compares are the base ones.
// ===========================================================================

/** `points_rules.rounding`, the three modes `applyRounding` handles. */
type Rounding = "floor" | "round" | "ceil";

/**
 * A base earning rule reduced to what the inversion needs. Structural rather
 * than the `points_rules` row for the same reason as
 * `src/features/businesses/activation/types.ts:BaseRuleShape`: this module asks
 * one question of a rule and should not be coupled to the other fifteen
 * columns.
 */
export interface EarningRuleShape {
  ruleType: string;
  rateCentavosPerPoint: number | null;
  fixedPoints: number | null;
  rounding: string;
  hasTiers: boolean;
  /**
   * True when the rule's conditions can make a receipt award nothing, which
   * turns every figure below into a floor rather than an answer.
   */
  gated: boolean;
}

/**
 * How far the stated figure can be trusted.
 *
 *   exact    - the arithmetic inverts cleanly and the number is the answer.
 *   at_least - conditions can withhold points, so the real spend is >= this.
 *   about    - rounding can award points early, so the real spend can be < this.
 */
export type ImpliedSpendPrecision = "exact" | "at_least" | "about";

export type ImpliedSpend =
  /** Nothing worth saying: a free claim, or a points cost not yet typed. */
  | { kind: "silent" }
  /** No usable base rule, so no customer can reach any points cost at all. */
  | { kind: "no_rule" }
  | { kind: "spend"; centavos: number; precision: ImpliedSpendPrecision }
  | {
      kind: "visits";
      visits: number;
      per: "visit" | "receipt";
      precision: ImpliedSpendPrecision;
    }
  /** A figure so large that printing it would be noise rather than information. */
  | { kind: "beyond"; overCentavos: number }
  /** Tiered earning: invertible only by guessing which tier a customer shops in. */
  | { kind: "tiered" }
  /** A rule shape this module does not know how to invert. */
  | { kind: "unknown" };

/**
 * Above this the figure stops being a number a merchant can act on and starts
 * being a wall of digits. PHP 10,000,000 of spend for one reward is already
 * absurd by three orders of magnitude; the exact absurd value adds nothing.
 * It doubles as the overflow guard, since `MAX_POINTS_COST` (2,147,483,647)
 * times any real rate lands far above it.
 */
export const ABSURD_SPEND_CENTAVOS = 1_000_000_000;

function toRounding(value: string): Rounding {
  return value === "round" || value === "ceil" ? value : "floor";
}

/**
 * Minimum receipt total, in centavos, that awards `points` under an
 * `amount_rate` rule. Integer arithmetic throughout: the only division is by
 * two, applied to a value forced even first, which IEEE754 represents exactly.
 * Nothing here ever multiplies or divides a peso by 100.
 */
export function minSpendCentavos(
  points: number,
  rateCentavosPerPoint: number,
  rounding: Rounding,
): number {
  if (points <= 0) return 0;

  if (rounding === "ceil") {
    // ceil(A/r) >= P needs only to clear (P-1)*r, by a single centavo.
    return (points - 1) * rateCentavosPerPoint + 1;
  }

  if (rounding === "round") {
    // Half-up: A/r >= P - 0.5, i.e. 2A >= (2P-1)*r. Doubling first keeps the
    // half-centavo boundary in the integers.
    const doubled = (2 * points - 1) * rateCentavosPerPoint;
    if (!Number.isSafeInteger(doubled)) return Number.POSITIVE_INFINITY;
    return (doubled % 2 === 0 ? doubled : doubled + 1) / 2;
  }

  return points * rateCentavosPerPoint;
}

/** Points needed / points per visit, rounded up: the last visit still counts. */
export function minVisits(points: number, fixedPoints: number): number {
  const whole = Math.floor(points / fixedPoints);
  return points % fixedPoints === 0 ? whole : whole + 1;
}

function precisionFor(rounding: Rounding, gated: boolean): ImpliedSpendPrecision {
  // Rounding first: when both hedges apply the figure is wrong in both
  // directions at once, and "about" is the only claim that survives that.
  if (rounding !== "floor") return "about";
  return gated ? "at_least" : "exact";
}

/**
 * What this points cost implies, given the business's active base earning rule.
 *
 * `rule` of null means no active base rule. A rule that cannot award a number -
 * an `amount_rate` row with no rate, a `fixed_per_visit` row with no points -
 * is treated identically, mirroring `isUsableBaseRule` in
 * src/features/businesses/activation/presenter.ts: to a customer the two are
 * the same, a balance pinned at zero. A rate of zero or less joins them here
 * because `computeBasePoints` throws on it rather than awarding anything.
 */
export function impliedSpend(rule: EarningRuleShape | null, pointsCost: number): ImpliedSpend {
  if (!Number.isSafeInteger(pointsCost) || pointsCost <= 0) return { kind: "silent" };
  if (rule === null) return { kind: "no_rule" };

  const rounding = toRounding(rule.rounding);

  if (rule.ruleType === "amount_rate") {
    const rate = rule.rateCentavosPerPoint;
    if (rate === null || rate <= 0) return { kind: "no_rule" };

    const centavos = minSpendCentavos(pointsCost, rate, rounding);
    if (!Number.isSafeInteger(centavos) || centavos > ABSURD_SPEND_CENTAVOS) {
      return { kind: "beyond", overCentavos: ABSURD_SPEND_CENTAVOS };
    }
    return { kind: "spend", centavos, precision: precisionFor(rounding, rule.gated) };
  }

  if (rule.ruleType === "fixed_per_visit" || rule.ruleType === "fixed_per_receipt") {
    const fixed = rule.fixedPoints;
    if (fixed === null || fixed <= 0) return { kind: "no_rule" };

    // Spend is not an input to a fixed rule at all, so a peso figure would be
    // an invention. Visits are the exact inversion: `computeBasePoints` returns
    // fixed_points verbatim, with no rounding applied to it.
    return {
      kind: "visits",
      visits: minVisits(pointsCost, fixed),
      per: rule.ruleType === "fixed_per_visit" ? "visit" : "receipt",
      // Rounding is genuinely irrelevant here, so only conditions can hedge it.
      precision: rule.gated ? "at_least" : "exact",
    };
  }

  if (rule.ruleType === "tiered_amount") {
    return rule.hasTiers ? { kind: "tiered" } : { kind: "no_rule" };
  }

  return { kind: "unknown" };
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The sentence itself, or null when there is nothing honest and useful to say.
 *
 * Deliberately not a warning and deliberately not congratulation. It states one
 * fact and stops, so it reads as neither of the two things around it on the
 * form: a refusal, or a reward being celebrated.
 */
export function describeImpliedSpend(spend: ImpliedSpend): string | null {
  switch (spend.kind) {
    case "silent":
      return null;
    case "no_rule":
      return "Nobody can earn points yet. Set your earning rule on the Campaigns page, then this will show what the reward costs a customer.";
    case "spend": {
      const amount = formatPeso(spend.centavos);
      if (spend.precision === "at_least") {
        return `A customer reaches this after at least ${amount} of spend.`;
      }
      if (spend.precision === "about") {
        return `A customer reaches this after about ${amount} of spend.`;
      }
      return `A customer reaches this after ${amount} of spend.`;
    }
    case "visits": {
      const visits = countLabel(spend.visits, spend.per);
      return spend.precision === "exact"
        ? `A customer reaches this after ${visits}.`
        : `A customer reaches this after at least ${visits}.`;
    }
    case "beyond":
      return `A customer would need more than ${formatPeso(spend.overCentavos)} of spend to reach this.`;
    case "tiered":
      return "Your earning rule pays by spending tier, so how much a customer spends to reach this depends on the size of their visits.";
    case "unknown":
      return "Your earning rule decides how much a customer spends to reach this.";
  }
}

/**
 * The second line: WHY the figure is hedged, in the merchant's terms.
 *
 * Split from the sentence so the list can show the claim without the footnote.
 * "About PHP 125" is already honest on its own; the explanation is what turns
 * it from a hedge into something the merchant can act on, and that belongs
 * where they are actually setting the number.
 */
export function impliedSpendNote(spend: ImpliedSpend): string | null {
  if (spend.kind !== "spend" && spend.kind !== "visits") return null;
  if (spend.precision === "exact") return null;

  if (spend.precision === "about") {
    return "Your earning rule rounds part-points up, so a customer can get there for less.";
  }
  return "Your earning rule does not pay on every visit, so it can take more.";
}

/**
 * Maps a `points_rules` row onto the shape above. Structural in its parameter
 * so this module never imports the generated database types.
 *
 * `gated` mirrors `evaluateConditions` in src/features/points/conditions.ts key
 * for key: days, the time window, and a minimum amount always gate, while
 * `birthday` and `first_visit` gate only when true, because a saved-but-false
 * flag is a no-op there and must not be one here either.
 */
export function toEarningRuleShape(rule: {
  rule_type: string;
  rate_centavos_per_point: number | null;
  fixed_points: number | null;
  rounding: string;
  tiers: unknown;
  conditions: unknown;
}): EarningRuleShape {
  return {
    ruleType: rule.rule_type,
    rateCentavosPerPoint: rule.rate_centavos_per_point,
    fixedPoints: rule.fixed_points,
    rounding: rule.rounding,
    hasTiers: Array.isArray(rule.tiers) && rule.tiers.length > 0,
    gated: hasGatingConditions(rule.conditions),
  };
}

const ALWAYS_GATING_KEYS = ["days", "time_from", "time_to", "min_amount_centavos"];
const GATING_WHEN_TRUE_KEYS = ["birthday", "first_visit"];

function hasGatingConditions(conditions: unknown): boolean {
  if (conditions === null || typeof conditions !== "object" || Array.isArray(conditions)) {
    return false;
  }
  const record = conditions as Record<string, unknown>;

  if (ALWAYS_GATING_KEYS.some((key) => record[key] !== undefined && record[key] !== null)) {
    return true;
  }
  return GATING_WHEN_TRUE_KEYS.some((key) => record[key] === true);
}
