import { describe, it, expect } from "vitest";

import {
  parseConfidence,
  routeReceipt,
  shouldEmitLowConfidenceSignal,
  DEFAULT_ROUTING_THRESHOLDS,
} from "./confidence";
import type {
  FieldSource,
  FraudVerdict,
  RouteOutcome,
  RoutingThresholds,
} from "./types";

const ALL_SOURCES: readonly FieldSource[] = [
  "validated",
  "llm_assisted",
  "missing",
];

// The f() multipliers of doc 36 Stage 9, restated here independently of
// the implementation so the tests fail if the mapping is ever edited.
const F: Record<FieldSource, number> = {
  validated: 1,
  llm_assisted: 0.5,
  missing: 0,
};

const WEIGHTS = { total: 0.35, date: 0.2, receiptNumber: 0.15 } as const;

interface ParseInput {
  total: FieldSource;
  date: FieldSource;
  receiptNumber: FieldSource;
  meanOcrConfidence: number;
  vatConsistent: boolean;
}

const parseInput = (overrides: Partial<ParseInput> = {}): ParseInput => ({
  total: "validated",
  date: "validated",
  receiptNumber: "validated",
  meanOcrConfidence: 1,
  vatConsistent: false,
  ...overrides,
});

const PASS: FraudVerdict = { kind: "pass" };
const REVIEW: FraudVerdict = { kind: "review" };
const BLOCK_DUPLICATE: FraudVerdict = {
  kind: "block",
  rejectReason: "duplicate",
};
const BLOCK_FRAUD: FraudVerdict = {
  kind: "block",
  rejectReason: "fraud_suspected",
};

interface RouteInput {
  parseConfidence: number;
  matchConfidence: number;
  fraud: FraudVerdict;
  thresholds: RoutingThresholds;
}

// A receipt that clears every gate with room to spare, so each test can
// degrade exactly one input and attribute the outcome to it.
const routeInput = (overrides: Partial<RouteInput> = {}): RouteInput => ({
  parseConfidence: 0.95,
  matchConfidence: 0.95,
  fraud: PASS,
  thresholds: DEFAULT_ROUTING_THRESHOLDS,
  ...overrides,
});

const route = (overrides: Partial<RouteInput> = {}): RouteOutcome =>
  routeReceipt(routeInput(overrides));

describe("DEFAULT_ROUTING_THRESHOLDS", () => {
  it("carries the doc 36 / doc 37 platform defaults", () => {
    expect(DEFAULT_ROUTING_THRESHOLDS).toEqual({
      approve: 0.8,
      review: 0.5,
      matchAccept: 0.85,
      matchReview: 0.5,
    });
  });
});

describe("parseConfidence formula", () => {
  it("is 1.0 when every field is validated and OCR is perfect", () => {
    expect(parseConfidence(parseInput())).toBe(1);
  });

  it("weights the three fields 0.35 / 0.20 / 0.15 with no OCR contribution", () => {
    const base = parseInput({ meanOcrConfidence: 0, total: "missing", date: "missing", receiptNumber: "missing" });
    expect(parseConfidence({ ...base, total: "validated" })).toBe(0.35);
    expect(parseConfidence({ ...base, date: "validated" })).toBe(0.2);
    expect(parseConfidence({ ...base, receiptNumber: "validated" })).toBe(0.15);
  });

  it("gives llm_assisted exactly half the weight of validated, per field", () => {
    const base = parseInput({ meanOcrConfidence: 0, total: "missing", date: "missing", receiptNumber: "missing" });
    expect(parseConfidence({ ...base, total: "llm_assisted" })).toBe(0.175);
    expect(parseConfidence({ ...base, date: "llm_assisted" })).toBe(0.1);
    expect(parseConfidence({ ...base, receiptNumber: "llm_assisted" })).toBe(0.075);
  });

  it("collapses to 0.30 x mean OCR confidence when every field is missing", () => {
    const allMissing = { total: "missing", date: "missing", receiptNumber: "missing" } as const;
    for (const mean of [0, 0.25, 0.5, 0.75, 1]) {
      expect(
        parseConfidence(parseInput({ ...allMissing, meanOcrConfidence: mean })),
      ).toBe(Math.round(0.3 * mean * 1000) / 1000);
    }
  });

  it("matches the formula for all 27 field-source combinations", () => {
    for (const total of ALL_SOURCES) {
      for (const date of ALL_SOURCES) {
        for (const receiptNumber of ALL_SOURCES) {
          const mean = 0.6;
          const expected =
            WEIGHTS.total * F[total] +
            WEIGHTS.date * F[date] +
            WEIGHTS.receiptNumber * F[receiptNumber] +
            0.3 * mean;
          expect(
            parseConfidence(
              parseInput({ total, date, receiptNumber, meanOcrConfidence: mean }),
            ),
          ).toBeCloseTo(expected, 10);
        }
      }
    }
  });

  it("adds exactly 0.05 for a passing VAT sanity check", () => {
    const base = parseInput({ meanOcrConfidence: 0.5 });
    const without = parseConfidence({ ...base, vatConsistent: false });
    const withBonus = parseConfidence({ ...base, vatConsistent: true });
    expect(without).toBe(0.85);
    expect(withBonus).toBe(0.9);
  });

  it("clamps the VAT bonus at 1.0 rather than exceeding it", () => {
    expect(parseConfidence(parseInput({ vatConsistent: true }))).toBe(1);
    // 0.35 + 0.20 + 0.15 + 0.30 x 0.9 = 0.97, + 0.05 would be 1.02.
    expect(
      parseConfidence(parseInput({ meanOcrConfidence: 0.9, vatConsistent: true })),
    ).toBe(1);
  });

  it("never returns a value outside [0, 1]", () => {
    expect(
      parseConfidence(
        parseInput({
          total: "missing",
          date: "missing",
          receiptNumber: "missing",
          meanOcrConfidence: 0,
        }),
      ),
    ).toBe(0);
    expect(parseConfidence(parseInput({ vatConsistent: true }))).toBeLessThanOrEqual(1);
  });
});

