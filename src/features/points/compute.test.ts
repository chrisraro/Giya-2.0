import { describe, it, expect } from "vitest";

import { computePoints, deriveLocalDayTime } from "./compute";
import type { ComputePointsInput, PointsRule } from "./types";

// 2026-07-24 is a Friday. 04:40 UTC = 12:40 in Asia/Manila (UTC+8).
const FRIDAY_NOON_MANILA = new Date("2026-07-24T04:40:00Z");
const MANILA = "Asia/Manila";

const baseAmountRate = (overrides: Partial<PointsRule> = {}): PointsRule => ({
  id: "rule-base",
  kind: "base",
  rule_type: "amount_rate",
  rate_centavos_per_point: 100,
  rounding: "floor",
  ...overrides,
});

const input = (overrides: Partial<ComputePointsInput> = {}): ComputePointsInput => ({
  amountCentavos: 48500,
  receiptDate: FRIDAY_NOON_MANILA,
  businessTimezone: MANILA,
  baseRule: baseAmountRate(),
  candidateRules: [],
  ...overrides,
});

describe("deriveLocalDayTime", () => {
  it("maps a UTC instant to Manila wall clock (Friday 12:40)", () => {
    expect(deriveLocalDayTime(FRIDAY_NOON_MANILA, MANILA)).toEqual({
      weekday: 5,
      minutesOfDay: 12 * 60 + 40,
    });
  });

  it("crosses the date line: late Friday UTC is Saturday in Manila", () => {
    // 2026-07-24T18:30:00Z = 2026-07-25 02:30 Manila (Saturday)
    expect(deriveLocalDayTime(new Date("2026-07-24T18:30:00Z"), MANILA)).toEqual({
      weekday: 6,
      minutesOfDay: 150,
    });
  });

  it("handles local midnight exactly (Sunday 00:00 Manila)", () => {
    // 2026-07-25T16:00:00Z = 2026-07-26 00:00 Manila (Sunday)
    expect(deriveLocalDayTime(new Date("2026-07-25T16:00:00Z"), MANILA)).toEqual({
      weekday: 7,
      minutesOfDay: 0,
    });
  });

  it("respects other timezones (UTC and a DST-observing zone)", () => {
    expect(deriveLocalDayTime(FRIDAY_NOON_MANILA, "UTC")).toEqual({
      weekday: 5,
      minutesOfDay: 4 * 60 + 40,
    });
    // 2026-07-24T02:00:00Z = 2026-07-23 22:00 in New York (EDT, Thursday)
    expect(
      deriveLocalDayTime(new Date("2026-07-24T02:00:00Z"), "America/New_York"),
    ).toEqual({ weekday: 4, minutesOfDay: 22 * 60 });
  });
});

