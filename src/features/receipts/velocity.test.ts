import { describe, it, expect } from "vitest";

import {
  evaluateVelocity,
  DEFAULT_VELOCITY_CAPS,
  VELOCITY_WINDOWS,
} from "./velocity";
import type { VelocityCap, VelocityCounts, VelocityWindow } from "./velocity";
import { scoreSignals, fraudVerdict, DEFAULT_FRAUD_REVIEW_THRESHOLD } from "./fraud";

describe("DEFAULT_VELOCITY_CAPS", () => {
  it("is exactly doc 37's S4 table", () => {
    expect(DEFAULT_VELOCITY_CAPS).toEqual({
      consumer_hour: { cap: 4, severity: "warn", score: 0.5 },
      consumer_day: { cap: 10, severity: "warn", score: 0.6 },
      pair_day: { cap: 3, severity: "warn", score: 0.5 },
      pair_10min: { cap: 2, severity: "warn", score: 0.7 },
      device_day: { cap: 12, severity: "warn", score: 0.6 },
    });
  });

  it("enumerates the windows in a stable order", () => {
    expect(VELOCITY_WINDOWS).toEqual([
      "consumer_hour",
      "consumer_day",
      "pair_day",
      "pair_10min",
      "device_day",
    ]);
  });

  it("never blocks: doc 37 says behavioral caps route to review, never reject", () => {
    for (const window of VELOCITY_WINDOWS) {
      expect(DEFAULT_VELOCITY_CAPS[window].severity).not.toBe("block");
    }
  });
});

describe("evaluateVelocity", () => {
  it("emits nothing for no counts", () => {
    expect(evaluateVelocity({}, DEFAULT_VELOCITY_CAPS)).toEqual([]);
  });

  it("emits nothing when every window is under its cap", () => {
    expect(
      evaluateVelocity(
        {
          consumer_hour: 1,
          consumer_day: 3,
          pair_day: 1,
          pair_10min: 1,
          device_day: 5,
        },
        DEFAULT_VELOCITY_CAPS,
      ),
    ).toEqual([]);
  });

  describe("cap boundary", () => {
    it("does not breach when count equals the cap (the cap is the allowance)", () => {
      expect(
        evaluateVelocity({ consumer_hour: 4 }, DEFAULT_VELOCITY_CAPS),
      ).toEqual([]);
    });

    it("breaches when count exceeds the cap by one", () => {
      expect(
        evaluateVelocity({ consumer_hour: 5 }, DEFAULT_VELOCITY_CAPS),
      ).toEqual([
        {
          signal: "velocity",
          severity: "warn",
          score: 0.5,
          evidence: { window: "consumer_hour", count: 5, cap: 4 },
        },
      ]);
    });

    it("applies the same rule to every window", () => {
      for (const window of VELOCITY_WINDOWS) {
        const { cap } = DEFAULT_VELOCITY_CAPS[window];
        expect(
          evaluateVelocity({ [window]: cap }, DEFAULT_VELOCITY_CAPS),
        ).toEqual([]);
        expect(
          evaluateVelocity({ [window]: cap + 1 }, DEFAULT_VELOCITY_CAPS),
        ).toHaveLength(1);
      }
    });

    it("treats a zero count as no activity, not a breach", () => {
      expect(
        evaluateVelocity({ pair_10min: 0 }, DEFAULT_VELOCITY_CAPS),
      ).toEqual([]);
    });
  });

  it("emits doc 37's evidence shape verbatim", () => {
    expect(evaluateVelocity({ pair_10min: 3 }, DEFAULT_VELOCITY_CAPS)).toEqual([
      {
        signal: "velocity",
        severity: "warn",
        score: 0.7,
        evidence: { window: "pair_10min", count: 3, cap: 2 },
      },
    ]);
  });

  it("emits one signal per breached window and skips the compliant ones", () => {
    const signals = evaluateVelocity(
      {
        consumer_hour: 6, // breach
        consumer_day: 10, // at cap, no breach
        pair_day: 4, // breach
        pair_10min: 1, // under cap
        device_day: 20, // breach
      },
      DEFAULT_VELOCITY_CAPS,
    );
    expect(signals.map((s) => s.evidence)).toEqual([
      { window: "consumer_hour", count: 6, cap: 4 },
      { window: "pair_day", count: 4, cap: 3 },
      { window: "device_day", count: 20, cap: 12 },
    ]);
  });

  it("emits in the declared window order regardless of input key order", () => {
    const signals = evaluateVelocity(
      { device_day: 99, pair_day: 99, consumer_hour: 99 },
      DEFAULT_VELOCITY_CAPS,
    );
    expect(signals.map((s) => s.evidence.window)).toEqual([
      "consumer_hour",
      "pair_day",
      "device_day",
    ]);
  });

  describe("missing counts", () => {
    it("never evaluates a window whose count was not supplied", () => {
      // Redis may not have every counter (cold key, partial outage). A
      // missing count is unknown, never a 0-breach and never an error.
      expect(evaluateVelocity({ pair_10min: 3 }, DEFAULT_VELOCITY_CAPS)).toHaveLength(1);
    });

    it("tolerates explicitly undefined counts without throwing", () => {
      // Shape a Redis pipeline actually returns when some keys are cold.
      const fromRedis: VelocityCounts = {
        consumer_hour: undefined,
        consumer_day: undefined,
        pair_day: 3,
        pair_10min: undefined,
        device_day: undefined,
      };
      expect(evaluateVelocity(fromRedis, DEFAULT_VELOCITY_CAPS)).toEqual([]);
    });
  });

  it("honours injected caps rather than the defaults", () => {
    // Business-scope override of fraud.velocity.pair_day (doc 37 registry).
    const caps: Record<VelocityWindow, VelocityCap> = {
      ...DEFAULT_VELOCITY_CAPS,
      pair_day: { cap: 20, severity: "info", score: 0.2 },
    };
    expect(evaluateVelocity({ pair_day: 4 }, caps)).toEqual([]);
    expect(evaluateVelocity({ pair_day: 21 }, caps)).toEqual([
      {
        signal: "velocity",
        severity: "info",
        score: 0.2,
        evidence: { window: "pair_day", count: 21, cap: 20 },
      },
    ]);
  });

  it("defaults its caps argument to the platform registry", () => {
    expect(evaluateVelocity({ consumer_hour: 5 })).toEqual(
      evaluateVelocity({ consumer_hour: 5 }, DEFAULT_VELOCITY_CAPS),
    );
  });
});

describe("velocity feeding the fraud composite", () => {
  it("cannot block on its own, however many windows breach", () => {
    const signals = evaluateVelocity(
      {
        consumer_hour: 100,
        consumer_day: 100,
        pair_day: 100,
        pair_10min: 100,
        device_day: 100,
      },
      DEFAULT_VELOCITY_CAPS,
    );
    expect(signals).toHaveLength(5);
    expect(scoreSignals(signals)).toBe(1);
    expect(fraudVerdict(signals, DEFAULT_FRAUD_REVIEW_THRESHOLD)).toEqual({
      kind: "review",
    });
  });

  it("reproduces doc 37's worked-example S4 contribution", () => {
    // pair_10min breach alone -> 0.7 warn -> 0.28 composite -> passes.
    const signals = evaluateVelocity({ pair_10min: 3 }, DEFAULT_VELOCITY_CAPS);
    expect(scoreSignals(signals)).toBe(0.28);
    expect(fraudVerdict(signals, DEFAULT_FRAUD_REVIEW_THRESHOLD)).toEqual({
      kind: "pass",
    });
  });
});