describe("parseConfidence input clamping", () => {
  const allMissing = {
    total: "missing",
    date: "missing",
    receiptNumber: "missing",
  } as const;

  it("clamps a negative mean OCR confidence to 0", () => {
    expect(
      parseConfidence(parseInput({ ...allMissing, meanOcrConfidence: -1 })),
    ).toBe(0);
  });

  it("clamps a mean OCR confidence above 1 to 1", () => {
    expect(
      parseConfidence(parseInput({ ...allMissing, meanOcrConfidence: 2 })),
    ).toBe(0.3);
  });

  // A non-finite mean is not an out-of-range number to be clamped to the
  // nearest bound: it means the upstream average could not be computed
  // (no ocr_results rows to average, so 0/0). "We learned nothing" is 0,
  // never 1, and never NaN, which would make every routing comparison
  // false and land the receipt on approved.
  it("treats a non-finite mean OCR confidence as 0, including +Infinity", () => {
    for (const mean of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        parseConfidence(parseInput({ ...allMissing, meanOcrConfidence: mean })),
      ).toBe(0);
    }
  });
});

describe("parseConfidence rounding to stored precision", () => {
  it("returns a value with at most 3 decimals (receipts.parse_confidence is numeric(4,3))", () => {
    for (let k = 0; k <= 100; k += 1) {
      const value = parseConfidence(parseInput({ meanOcrConfidence: k / 100 }));
      expect(value * 1000).toBe(Math.round(value * 1000));
    }
  });

  it("returns exactly 0.7 for three validated fields and zero OCR confidence", () => {
    // 0.35 + 0.20 + 0.15 sums to 0.7000000000000001 in IEEE 754.
    expect(
      parseConfidence(
        parseInput({ meanOcrConfidence: 0, total: "validated", date: "validated", receiptNumber: "validated" }),
      ),
    ).toBe(0.7);
  });

  it("returns exactly 0.8 for the combination whose float sum is 0.7999999999999999", () => {
    const value = parseConfidence(
      parseInput({
        total: "validated",
        date: "llm_assisted",
        receiptNumber: "llm_assisted",
        meanOcrConfidence: 0.75,
        vatConsistent: true,
      }),
    );
    expect(value).toBe(0.8);
    expect(value).toBeGreaterThanOrEqual(DEFAULT_ROUTING_THRESHOLDS.approve);
  });

  it("returns exactly 0.5 for the combination whose float sum is 0.49999999999999994", () => {
    const value = parseConfidence(
      parseInput({
        total: "validated",
        date: "llm_assisted",
        receiptNumber: "missing",
        meanOcrConfidence: 0,
        vatConsistent: true,
      }),
    );
    expect(value).toBe(0.5);
    expect(value).toBeGreaterThanOrEqual(DEFAULT_ROUTING_THRESHOLDS.review);
  });

  it("routes the 0.7999999999999999 case to approved, not review", () => {
    const value = parseConfidence(
      parseInput({
        total: "validated",
        date: "llm_assisted",
        receiptNumber: "llm_assisted",
        meanOcrConfidence: 0.75,
        vatConsistent: true,
      }),
    );
    expect(route({ parseConfidence: value })).toEqual({ status: "approved" });
  });

  it("routes the 0.49999999999999994 case to review, not rejected/unreadable", () => {
    const value = parseConfidence(
      parseInput({
        total: "validated",
        date: "llm_assisted",
        receiptNumber: "missing",
        meanOcrConfidence: 0,
        vatConsistent: true,
      }),
    );
    expect(route({ parseConfidence: value })).toEqual({ status: "review" });
  });
});