describe("computePoints: base rule types", () => {
  it("amount_rate: floor(48500 / 100) = 485", () => {
    const result = computePoints(input());
    expect(result.points).toBe(485);
    expect(result.breakdown).toEqual({
      basePoints: 485,
      multipliers: [],
      multiplierExtras: 0,
      bonusPoints: 0,
      total: 485,
    });
  });

  it("amount_rate: rate 500 means 100 pesos = 20 pts", () => {
    const result = computePoints(
      input({ amountCentavos: 10000, baseRule: baseAmountRate({ rate_centavos_per_point: 500 }) }),
    );
    expect(result.points).toBe(20);
  });

  it("fixed_per_visit awards fixed_points", () => {
    const rule: PointsRule = { kind: "base", rule_type: "fixed_per_visit", fixed_points: 10, rounding: "floor" };
    expect(computePoints(input({ baseRule: rule })).points).toBe(10);
  });

  it("fixed_per_receipt awards fixed_points", () => {
    const rule: PointsRule = { kind: "base", rule_type: "fixed_per_receipt", fixed_points: 7, rounding: "floor" };
    expect(computePoints(input({ baseRule: rule })).points).toBe(7);
  });

  describe("tiered_amount", () => {
    const tieredRule: PointsRule = {
      kind: "base",
      rule_type: "tiered_amount",
      tiers: [
        { minCentavos: 0, maxCentavos: 19999, points: 5 },
        { minCentavos: 20000, maxCentavos: 49999, points: 15 },
        { minCentavos: 50000, maxCentavos: null, points: 30 },
      ],
      rounding: "floor",
    };
    const at = (amountCentavos: number) =>
      computePoints(input({ amountCentavos, baseRule: tieredRule })).points;

    it("matches exactly at tier min", () => {
      expect(at(0)).toBe(5);
      expect(at(20000)).toBe(15);
      expect(at(50000)).toBe(30);
    });

    it("matches exactly at tier max (inclusive)", () => {
      expect(at(19999)).toBe(5);
      expect(at(49999)).toBe(15);
    });

    it("matches inside a tier and in the open-ended top tier", () => {
      expect(at(35000)).toBe(15);
      expect(at(9_999_999)).toBe(30);
    });

    it("returns 0 when no tier matches (gap or above a closed top tier)", () => {
      const gappy: PointsRule = {
        kind: "base",
        rule_type: "tiered_amount",
        tiers: [
          { minCentavos: 10000, maxCentavos: 19999, points: 5 },
          { minCentavos: 30000, maxCentavos: 39999, points: 10 },
        ],
        rounding: "floor",
      };
      const gapAt = (amountCentavos: number) =>
        computePoints(input({ amountCentavos, baseRule: gappy })).points;
      expect(gapAt(5000)).toBe(0); // below all tiers
      expect(gapAt(25000)).toBe(0); // in the gap between tiers
      expect(gapAt(50000)).toBe(0); // above a closed top tier
    });
  });
});

describe("computePoints: fixed_per_visit same-day dedupe", () => {
  const fixedVisit: PointsRule = {
    id: "rule-fixed-visit",
    kind: "base",
    rule_type: "fixed_per_visit",
    fixed_points: 10,
    rounding: "floor",
  };

  it("dedupeFixedPerVisit: true zeroes the base of a fixed_per_visit rule", () => {
    const result = computePoints(input({ baseRule: fixedVisit, dedupeFixedPerVisit: true }));
    expect(result.breakdown.basePoints).toBe(0);
    expect(result.points).toBe(0);
  });

  it("dedupeFixedPerVisit: false (or absent) pays the fixed amount normally", () => {
    expect(
      computePoints(input({ baseRule: fixedVisit, dedupeFixedPerVisit: false })).points,
    ).toBe(10);
    expect(computePoints(input({ baseRule: fixedVisit })).points).toBe(10);
  });

  it("has no effect on a non-fixed_per_visit base rule", () => {
    // fixed_per_receipt intentionally pays every receipt; the flag must not
    // leak into it.
    const perReceipt: PointsRule = { ...fixedVisit, rule_type: "fixed_per_receipt" };
    expect(
      computePoints(input({ baseRule: perReceipt, dedupeFixedPerVisit: true })).points,
    ).toBe(10);
    expect(
      computePoints(input({ baseRule: baseAmountRate(), dedupeFixedPerVisit: true })).points,
    ).toBe(485);
  });

  it("multiplier extras zero out too, since they are proportional to the zeroed base", () => {
    const friday2x: PointsRule = {
      kind: "multiplier",
      rule_type: "amount_rate",
      multiplier: 2,
      conditions: { days: [5] },
      rounding: "floor",
    };
    const result = computePoints(
      input({
        baseRule: fixedVisit,
        candidateRules: [friday2x],
        dedupeFixedPerVisit: true,
      }),
    );
    expect(result.breakdown.multipliers).toEqual([{ multiplier: 2, rounding: "floor", extra: 0 }]);
    expect(result.points).toBe(0);
  });

  it("an independent bonus still pays when the base is deduped to zero", () => {
    const bonus: PointsRule = { kind: "bonus", rule_type: "amount_rate", bonus_points: 15, rounding: "floor" };
    const result = computePoints(
      input({ baseRule: fixedVisit, candidateRules: [bonus], dedupeFixedPerVisit: true }),
    );
    expect(result.breakdown.basePoints).toBe(0);
    expect(result.breakdown.bonusPoints).toBe(15);
    expect(result.points).toBe(15);
  });

  it("does not dedupe a fixed_per_visit base that already fails its own conditions", () => {
    // The base is ineligible for its own reason (earning floor); dedupe would
    // be a no-op, and the snapshot should say WHY it is zero honestly.
    const flooredVisit: PointsRule = { ...fixedVisit, conditions: { min_amount_centavos: 999_999 } };
    const result = computePoints(input({ baseRule: flooredVisit, dedupeFixedPerVisit: true }));
    const snapshot = result.ruleSnapshot as { base: { eligible: boolean; fixed_per_visit_deduped: boolean } };
    expect(snapshot.base.eligible).toBe(false);
    expect(snapshot.base.fixed_per_visit_deduped).toBe(false);
  });

  it("records the dedupe decision on the frozen rule_snapshot", () => {
    const deduped = computePoints(input({ baseRule: fixedVisit, dedupeFixedPerVisit: true }));
    const notDeduped = computePoints(input({ baseRule: fixedVisit, dedupeFixedPerVisit: false }));
    const dedupedSnapshot = deduped.ruleSnapshot as { base: { fixed_per_visit_deduped: boolean; points: number } };
    const notDedupedSnapshot = notDeduped.ruleSnapshot as {
      base: { fixed_per_visit_deduped: boolean; points: number };
    };
    expect(dedupedSnapshot.base.fixed_per_visit_deduped).toBe(true);
    expect(dedupedSnapshot.base.points).toBe(0);
    expect(notDedupedSnapshot.base.fixed_per_visit_deduped).toBe(false);
    expect(notDedupedSnapshot.base.points).toBe(10);
  });

  it("a non-fixed_per_visit base always reports fixed_per_visit_deduped: false", () => {
    const result = computePoints(input());
    const snapshot = result.ruleSnapshot as { base: { fixed_per_visit_deduped: boolean } };
    expect(snapshot.base.fixed_per_visit_deduped).toBe(false);
  });
});

