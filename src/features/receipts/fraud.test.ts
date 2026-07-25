import { describe, it, expect } from "vitest";

import {
  scoreSignals,
  fraudVerdict,
  buildSignal,
  SEVERITY_WEIGHT,
  FRAUD_SIGNAL_SPECS,
  DUPLICATE_FAMILY_SIGNALS,
  DEFAULT_FRAUD_REVIEW_THRESHOLD,
} from "./fraud";
import type { FraudSignal, FraudSignalType, FraudSeverity } from "./fraud";

const signal = (
  type: FraudSignalType,
  severity: FraudSeverity,
  score: number,
  evidence: Record<string, unknown> = {},
): FraudSignal => ({ signal: type, severity, score, evidence });

// Doc 37's worked example, as three named rows.
const S4_PAIR_10MIN = signal("velocity", "warn", 0.7, {
  window: "pair_10min",
  count: 3,
  cap: 2,
});
const S7_ROUND_NUMBERS = signal("amount_anomaly", "warn", 0.4, {
  pattern: "round_numbers",
  streak: 6,
});
const S5_CLOSED_HOURS = signal("timestamp_anomaly", "warn", 0.4, {
  kind: "closed_hours",
});

describe("SEVERITY_WEIGHT", () => {
  it("is exactly doc 37's weight table", () => {
    expect(SEVERITY_WEIGHT).toEqual({ block: 1.0, warn: 0.4, info: 0.1 });
  });
});

describe("scoreSignals", () => {
  it("is 0 for no signals", () => {
    expect(scoreSignals([])).toBe(0);
  });

  it("weights a single signal by its severity", () => {
    expect(scoreSignals([signal("velocity", "warn", 0.5)])).toBe(0.2);
    expect(scoreSignals([signal("ai_confidence_low", "info", 0.3)])).toBe(0.03);
    expect(scoreSignals([signal("image_hash_dup", "block", 1.0)])).toBe(1);
  });

  it("sums doc 37's worked example to 0.44", () => {
    // 0.7 x 0.4 + 0.4 x 0.4 = 0.28 + 0.16 = 0.44
    expect(scoreSignals([S4_PAIR_10MIN, S7_ROUND_NUMBERS])).toBe(0.44);
  });

  it("sums doc 37's escalated worked example to 0.60", () => {
    // + 0.4 x 0.4 = +0.16 -> 0.60. Naive IEEE addition yields
    // 0.6000000000000001 here, so this asserts the rounding contract.
    expect(
      scoreSignals([S4_PAIR_10MIN, S7_ROUND_NUMBERS, S5_CLOSED_HOURS]),
    ).toBe(0.6);
  });

  it("rounds IEEE dust away rather than leaking it into the composite", () => {
    // 0.45 x 0.4 + 0.8 x 0.4 computes to 0.5000000000000001 unrounded.
    const composite = scoreSignals([
      signal("velocity", "warn", 0.45),
      signal("timestamp_anomaly", "warn", 0.8),
    ]);
    expect(composite).toBe(0.5);
  });

  it("clamps at 1.0 with many signals", () => {
    const many: FraudSignal[] = [
      signal("velocity", "warn", 0.7),
      signal("velocity", "warn", 0.6),
      signal("timestamp_anomaly", "warn", 0.7),
      signal("amount_anomaly", "warn", 0.5),
      signal("amount_anomaly", "warn", 0.4),
      signal("staff_self_scan", "warn", 0.8),
      signal("ai_confidence_low", "info", 0.3),
      signal("receipt_number_dup", "info", 0.2),
    ];
    expect(scoreSignals(many)).toBe(1);
  });

  it("clamps at 1.0 when a single block signal is joined by others", () => {
    expect(
      scoreSignals([
        signal("image_hash_dup", "block", 1.0),
        signal("velocity", "warn", 0.7),
      ]),
    ).toBe(1);
  });

  it("never returns a negative composite for a zero-scored signal", () => {
    expect(scoreSignals([signal("image_hash_dup", "block", 0)])).toBe(0);
  });
});

