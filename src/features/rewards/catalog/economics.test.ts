import { describe, it, expect } from "vitest";

import { computePoints } from "@/features/points/compute";
import type { PointsRule, RoundingMode } from "@/features/points/types";

import {
  ABSURD_SPEND_CENTAVOS,
  describeImpliedSpend,
  impliedSpend,
  impliedSpendNote,
  minSpendCentavos,
  minVisits,
  toEarningRuleShape,
  type EarningRuleShape,
} from "./economics";

// The configuration this feature was written for, from the live database: a
// shop earning 1 point per 50 centavos (2 points per peso) with a 250-point
// reward, which is a PHP 145 drink handed over for PHP 125 of spend.
const SEEDED_RATE_CENTAVOS = 50;
const SEEDED_POINTS_COST = 250;

function rule(overrides: Partial<EarningRuleShape> = {}): EarningRuleShape {
  return {
    ruleType: "amount_rate",
    rateCentavosPerPoint: SEEDED_RATE_CENTAVOS,
    fixedPoints: null,
    rounding: "floor",
    hasTiers: false,
    gated: false,
    ...overrides,
  };
}

function sentenceFor(r: EarningRuleShape | null, pointsCost: number): string | null {
  return describeImpliedSpend(impliedSpend(r, pointsCost));
}

// ---------------------------------------------------------------------------
// The inversion, checked against the engine it inverts rather than against a
// formula restated in the test. `computePoints` is the authority; if its
// arithmetic ever changes, these fail rather than quietly agreeing with a copy.
// ---------------------------------------------------------------------------

function awardedPoints(
  amountCentavos: number,
  rateCentavosPerPoint: number,
  rounding: RoundingMode,
): number {
  const baseRule: PointsRule = {
    kind: "base",
    rule_type: "amount_rate",
    rate_centavos_per_point: rateCentavosPerPoint,
    rounding,
  };
  return computePoints({
    amountCentavos,
    receiptDate: new Date("2026-08-01T04:00:00.000Z"),
    businessTimezone: "Asia/Manila",
    baseRule,
    candidateRules: [],
  }).points;
}

describe("minSpendCentavos is the true inverse of computePoints", () => {
  const rates = [1, 33, 50, 100, 250];
  const pointsCosts = [1, 2, 7, 250, 999];
  const roundings: RoundingMode[] = ["floor", "round", "ceil"];

  for (const rounding of roundings) {
    it(`awards the points at the stated spend and not a centavo below it (${rounding})`, () => {
      for (const rate of rates) {
        for (const points of pointsCosts) {
          const spend = minSpendCentavos(points, rate, rounding);

          expect(Number.isInteger(spend)).toBe(true);
          expect(awardedPoints(spend, rate, rounding)).toBeGreaterThanOrEqual(points);
          if (spend > 0) {
            expect(awardedPoints(spend - 1, rate, rounding)).toBeLessThan(points);
          }
        }
      }
    });
  }

  it("is exactly points x rate under floor rounding, the house default", () => {
    expect(minSpendCentavos(SEEDED_POINTS_COST, SEEDED_RATE_CENTAVOS, "floor")).toBe(12_500);
  });

  it("clears the half-point boundary by one centavo under round-half-up", () => {
    // round(A/5) >= 3 needs A/5 >= 2.5, so 13 centavos and not 12.
    expect(minSpendCentavos(3, 5, "round")).toBe(13);
    expect(awardedPoints(13, 5, "round")).toBe(3);
    expect(awardedPoints(12, 5, "round")).toBe(2);
  });

  it("needs only a single centavo past the previous whole point under ceil", () => {
    expect(minSpendCentavos(3, 5, "ceil")).toBe(11);
  });
});