describe("computePoints: rounding modes on the base rule", () => {
  // 48550 / 100 = 485.5 (exact half); 48540 / 100 = 485.4
  it("floor rounds down", () => {
    expect(computePoints(input({ amountCentavos: 48550 })).points).toBe(485);
  });

  it("round is half-up", () => {
    const rule = baseAmountRate({ rounding: "round" });
    expect(computePoints(input({ amountCentavos: 48550, baseRule: rule })).points).toBe(486);
    expect(computePoints(input({ amountCentavos: 48540, baseRule: rule })).points).toBe(485);
  });

  it("ceil rounds up", () => {
    const rule = baseAmountRate({ rounding: "ceil" });
    expect(computePoints(input({ amountCentavos: 48510, baseRule: rule })).points).toBe(486);
    expect(computePoints(input({ amountCentavos: 48500, baseRule: rule })).points).toBe(485); // exact stays
  });
});

describe("computePoints: multipliers, bonuses, stacking", () => {
  const fridayDouble: PointsRule = {
    id: "rule-friday-2x",
    kind: "multiplier",
    rule_type: "amount_rate",
    multiplier: 2,
    conditions: { days: [5] },
    rounding: "floor",
  };

  it("doc worked example: PHP 485.00 on a Friday with a 2x Friday multiplier = 970", () => {
    const result = computePoints(input({ candidateRules: [fridayDouble] }));
    expect(result.points).toBe(970);
    expect(result.breakdown).toEqual({
      basePoints: 485,
      multipliers: [{ multiplier: 2, rounding: "floor", extra: 485 }],
      multiplierExtras: 485,
      bonusPoints: 0,
      total: 970,
    });
  });

  it("receipt-date semantics: a Friday receipt keeps the Friday multiplier regardless of processing time", () => {
    // The engine only ever sees receiptDate; recomputing later yields the same result.
    const first = computePoints(input({ candidateRules: [fridayDouble] }));
    const reprocessed = computePoints(input({ candidateRules: [fridayDouble] }));
    expect(reprocessed).toEqual(first);
  });

  it("stacks multipliers additively: 2x + 3x extras on base 485 = 1940", () => {
    const triple: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 3, rounding: "floor" };
    const result = computePoints(input({ candidateRules: [fridayDouble, triple] }));
    // extras: floor(485 * 1) = 485 and floor(485 * 2) = 970
    expect(result.breakdown.multipliers).toEqual([
      { multiplier: 2, rounding: "floor", extra: 485 },
      { multiplier: 3, rounding: "floor", extra: 970 },
    ]);
    expect(result.breakdown.multiplierExtras).toBe(1455);
    expect(result.points).toBe(1940);
  });

  it("rounds each multiplier extra with its own rule's rounding (fractional, floor)", () => {
    const bonus25: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 1.25, rounding: "floor" };
    const base: PointsRule = { kind: "base", rule_type: "fixed_per_receipt", fixed_points: 10, rounding: "floor" };
    const result = computePoints(input({ baseRule: base, candidateRules: [bonus25] }));
    // extra = floor(10 * 0.25) = 2; total = 10 + 2 = 12
    expect(result.breakdown.multipliers).toEqual([
      { multiplier: 1.25, rounding: "floor", extra: 2 },
    ]);
    expect(result.points).toBe(12);
  });

  it("doc divergence case: base 3 with two 1.5x floor multipliers = 5, not floor(3 * 2) = 6", () => {
    // 30000 centavos at rate 10000 -> base 3.
    const half1: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 1.5, rounding: "floor" };
    const half2: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 1.5, rounding: "floor" };
    const result = computePoints(
      input({
        amountCentavos: 30000,
        baseRule: baseAmountRate({ rate_centavos_per_point: 10000 }),
        candidateRules: [half1, half2],
      }),
    );
    // each extra = floor(3 * 0.5) = floor(1.5) = 1; total = 3 + 1 + 1 = 5
    expect(result.breakdown.basePoints).toBe(3);
    expect(result.breakdown.multipliers).toEqual([
      { multiplier: 1.5, rounding: "floor", extra: 1 },
      { multiplier: 1.5, rounding: "floor", extra: 1 },
    ]);
    expect(result.points).toBe(5);
  });

  it("honors a multiplier rule's ceil rounding: 1.25x ceil on base 485 = 607", () => {
    const promo: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 1.25, rounding: "ceil" };
    const result = computePoints(input({ candidateRules: [promo] }));
    // extra = ceil(485 * 0.25) = ceil(121.25) = 122; total = 485 + 122 = 607
    expect(result.breakdown.multipliers).toEqual([
      { multiplier: 1.25, rounding: "ceil", extra: 122 },
    ]);
    expect(result.points).toBe(607);
  });

  it("mixes rounding modes per rule: 2x floor + 1.5x ceil on base 485 = 1213", () => {
    const halfCeil: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 1.5, rounding: "ceil" };
    const result = computePoints(input({ candidateRules: [fridayDouble, halfCeil] }));
    // extras: floor(485 * 1) = 485 and ceil(485 * 0.5) = ceil(242.5) = 243
    // total = 485 + 485 + 243 = 1213
    expect(result.breakdown.multipliers).toEqual([
      { multiplier: 2, rounding: "floor", extra: 485 },
      { multiplier: 1.5, rounding: "ceil", extra: 243 },
    ]);
    expect(result.points).toBe(1213);
  });

  it("half-up rounding on a multiplier extra: 1.5x round on base 3 = 5", () => {
    const halfRound: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 1.5, rounding: "round" };
    const result = computePoints(
      input({
        amountCentavos: 30000,
        baseRule: baseAmountRate({ rate_centavos_per_point: 10000 }),
        candidateRules: [halfRound],
      }),
    );
    // extra = round(3 * 0.5) = round(1.5) = 2 (half-up); total = 3 + 2 = 5
    expect(result.breakdown.multipliers).toEqual([
      { multiplier: 1.5, rounding: "round", extra: 2 },
    ]);
    expect(result.points).toBe(5);
  });

  it("adds bonuses after multiplication (bonus is not multiplied)", () => {
    const base: PointsRule = { kind: "base", rule_type: "fixed_per_receipt", fixed_points: 100, rounding: "floor" };
    const bonus: PointsRule = { id: "rule-bonus", kind: "bonus", rule_type: "amount_rate", bonus_points: 50, rounding: "floor" };
    const result = computePoints(input({ baseRule: base, candidateRules: [fridayDouble, bonus] }));
    expect(result.breakdown).toEqual({
      basePoints: 100,
      multipliers: [{ multiplier: 2, rounding: "floor", extra: 100 }],
      multiplierExtras: 100,
      bonusPoints: 50,
      total: 250,
    });
  });

  it("sums multiple eligible bonuses", () => {
    const b1: PointsRule = { kind: "bonus", rule_type: "amount_rate", bonus_points: 50, rounding: "floor" };
    const b2: PointsRule = { kind: "bonus", rule_type: "amount_rate", bonus_points: 25, rounding: "floor" };
    expect(computePoints(input({ candidateRules: [b1, b2] })).points).toBe(485 + 75);
  });

  it("excludes candidates whose conditions fail", () => {
    const saturdayOnly: PointsRule = {
      kind: "multiplier",
      rule_type: "amount_rate",
      multiplier: 5,
      conditions: { days: [6] },
      rounding: "floor",
    };
    const result = computePoints(input({ candidateRules: [saturdayOnly] }));
    expect(result.breakdown.multipliers).toEqual([]);
    expect(result.breakdown.multiplierExtras).toBe(0);
    expect(result.points).toBe(485);
  });

  it("no candidates: base only", () => {
    const result = computePoints(input());
    expect(result.points).toBe(485);
    expect(result.breakdown.multipliers).toEqual([]);
    expect(result.breakdown.multiplierExtras).toBe(0);
    expect(result.breakdown.bonusPoints).toBe(0);
  });

  it("gates birthday rules on visitContext.isBirthday", () => {
    const birthday5x: PointsRule = {
      kind: "multiplier",
      rule_type: "amount_rate",
      multiplier: 5,
      conditions: { birthday: true },
      rounding: "floor",
    };
    expect(
      computePoints(input({ candidateRules: [birthday5x], visitContext: { isBirthday: true } })).points,
    ).toBe(485 * 5);
    expect(
      computePoints(input({ candidateRules: [birthday5x], visitContext: { isBirthday: false } })).points,
    ).toBe(485);
    expect(computePoints(input({ candidateRules: [birthday5x] })).points).toBe(485);
  });

  it("gates first_visit rules on visitContext.isFirstVisit", () => {
    const welcome: PointsRule = {
      kind: "bonus",
      rule_type: "amount_rate",
      bonus_points: 100,
      conditions: { first_visit: true },
      rounding: "floor",
    };
    expect(
      computePoints(input({ candidateRules: [welcome], visitContext: { isFirstVisit: true } })).points,
    ).toBe(585);
    expect(computePoints(input({ candidateRules: [welcome] })).points).toBe(485);
  });

  it("applies time-window conditions using the business timezone wall clock", () => {
    const lunchOnly: PointsRule = {
      kind: "multiplier",
      rule_type: "amount_rate",
      multiplier: 2,
      conditions: { time_from: "11:00", time_to: "14:00" },
      rounding: "floor",
    };
    // 04:40 UTC is 12:40 Manila (inside) but 04:40 UTC wall clock (outside).
    expect(computePoints(input({ candidateRules: [lunchOnly] })).points).toBe(970);
    expect(
      computePoints(input({ candidateRules: [lunchOnly], businessTimezone: "UTC" })).points,
    ).toBe(485);
  });

  it("respects a base rule's own conditions (earning floor)", () => {
    const flooredBase = baseAmountRate({ conditions: { min_amount_centavos: 50000 } });
    const bonus: PointsRule = { kind: "bonus", rule_type: "amount_rate", bonus_points: 10, rounding: "floor" };
    const result = computePoints(input({ baseRule: flooredBase, candidateRules: [bonus] }));
    // Base fails its floor -> 0 base, but the independent bonus still applies.
    expect(result.breakdown.basePoints).toBe(0);
    expect(result.points).toBe(10);
  });

  it("clamps the total to zero when sub-1x multiplier extras outweigh the base", () => {
    const quarter: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 0.25, rounding: "floor" };
    const result = computePoints(input({ candidateRules: [quarter, { ...quarter }] }));
    // each extra = floor(485 * -0.75) = -364; 485 - 728 < 0 -> clamps to 0
    expect(result.breakdown.multiplierExtras).toBe(-728);
    expect(result.points).toBe(0);
  });

  it("always returns integers", () => {
    const odd: PointsRule = { kind: "multiplier", rule_type: "amount_rate", multiplier: 1.33, rounding: "floor" };
    const result = computePoints(input({ amountCentavos: 48533, candidateRules: [odd] }));
    expect(Number.isInteger(result.points)).toBe(true);
    expect(Number.isInteger(result.breakdown.multiplierExtras)).toBe(true);
    for (const m of result.breakdown.multipliers) {
      expect(Number.isInteger(m.extra)).toBe(true);
    }
    expect(result.points).toBeGreaterThanOrEqual(0);
  });
});

