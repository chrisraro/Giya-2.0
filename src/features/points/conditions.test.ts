import { describe, it, expect } from "vitest";

import { ruleConditionsSchema, evaluateConditions } from "./conditions";
import type { ConditionContext } from "./conditions";

// Base context: Friday (ISO 5) 12:40 local, PHP 485.00 receipt.
const ctx = (overrides: Partial<ConditionContext> = {}): ConditionContext => ({
  weekday: 5,
  minutesOfDay: 12 * 60 + 40,
  amountCentavos: 48500,
  ...overrides,
});

describe("ruleConditionsSchema", () => {
  it("accepts an empty object (always applies)", () => {
    expect(ruleConditionsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a fully populated valid object", () => {
    const result = ruleConditionsSchema.safeParse({
      days: [1, 5, 7],
      time_from: "11:00",
      time_to: "14:00",
      min_amount_centavos: 0,
      birthday: true,
      first_visit: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown keys (strict DSL)", () => {
    expect(ruleConditionsSchema.safeParse({ dayz: [5] }).success).toBe(false);
    expect(
      ruleConditionsSchema.safeParse({ days: [5], extra: true }).success,
    ).toBe(false);
  });

  it("rejects out-of-range, fractional, and empty days", () => {
    expect(ruleConditionsSchema.safeParse({ days: [0] }).success).toBe(false);
    expect(ruleConditionsSchema.safeParse({ days: [8] }).success).toBe(false);
    expect(ruleConditionsSchema.safeParse({ days: [1.5] }).success).toBe(false);
    expect(ruleConditionsSchema.safeParse({ days: [] }).success).toBe(false);
  });

  it("accepts boundary days 1 and 7", () => {
    expect(ruleConditionsSchema.safeParse({ days: [1, 7] }).success).toBe(true);
  });

  it("validates HH:MM strictly", () => {
    const both = (time_from: string, time_to: string) =>
      ruleConditionsSchema.safeParse({ time_from, time_to }).success;
    expect(both("00:00", "23:59")).toBe(true);
    expect(both("22:00", "02:00")).toBe(true); // midnight-spanning is valid
    expect(both("24:00", "01:00")).toBe(false);
    expect(both("9:00", "10:00")).toBe(false); // leading zero required
    expect(both("09:60", "10:00")).toBe(false);
    expect(both("0900", "1000")).toBe(false);
  });

  it("requires time_from and time_to together", () => {
    expect(ruleConditionsSchema.safeParse({ time_from: "11:00" }).success).toBe(false);
    expect(ruleConditionsSchema.safeParse({ time_to: "14:00" }).success).toBe(false);
  });

  it("rejects negative or fractional min_amount_centavos", () => {
    expect(ruleConditionsSchema.safeParse({ min_amount_centavos: -1 }).success).toBe(false);
    expect(ruleConditionsSchema.safeParse({ min_amount_centavos: 10.5 }).success).toBe(false);
    expect(ruleConditionsSchema.safeParse({ min_amount_centavos: 0 }).success).toBe(true);
  });

  it("rejects non-boolean birthday / first_visit", () => {
    expect(ruleConditionsSchema.safeParse({ birthday: "yes" }).success).toBe(false);
    expect(ruleConditionsSchema.safeParse({ first_visit: 1 }).success).toBe(false);
  });
});

describe("evaluateConditions", () => {
  it("empty conditions always pass", () => {
    expect(evaluateConditions({}, ctx())).toBe(true);
  });

  describe("days", () => {
    it("passes when weekday is in the list", () => {
      expect(evaluateConditions({ days: [5] }, ctx({ weekday: 5 }))).toBe(true);
      expect(evaluateConditions({ days: [1, 5, 7] }, ctx({ weekday: 7 }))).toBe(true);
    });

    it("fails when weekday is not in the list", () => {
      expect(evaluateConditions({ days: [6, 7] }, ctx({ weekday: 5 }))).toBe(false);
    });
  });

  describe("time windows (from inclusive, to exclusive)", () => {
    const window = { time_from: "11:00", time_to: "14:00" };

    it("passes inside the window", () => {
      expect(evaluateConditions(window, ctx({ minutesOfDay: 12 * 60 }))).toBe(true);
    });

    it("passes exactly at time_from (inclusive)", () => {
      expect(evaluateConditions(window, ctx({ minutesOfDay: 11 * 60 }))).toBe(true);
    });

    it("fails exactly at time_to (exclusive)", () => {
      expect(evaluateConditions(window, ctx({ minutesOfDay: 14 * 60 }))).toBe(false);
    });

    it("fails outside the window", () => {
      expect(evaluateConditions(window, ctx({ minutesOfDay: 10 * 60 }))).toBe(false);
      expect(evaluateConditions(window, ctx({ minutesOfDay: 15 * 60 }))).toBe(false);
    });

    it("spans midnight when from > to (22:00 to 02:00)", () => {
      const night = { time_from: "22:00", time_to: "02:00" };
      expect(evaluateConditions(night, ctx({ minutesOfDay: 23 * 60 }))).toBe(true);
      expect(evaluateConditions(night, ctx({ minutesOfDay: 1 * 60 }))).toBe(true);
      expect(evaluateConditions(night, ctx({ minutesOfDay: 22 * 60 }))).toBe(true); // at from, inclusive
      expect(evaluateConditions(night, ctx({ minutesOfDay: 2 * 60 }))).toBe(false); // at to, exclusive
      expect(evaluateConditions(night, ctx({ minutesOfDay: 12 * 60 }))).toBe(false);
      expect(evaluateConditions(night, ctx({ minutesOfDay: 0 }))).toBe(true); // midnight itself
    });

    it("treats from == to as an empty window (never passes)", () => {
      const empty = { time_from: "11:00", time_to: "11:00" };
      expect(evaluateConditions(empty, ctx({ minutesOfDay: 11 * 60 }))).toBe(false);
      expect(evaluateConditions(empty, ctx({ minutesOfDay: 12 * 60 }))).toBe(false);
    });
  });

  describe("min_amount_centavos", () => {
    it("passes at and above the threshold, fails below", () => {
      const c = { min_amount_centavos: 48500 };
      expect(evaluateConditions(c, ctx({ amountCentavos: 48500 }))).toBe(true);
      expect(evaluateConditions(c, ctx({ amountCentavos: 48501 }))).toBe(true);
      expect(evaluateConditions(c, ctx({ amountCentavos: 48499 }))).toBe(false);
    });
  });

  describe("birthday", () => {
    it("birthday:true requires isBirthday === true", () => {
      expect(evaluateConditions({ birthday: true }, ctx({ isBirthday: true }))).toBe(true);
      expect(evaluateConditions({ birthday: true }, ctx({ isBirthday: false }))).toBe(false);
      expect(evaluateConditions({ birthday: true }, ctx())).toBe(false); // unknown = not a birthday
    });

    it("birthday:false is a no-op gate", () => {
      expect(evaluateConditions({ birthday: false }, ctx())).toBe(true);
      expect(evaluateConditions({ birthday: false }, ctx({ isBirthday: true }))).toBe(true);
    });
  });

  describe("first_visit", () => {
    it("first_visit:true requires isFirstVisit === true", () => {
      expect(evaluateConditions({ first_visit: true }, ctx({ isFirstVisit: true }))).toBe(true);
      expect(evaluateConditions({ first_visit: true }, ctx({ isFirstVisit: false }))).toBe(false);
      expect(evaluateConditions({ first_visit: true }, ctx())).toBe(false);
    });

    it("first_visit:false is a no-op gate", () => {
      expect(evaluateConditions({ first_visit: false }, ctx())).toBe(true);
    });
  });

  describe("AND semantics", () => {
    const combo = { days: [5], time_from: "11:00", time_to: "14:00", min_amount_centavos: 10000 };

    it("passes when every present key matches", () => {
      expect(evaluateConditions(combo, ctx())).toBe(true);
    });

    it("fails when any single key fails", () => {
      expect(evaluateConditions(combo, ctx({ weekday: 6 }))).toBe(false);
      expect(evaluateConditions(combo, ctx({ minutesOfDay: 9 * 60 }))).toBe(false);
      expect(evaluateConditions(combo, ctx({ amountCentavos: 9999 }))).toBe(false);
    });
  });
});