describe("the maths stays in integer centavos", () => {
  it("never produces a fractional centavo, including at half-point boundaries", () => {
    // Odd rates and half-up rounding are where a peso-denominated (÷100)
    // implementation would leak a fraction. formatPeso THROWS on a
    // non-integer, so describeImpliedSpend not throwing is itself the check.
    for (const rate of [1, 3, 7, 33, 99, 12_345]) {
      for (const points of [1, 2, 3, 17, 250]) {
        for (const rounding of ["floor", "round", "ceil"] as const) {
          const spend = minSpendCentavos(points, rate, rounding);
          expect(Number.isInteger(spend)).toBe(true);
          expect(() =>
            describeImpliedSpend(impliedSpend(rule({ rateCentavosPerPoint: rate, rounding }), points)),
          ).not.toThrow();
        }
      }
    }
  });

  it("keeps the odd-rate figure exact rather than rounding it to pesos", () => {
    // 7 points at 33 centavos each = 231 centavos = PHP 2.31, not PHP 2.
    expect(sentenceFor(rule({ rateCentavosPerPoint: 33 }), 7)).toBe(
      "A customer reaches this after ₱2.31 of spend.",
    );
  });

  it("counts visits with integer division that rounds the last one up", () => {
    expect(minVisits(250, 10)).toBe(25);
    expect(minVisits(251, 10)).toBe(26);
    expect(minVisits(1, 10)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------

describe("the seeded configuration", () => {
  it("states the PHP 125 of spend behind a 250-point reward at 2 points per peso", () => {
    expect(sentenceFor(rule(), SEEDED_POINTS_COST)).toBe(
      "A customer reaches this after ₱125.00 of spend.",
    );
  });

  it("claims no precision it does not have, and adds no footnote when it is exact", () => {
    const spend = impliedSpend(rule(), SEEDED_POINTS_COST);

    expect(spend).toEqual({ kind: "spend", centavos: 12_500, precision: "exact" });
    expect(impliedSpendNote(spend)).toBeNull();
  });

  it("follows the points cost as it changes", () => {
    expect(sentenceFor(rule(), 100)).toBe("A customer reaches this after ₱50.00 of spend.");
    expect(sentenceFor(rule(), 250)).toBe("A customer reaches this after ₱125.00 of spend.");
    expect(sentenceFor(rule(), 500)).toBe("A customer reaches this after ₱250.00 of spend.");
  });

  it("reads as a fact, not as a refusal: no threshold word anywhere in it", () => {
    const sentence = sentenceFor(rule(), SEEDED_POINTS_COST) ?? "";

    expect(sentence).not.toMatch(/too|cannot|warning|should|lose|loss/i);
  });
});

describe("hedging a figure that cannot be stated flat", () => {
  it("says 'about' when rounding can hand the points over early", () => {
    for (const rounding of ["round", "ceil"]) {
      const spend = impliedSpend(rule({ rounding }), SEEDED_POINTS_COST);

      expect(spend.kind === "spend" && spend.precision).toBe("about");
      expect(describeImpliedSpend(spend)).toMatch(/^A customer reaches this after about ₱/);
      expect(impliedSpendNote(spend)).toBe(
        "Your earning rule rounds part-points up, so a customer can get there for less.",
      );
    }
  });

  it("says 'at least' when conditions can withhold the points", () => {
    const spend = impliedSpend(rule({ gated: true }), SEEDED_POINTS_COST);

    expect(spend.kind === "spend" && spend.precision).toBe("at_least");
    expect(describeImpliedSpend(spend)).toBe(
      "A customer reaches this after at least ₱125.00 of spend.",
    );
    expect(impliedSpendNote(spend)).toBe(
      "Your earning rule does not pay on every visit, so it can take more.",
    );
  });

  it("falls back to 'about' when the figure is wrong in both directions at once", () => {
    const spend = impliedSpend(rule({ rounding: "ceil", gated: true }), SEEDED_POINTS_COST);

    expect(spend.kind === "spend" && spend.precision).toBe("about");
  });

  it("states no figure at all for a tiered rule, which is not invertible", () => {
    const sentence = sentenceFor(rule({ ruleType: "tiered_amount", hasTiers: true }), 250);

    expect(sentence).toBe(
      "Your earning rule pays by spending tier, so how much a customer spends to reach this depends on the size of their visits.",
    );
    expect(sentence).not.toMatch(/₱|\d/);
  });

  it("states no figure for a rule shape it does not know how to invert", () => {
    const sentence = sentenceFor(rule({ ruleType: "referral_bonus" }), 250);

    expect(sentence).toBe("Your earning rule decides how much a customer spends to reach this.");
  });
});

describe("rules that count visits rather than spend", () => {
  it("answers in visits for fixed_per_visit, because spend is not an input to it", () => {
    const visitRule = rule({ ruleType: "fixed_per_visit", rateCentavosPerPoint: null, fixedPoints: 10 });

    expect(sentenceFor(visitRule, 250)).toBe("A customer reaches this after 25 visits.");
    expect(sentenceFor(visitRule, 10)).toBe("A customer reaches this after 1 visit.");
  });

  it("answers in receipts for fixed_per_receipt", () => {
    const receiptRule = rule({
      ruleType: "fixed_per_receipt",
      rateCentavosPerPoint: null,
      fixedPoints: 5,
    });

    expect(sentenceFor(receiptRule, 250)).toBe("A customer reaches this after 50 receipts.");
  });

  it("hedges the visit count when conditions gate the rule", () => {
    const gatedVisits = rule({
      ruleType: "fixed_per_visit",
      rateCentavosPerPoint: null,
      fixedPoints: 10,
      gated: true,
    });

    expect(sentenceFor(gatedVisits, 250)).toBe("A customer reaches this after at least 25 visits.");
  });

  it("ignores rounding for a fixed rule, which computePoints never rounds", () => {
    const visitRule = rule({
      ruleType: "fixed_per_visit",
      rateCentavosPerPoint: null,
      fixedPoints: 10,
      rounding: "ceil",
    });

    expect(sentenceFor(visitRule, 250)).toBe("A customer reaches this after 25 visits.");
  });
});

describe("no active earning rule", () => {
  it("says customers cannot earn points yet and points at where to fix it", () => {
    expect(sentenceFor(null, 250)).toBe(
      "Nobody can earn points yet. Set your earning rule on the Campaigns page, then this will show what the reward costs a customer.",
    );
  });

  it("treats a rule that cannot award anything as no rule at all", () => {
    // Mirrors isUsableBaseRule: to a customer, a rate-less amount_rate row and
    // no row are the same thing, a balance pinned at zero. A rate of zero joins
    // them because computeBasePoints throws on it.
    expect(impliedSpend(rule({ rateCentavosPerPoint: null }), 250).kind).toBe("no_rule");
    expect(impliedSpend(rule({ rateCentavosPerPoint: 0 }), 250).kind).toBe("no_rule");
    expect(impliedSpend(rule({ rateCentavosPerPoint: -50 }), 250).kind).toBe("no_rule");
    expect(
      impliedSpend(rule({ ruleType: "fixed_per_visit", fixedPoints: null }), 250).kind,
    ).toBe("no_rule");
    expect(
      impliedSpend(rule({ ruleType: "tiered_amount", hasTiers: false }), 250).kind,
    ).toBe("no_rule");
  });
});

describe("degenerate input renders nothing rather than nonsense", () => {
  it("says nothing about a free reward", () => {
    expect(impliedSpend(rule(), 0)).toEqual({ kind: "silent" });
    expect(sentenceFor(rule(), 0)).toBeNull();
  });

  it("says nothing for an empty, fractional or negative points cost", () => {
    expect(sentenceFor(rule(), Number.NaN)).toBeNull();
    expect(sentenceFor(rule(), 12.5)).toBeNull();
    expect(sentenceFor(rule(), -250)).toBeNull();
    expect(sentenceFor(rule(), Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("stays silent about a free reward even with no earning rule", () => {
    expect(sentenceFor(null, 0)).toBeNull();
  });

  it("refuses to print an absurd figure, and says it is absurd instead", () => {
    // The largest cost the schema allows, at the seeded rate: PHP 1,073,741,823
    // of spend. Twelve digits of peso is noise, not information.
    const spend = impliedSpend(rule(), 2_147_483_647);

    expect(spend).toEqual({ kind: "beyond", overCentavos: ABSURD_SPEND_CENTAVOS });
    expect(describeImpliedSpend(spend)).toBe(
      "A customer would need more than ₱10,000,000.00 of spend to reach this.",
    );
  });

  it("does not overflow into a wrong figure on an extreme rate", () => {
    const spend = impliedSpend(
      rule({ rateCentavosPerPoint: Number.MAX_SAFE_INTEGER, rounding: "round" }),
      2_147_483_647,
    );

    expect(spend.kind).toBe("beyond");
  });
});

// ---------------------------------------------------------------------------
// Mapping the database row
// ---------------------------------------------------------------------------

describe("toEarningRuleShape", () => {
  function row(overrides: Record<string, unknown> = {}) {
    return {
      rule_type: "amount_rate",
      rate_centavos_per_point: SEEDED_RATE_CENTAVOS,
      fixed_points: null,
      rounding: "floor",
      tiers: null,
      conditions: {},
      ...overrides,
    };
  }

  it("carries the fields the inversion reads", () => {
    expect(toEarningRuleShape(row())).toEqual({
      ruleType: "amount_rate",
      rateCentavosPerPoint: SEEDED_RATE_CENTAVOS,
      fixedPoints: null,
      rounding: "floor",
      hasTiers: false,
      gated: false,
    });
  });

  it("counts a rule as gated exactly when evaluateConditions would withhold points", () => {
    expect(toEarningRuleShape(row({ conditions: { days: [1, 2] } })).gated).toBe(true);
    expect(toEarningRuleShape(row({ conditions: { min_amount_centavos: 20_000 } })).gated).toBe(true);
    expect(
      toEarningRuleShape(row({ conditions: { time_from: "08:00", time_to: "11:00" } })).gated,
    ).toBe(true);
    expect(toEarningRuleShape(row({ conditions: { birthday: true } })).gated).toBe(true);

    // false is a no-op in evaluateConditions, so it must be a no-op here too.
    expect(toEarningRuleShape(row({ conditions: { birthday: false } })).gated).toBe(false);
    expect(toEarningRuleShape(row({ conditions: { first_visit: false } })).gated).toBe(false);
    expect(toEarningRuleShape(row({ conditions: null })).gated).toBe(false);
  });

  it("reads tiers as present only when there is at least one", () => {
    expect(toEarningRuleShape(row({ tiers: [] })).hasTiers).toBe(false);
    expect(
      toEarningRuleShape(row({ tiers: [{ minCentavos: 0, maxCentavos: null, points: 1 }] })).hasTiers,
    ).toBe(true);
  });
});