describe("computePoints: rule snapshot", () => {
  it("captures the applied rules and is deeply frozen", () => {
    const bonus: PointsRule = { id: "rule-bonus", kind: "bonus", rule_type: "amount_rate", bonus_points: 50, rounding: "floor" };
    const friday: PointsRule = {
      id: "rule-friday-2x",
      kind: "multiplier",
      rule_type: "amount_rate",
      multiplier: 2,
      conditions: { days: [5] },
      rounding: "floor",
    };
    const skipped: PointsRule = {
      id: "rule-saturday",
      kind: "multiplier",
      rule_type: "amount_rate",
      multiplier: 9,
      conditions: { days: [6] },
      rounding: "floor",
    };
    const { ruleSnapshot } = computePoints(input({ candidateRules: [friday, bonus, skipped] }));
    const snapshot = ruleSnapshot as {
      engine: string;
      base: { rule_id: string | null; points: number };
      multipliers: Array<{
        rule_id: string | null;
        multiplier: number;
        rounding: string;
        points_delta: number;
      }>;
      bonuses: Array<{ rule_id: string | null; bonus_points: number }>;
      total_points: number;
    };

    expect(snapshot.engine).toBe("points/v1");
    expect(snapshot.base.rule_id).toBe("rule-base");
    expect(snapshot.base.points).toBe(485);
    expect(snapshot.multipliers).toEqual([
      expect.objectContaining({
        rule_id: "rule-friday-2x",
        multiplier: 2,
        rounding: "floor",
        points_delta: 485,
      }),
    ]);
    expect(snapshot.bonuses).toEqual([
      expect.objectContaining({ rule_id: "rule-bonus", bonus_points: 50 }),
    ]);
    expect(snapshot.total_points).toBe(1020);

    expect(Object.isFrozen(ruleSnapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.base)).toBe(true);
    expect(Object.isFrozen(snapshot.multipliers)).toBe(true);
    expect(Object.isFrozen(snapshot.multipliers[0])).toBe(true);
  });
});

describe("computePoints: misconfigured rules fail loudly", () => {
  it("amount_rate without a positive rate throws", () => {
    const missing: PointsRule = { kind: "base", rule_type: "amount_rate", rounding: "floor" };
    expect(() => computePoints(input({ baseRule: missing }))).toThrow(/rate_centavos_per_point/);
    const zero = baseAmountRate({ rate_centavos_per_point: 0 });
    expect(() => computePoints(input({ baseRule: zero }))).toThrow(/rate_centavos_per_point/);
  });

  it("fixed rules without fixed_points throw", () => {
    const missing: PointsRule = { kind: "base", rule_type: "fixed_per_visit", rounding: "floor" };
    expect(() => computePoints(input({ baseRule: missing }))).toThrow(/fixed_points/);
  });

  it("tiered_amount without tiers throws", () => {
    const missing: PointsRule = { kind: "base", rule_type: "tiered_amount", rounding: "floor" };
    expect(() => computePoints(input({ baseRule: missing }))).toThrow(/tiers/);
  });
});