describe("routeReceipt routing table", () => {
  it("approves when parse, match, and fraud all clear", () => {
    expect(route()).toEqual({ status: "approved" });
  });

  it("approves exactly at the approve threshold and reviews just below it", () => {
    expect(route({ parseConfidence: 0.8 })).toEqual({ status: "approved" });
    expect(route({ parseConfidence: 0.79 })).toEqual({ status: "review" });
  });

  it("approves exactly at the match-accept threshold and reviews just below it", () => {
    expect(route({ matchConfidence: 0.85 })).toEqual({ status: "approved" });
    expect(route({ matchConfidence: 0.849 })).toEqual({ status: "review" });
  });

  it("reviews exactly at the review threshold and rejects unreadable just below it", () => {
    expect(route({ parseConfidence: 0.5 })).toEqual({ status: "review" });
    expect(route({ parseConfidence: 0.499 })).toEqual({
      status: "rejected",
      reason: "unreadable",
    });
  });

  it("reviews exactly at the match-review threshold and rejects wrong_business just below it", () => {
    expect(route({ matchConfidence: 0.5 })).toEqual({ status: "review" });
    expect(route({ matchConfidence: 0.499 })).toEqual({
      status: "rejected",
      reason: "wrong_business",
    });
  });

  it("reviews a fraud review verdict", () => {
    expect(route({ fraud: REVIEW })).toEqual({ status: "review" });
  });

  it("rejects a fraud block with the verdict's own reason", () => {
    expect(route({ fraud: BLOCK_DUPLICATE })).toEqual({
      status: "rejected",
      reason: "duplicate",
    });
    expect(route({ fraud: BLOCK_FRAUD })).toEqual({
      status: "rejected",
      reason: "fraud_suspected",
    });
  });

  it("reviews when parse is in band even though match and fraud are perfect", () => {
    expect(route({ parseConfidence: 0.65 })).toEqual({ status: "review" });
  });

  it("reviews when match is in band even though parse and fraud are perfect", () => {
    expect(route({ matchConfidence: 0.7 })).toEqual({ status: "review" });
  });
});

describe("routeReceipt precedence", () => {
  it("lets a block verdict reject even when parse and match are perfect", () => {
    expect(
      route({ parseConfidence: 1, matchConfidence: 1, fraud: BLOCK_DUPLICATE }),
    ).toEqual({ status: "rejected", reason: "duplicate" });
  });

  it("lets a review verdict review even when parse and match are perfect", () => {
    expect(
      route({ parseConfidence: 1, matchConfidence: 1, fraud: REVIEW }),
    ).toEqual({ status: "review" });
  });

  it("prefers the block reason over unreadable when parse is also sub-threshold", () => {
    expect(
      route({ parseConfidence: 0.1, matchConfidence: 0.1, fraud: BLOCK_FRAUD }),
    ).toEqual({ status: "rejected", reason: "fraud_suspected" });
  });

  it("prefers unreadable over wrong_business when both parse and match are sub-threshold", () => {
    expect(route({ parseConfidence: 0.1, matchConfidence: 0.1 })).toEqual({
      status: "rejected",
      reason: "unreadable",
    });
  });

  it("prefers wrong_business over review when match is below the review band", () => {
    expect(route({ parseConfidence: 0.99, matchConfidence: 0.2 })).toEqual({
      status: "rejected",
      reason: "wrong_business",
    });
  });

  it("prefers wrong_business over a fraud review verdict", () => {
    expect(route({ matchConfidence: 0.2, fraud: REVIEW })).toEqual({
      status: "rejected",
      reason: "wrong_business",
    });
  });

  it("prefers unreadable over a fraud review verdict", () => {
    expect(route({ parseConfidence: 0.2, fraud: REVIEW })).toEqual({
      status: "rejected",
      reason: "unreadable",
    });
  });
});