describe("fraudVerdict", () => {
  const threshold = DEFAULT_FRAUD_REVIEW_THRESHOLD;

  it("defaults the review threshold to 0.5 per the settings registry", () => {
    expect(DEFAULT_FRAUD_REVIEW_THRESHOLD).toBe(0.5);
  });

  it("passes with no signals", () => {
    expect(fraudVerdict([], threshold)).toEqual({ kind: "pass" });
  });

  it("passes doc 37's worked example at composite 0.44", () => {
    const signals = [S4_PAIR_10MIN, S7_ROUND_NUMBERS];
    expect(scoreSignals(signals)).toBe(0.44);
    expect(fraudVerdict(signals, threshold)).toEqual({ kind: "pass" });
  });

  it("reviews doc 37's escalated worked example at composite 0.60", () => {
    const signals = [S4_PAIR_10MIN, S7_ROUND_NUMBERS, S5_CLOSED_HOURS];
    expect(scoreSignals(signals)).toBe(0.6);
    expect(fraudVerdict(signals, threshold)).toEqual({ kind: "review" });
  });

  it("reviews at exactly the threshold (>= is review)", () => {
    // 0.09 + 0.58 + 0.58 warns = exactly 0.5 in decimal, but
    // 0.49999999999999994 in raw IEEE arithmetic. Unrounded this would
    // wrongly pass, so this pins both the rounding and the >= boundary.
    const signals = [
      signal("velocity", "warn", 0.09),
      signal("timestamp_anomaly", "warn", 0.58),
      signal("amount_anomaly", "warn", 0.58),
    ];
    expect(scoreSignals(signals)).toBe(0.5);
    expect(fraudVerdict(signals, threshold)).toEqual({ kind: "review" });
  });

  it("passes just below the threshold", () => {
    // 0.4 x 0.4 + 0.8 x 0.4 = 0.48
    const signals = [
      signal("velocity", "warn", 0.4),
      signal("timestamp_anomaly", "warn", 0.8),
    ];
    expect(scoreSignals(signals)).toBe(0.48);
    expect(fraudVerdict(signals, threshold)).toEqual({ kind: "pass" });
  });

  it("honours an injected threshold, not a hardcoded one", () => {
    const signals = [S4_PAIR_10MIN, S7_ROUND_NUMBERS]; // composite 0.44
    expect(fraudVerdict(signals, 0.4)).toEqual({ kind: "review" });
    expect(fraudVerdict(signals, 0.44)).toEqual({ kind: "review" });
    expect(fraudVerdict(signals, 0.45)).toEqual({ kind: "pass" });
    expect(fraudVerdict(signals, 0.9)).toEqual({ kind: "pass" });
  });

  describe("block routing", () => {
    it("blocks with 'duplicate' for image_hash_dup", () => {
      expect(
        fraudVerdict([signal("image_hash_dup", "block", 1.0)], threshold),
      ).toEqual({ kind: "block", rejectReason: "duplicate" });
    });

    it("blocks with 'duplicate' for receipt_number_dup", () => {
      expect(
        fraudVerdict([signal("receipt_number_dup", "block", 1.0)], threshold),
      ).toEqual({ kind: "block", rejectReason: "duplicate" });
    });

    it("blocks with 'duplicate' for ocr_similarity_dup", () => {
      expect(
        fraudVerdict([signal("ocr_similarity_dup", "block", 1.0)], threshold),
      ).toEqual({ kind: "block", rejectReason: "duplicate" });
    });

    it("blocks with 'fraud_suspected' outside the dup family", () => {
      const others: FraudSignalType[] = [
        "velocity",
        "timestamp_anomaly",
        "gps_mismatch",
        "amount_anomaly",
        "ai_confidence_low",
        "staff_self_scan",
      ];
      for (const type of others) {
        expect(fraudVerdict([signal(type, "block", 1.0)], threshold)).toEqual({
          kind: "block",
          rejectReason: "fraud_suspected",
        });
      }
    });

    it("prefers 'duplicate' when both families block", () => {
      expect(
        fraudVerdict(
          [
            signal("amount_anomaly", "block", 1.0),
            signal("receipt_number_dup", "block", 1.0),
          ],
          threshold,
        ),
      ).toEqual({ kind: "block", rejectReason: "duplicate" });
    });

    it("blocks even when the composite is 0", () => {
      const signals = [signal("image_hash_dup", "block", 0)];
      expect(scoreSignals(signals)).toBe(0);
      expect(fraudVerdict(signals, threshold)).toEqual({
        kind: "block",
        rejectReason: "duplicate",
      });
    });

    it("blocks even when a raised threshold would otherwise pass everything", () => {
      const signals = [
        signal("amount_anomaly", "block", 1.0),
        signal("velocity", "warn", 0.7),
      ];
      expect(fraudVerdict(signals, 1)).toEqual({
        kind: "block",
        rejectReason: "fraud_suspected",
      });
    });

    it("outranks a staff self-scan present alongside it", () => {
      expect(
        fraudVerdict(
          [
            signal("staff_self_scan", "warn", 0.8),
            signal("image_hash_dup", "block", 1.0),
          ],
          threshold,
        ),
      ).toEqual({ kind: "block", rejectReason: "duplicate" });
    });
  });

  describe("staff self-scan (S9)", () => {
    it("forces review alone, below the threshold", () => {
      // 0.8 warn = 0.32 composite, comfortably under 0.5.
      const signals = [signal("staff_self_scan", "warn", 0.8)];
      expect(scoreSignals(signals)).toBe(0.32);
      expect(fraudVerdict(signals, threshold)).toEqual({ kind: "review" });
    });

    it("forces review even at composite 0", () => {
      const signals = [signal("staff_self_scan", "info", 0)];
      expect(scoreSignals(signals)).toBe(0);
      expect(fraudVerdict(signals, threshold)).toEqual({ kind: "review" });
    });

    it("forces review even with an unreachable threshold", () => {
      expect(
        fraudVerdict([signal("staff_self_scan", "warn", 0.8)], 1),
      ).toEqual({ kind: "review" });
    });
  });
});