describe("routeReceipt threshold injection", () => {
  const strict: RoutingThresholds = {
    approve: 0.99,
    review: 0.9,
    matchAccept: 0.99,
    matchReview: 0.9,
  };
  const lenient: RoutingThresholds = {
    approve: 0.5,
    review: 0.2,
    matchAccept: 0.5,
    matchReview: 0.2,
  };

  it("reviews under a raised approve threshold what defaults would approve", () => {
    expect(route({ parseConfidence: 0.95, matchConfidence: 1 })).toEqual({
      status: "approved",
    });
    expect(
      route({ parseConfidence: 0.95, matchConfidence: 1, thresholds: strict }),
    ).toEqual({ status: "review" });
  });

  it("rejects under a raised review threshold what defaults would review", () => {
    expect(route({ parseConfidence: 0.6 })).toEqual({ status: "review" });
    expect(route({ parseConfidence: 0.6, thresholds: strict })).toEqual({
      status: "rejected",
      reason: "unreadable",
    });
  });

  it("approves under a lowered approve threshold what defaults would review", () => {
    expect(route({ parseConfidence: 0.6, matchConfidence: 0.6 })).toEqual({
      status: "review",
    });
    expect(
      route({ parseConfidence: 0.6, matchConfidence: 0.6, thresholds: lenient }),
    ).toEqual({ status: "approved" });
  });

  it("reviews under a lowered match-review threshold what defaults would reject", () => {
    expect(route({ matchConfidence: 0.3 })).toEqual({
      status: "rejected",
      reason: "wrong_business",
    });
    expect(route({ matchConfidence: 0.3, thresholds: lenient })).toEqual({
      status: "review",
    });
  });

  it("still lets a block verdict win under the most lenient thresholds", () => {
    expect(route({ thresholds: lenient, fraud: BLOCK_DUPLICATE })).toEqual({
      status: "rejected",
      reason: "duplicate",
    });
  });
});

describe("routeReceipt confidence normalization", () => {
  it("compares at stored precision so float noise cannot flip the outcome", () => {
    expect(route({ parseConfidence: 0.7999999999999999 })).toEqual({
      status: "approved",
    });
    expect(route({ matchConfidence: 0.8499999999999999 })).toEqual({
      status: "approved",
    });
    expect(route({ parseConfidence: 0.49999999999999994 })).toEqual({
      status: "review",
    });
  });

  it("clamps out-of-range confidences instead of trusting them", () => {
    expect(route({ parseConfidence: 2, matchConfidence: 2 })).toEqual({
      status: "approved",
    });
    expect(route({ parseConfidence: -1 })).toEqual({
      status: "rejected",
      reason: "unreadable",
    });
    expect(route({ matchConfidence: -1 })).toEqual({
      status: "rejected",
      reason: "wrong_business",
    });
  });

  it("treats non-finite confidences as 0", () => {
    expect(route({ parseConfidence: Number.NaN })).toEqual({
      status: "rejected",
      reason: "unreadable",
    });
    expect(route({ matchConfidence: Number.NaN })).toEqual({
      status: "rejected",
      reason: "wrong_business",
    });
  });
});

describe("shouldEmitLowConfidenceSignal", () => {
  it("is true below 0.5 and false at or above it", () => {
    expect(shouldEmitLowConfidenceSignal(0.49)).toBe(true);
    expect(shouldEmitLowConfidenceSignal(0.499)).toBe(true);
    expect(shouldEmitLowConfidenceSignal(0.5)).toBe(false);
    expect(shouldEmitLowConfidenceSignal(0.51)).toBe(false);
    expect(shouldEmitLowConfidenceSignal(0)).toBe(true);
    expect(shouldEmitLowConfidenceSignal(1)).toBe(false);
  });

  it("clamps out-of-range and non-finite input the same way parseConfidence does", () => {
    expect(shouldEmitLowConfidenceSignal(-1)).toBe(true);
    expect(shouldEmitLowConfidenceSignal(2)).toBe(false);
    expect(shouldEmitLowConfidenceSignal(Number.NaN)).toBe(true);
  });
});