describe("FRAUD_SIGNAL_SPECS", () => {
  it("matches doc 37's catalog exactly", () => {
    expect(FRAUD_SIGNAL_SPECS).toEqual({
      // S1 perceptual hash bands
      phash_near_identical: {
        signal: "image_hash_dup",
        severity: "block",
        score: 1.0,
      },
      phash_similar: {
        signal: "image_hash_dup",
        severity: "warn",
        score: 0.6,
      },
      // S3 receipt number
      receipt_number_live_conflict: {
        signal: "receipt_number_dup",
        severity: "block",
        score: 1.0,
      },
      receipt_number_prior_rejected: {
        signal: "receipt_number_dup",
        severity: "info",
        score: 0.2,
      },
      // S5 timestamp
      timestamp_future_dated: {
        signal: "timestamp_anomaly",
        severity: "warn",
        score: 0.7,
      },
      timestamp_closed_hours: {
        signal: "timestamp_anomaly",
        severity: "warn",
        score: 0.4,
      },
      timestamp_too_old: {
        signal: "timestamp_anomaly",
        severity: "info",
        score: 0.1,
      },
      // S7 amount
      amount_outlier_total: {
        signal: "amount_anomaly",
        severity: "warn",
        score: 0.5,
      },
      amount_round_number_streak: {
        signal: "amount_anomaly",
        severity: "warn",
        score: 0.4,
      },
      amount_total_vs_line_items: {
        signal: "amount_anomaly",
        severity: "info",
        score: 0.2,
      },
      // S8 model confidence
      ai_mean_confidence_low: {
        signal: "ai_confidence_low",
        severity: "info",
        score: 0.3,
      },
      ai_llm_assisted_field: {
        signal: "ai_confidence_low",
        severity: "info",
        score: 0.2,
      },
      // S9 staff self-scan
      staff_self_scan: {
        signal: "staff_self_scan",
        severity: "warn",
        score: 0.8,
      },
    });
  });

  it("lists the dup family used for the 'duplicate' reject reason", () => {
    expect([...DUPLICATE_FAMILY_SIGNALS].sort()).toEqual([
      "image_hash_dup",
      "ocr_similarity_dup",
      "receipt_number_dup",
    ]);
  });
});

describe("buildSignal", () => {
  it("stamps the catalog severity/score onto caller evidence", () => {
    expect(
      buildSignal("phash_near_identical", {
        matched_receipt_id: "r-1",
        hamming_distance: 3,
      }),
    ).toEqual({
      signal: "image_hash_dup",
      severity: "block",
      score: 1.0,
      evidence: { matched_receipt_id: "r-1", hamming_distance: 3 },
    });
  });

  it("produces the worked example's composite when used end to end", () => {
    const signals = [
      buildSignal("timestamp_closed_hours", { kind: "closed_hours" }),
      buildSignal("amount_round_number_streak", { pattern: "round_numbers" }),
    ];
    // 0.4 x 0.4 + 0.4 x 0.4 = 0.32
    expect(scoreSignals(signals)).toBe(0.32);
    expect(fraudVerdict(signals, DEFAULT_FRAUD_REVIEW_THRESHOLD)).toEqual({
      kind: "pass",
    });
  });

  it("routes a staff self-scan built from the catalog to review", () => {
    const signals = [buildSignal("staff_self_scan", { business_id: "b-1" })];
    expect(fraudVerdict(signals, DEFAULT_FRAUD_REVIEW_THRESHOLD)).toEqual({
      kind: "review",
    });
  });
});
