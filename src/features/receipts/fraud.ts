import type { FraudRejectReason, FraudVerdict } from "./types";

// Pure fraud scoring and routing engine, per
// docs/30-modules/37-fraud-detection.md ("Signal catalog" S1-S9 and
// "Scoring & routing"). ZERO IO: detectors elsewhere gather their own
// evidence (pHash neighbours from Postgres, window counts from Redis,
// staff membership from business_staff) and hand the resulting signal
// rows to these functions. Writing fraud_signals rows, setting
// receipts.status, and the consequences ladder all live in the service
// layer.
//
// Doc 37's philosophy in two lines: layered signals -> composite score
// -> route, and AI never final-decides (golden rule 5). The only
// automatic rejections are deterministic facts, which is why a `block`
// severity is reserved for the duplicate detectors and everything
// probabilistic can at worst reach `review`.

// Exactly the fraud_signal_type enum (doc 20 "Enumerations"), minus the
// two [V1] ring values (referral_abuse, device_shared) which are cases,
// not per-receipt signals, and never reach this engine.
export type FraudSignalType =
  | "image_hash_dup"
  | "ocr_similarity_dup"
  | "receipt_number_dup"
  | "velocity"
  | "timestamp_anomaly"
  | "gps_mismatch"
  | "amount_anomaly"
  | "ai_confidence_low"
  | "staff_self_scan";

export type FraudSeverity = "info" | "warn" | "block";

// One tripped detector, mirroring a fraud_signals row (doc 24). The row
// is written whether or not the receipt ends up rejected: doc 37 is
// explicit that scoring history on approved receipts is how thresholds
// get tuned and slow-burn abusers get caught.
export interface FraudSignal {
  signal: FraudSignalType;
  severity: FraudSeverity;
  score: number;
  evidence: Record<string, unknown>;
}

// weight(block) = 1.0, weight(warn) = 0.4, weight(info) = 0.1.
export const SEVERITY_WEIGHT: Record<FraudSeverity, number> = {
  block: 1.0,
  warn: 0.4,
  info: 0.1,
};

// `fraud.review_threshold` in the platform settings registry. Always
// injected into fraudVerdict rather than read here, so retuning
// sensitivity is a settings row edit, not a deploy. This constant is the
// fallback the settings reader uses when the row is missing.
export const DEFAULT_FRAUD_REVIEW_THRESHOLD = 0.5;

// The dup family. A block from any of these is explainable to the
// consumer as "we have already seen this receipt", which is why it wins
// the reject_reason race below.
export const DUPLICATE_FAMILY_SIGNALS: ReadonlySet<FraudSignalType> = new Set<
  FraudSignalType
>(["image_hash_dup", "ocr_similarity_dup", "receipt_number_dup"]);

// Composite rounding. Every score and weight in doc 37's catalog carries
// at most two decimal places, so an exact composite can never need more
// than four; anything past that is IEEE dust (0.28 + 0.16 + 0.16 lands on
// 0.6000000000000001, and three warns that sum to exactly 0.5 in decimal
// can compute as 0.49999999999999994, which would silently route to
// `pass` instead of `review`). Rounding to four decimals is therefore
// lossless for legitimate inputs and makes the `>=` threshold comparison
// behave the way the doc's arithmetic reads. It also keeps the number we
// persist and show reviewers identical to the number the doc predicts.
const COMPOSITE_DECIMALS = 4;
const COMPOSITE_SCALE = 10 ** COMPOSITE_DECIMALS;

function roundComposite(value: number): number {
  return Math.round(value * COMPOSITE_SCALE) / COMPOSITE_SCALE;
}

// composite = min(1.0, sum_i score_i x weight(severity_i)).
//
// The parameter is the SEVERITY/SCORE PAIR rather than a whole `FraudSignal`
// because that pair is all the formula reads, and the review UI scores rows it
// has loaded back out of `fraud_signals` (where `signal` is a database `text`,
// not this module's narrowed union). Widening the parameter keeps the
// composite arithmetic in exactly one place instead of gaining a second
// implementation on the read side.
export function scoreSignals(
  signals: readonly Pick<FraudSignal, "severity" | "score">[],
): number {
  let total = 0;
  for (const item of signals) {
    total += item.score * SEVERITY_WEIGHT[item.severity];
  }
  return Math.min(1, roundComposite(total));
}

// Doc 37's routing table, in its precedence order:
//
//   1. any `block` signal        -> rejected (duplicate | fraud_suspected)
//   2. staff self-scan (S9)      -> review, unconditional
//   3. composite >= threshold    -> review
//   4. otherwise                 -> pass (falls through to doc 36 Stage 9)
//
// Blocks outrank S9 because a block is a deterministic fact and produces
// a terminal status; sending a known duplicate to a human queue would
// waste review capacity on a decision already made. S9 outranks the
// composite because doc 37 routes it "regardless of composite" - a staff
// member scanning their own store is a conflict of interest a human must
// look at even when nothing else about the receipt is suspicious.
export function fraudVerdict(
  signals: readonly FraudSignal[],
  reviewThreshold: number,
): FraudVerdict {
  const blocking = signals.filter((item) => item.severity === "block");
  if (blocking.length > 0) {
    // `duplicate` wins when both families block. It is the more specific
    // and more explainable reason: the pipeline holds the matched receipt
    // id as evidence, the consumer-facing copy can honestly say the
    // receipt was already scanned, and it keeps an accidental double-scan
    // out of the fraud_suspected bucket that feeds the cooldown ladder.
    const rejectReason: FraudRejectReason = blocking.some((item) =>
      DUPLICATE_FAMILY_SIGNALS.has(item.signal),
    )
      ? "duplicate"
      : "fraud_suspected";
    return { kind: "block", rejectReason };
  }

  if (signals.some((item) => item.signal === "staff_self_scan")) {
    return { kind: "review" };
  }

  if (scoreSignals(signals) >= reviewThreshold) {
    return { kind: "review" };
  }

  return { kind: "pass" };
}

// Doc 37's catalog as data. Detectors reference a case by name and
// supply only evidence, so severities and scores live in exactly one
// place and stay auditable against the doc.
export type FraudSignalCase =
  // S1 image_hash_dup, by hamming distance band (>10 emits no signal)
  | "phash_near_identical"
  | "phash_similar"
  // S3 receipt_number_dup
  | "receipt_number_live_conflict"
  | "receipt_number_prior_rejected"
  // S5 timestamp_anomaly
  | "timestamp_future_dated"
  | "timestamp_closed_hours"
  | "timestamp_too_old"
  // S7 amount_anomaly
  | "amount_outlier_total"
  | "amount_round_number_streak"
  | "amount_total_vs_line_items"
  // S8 ai_confidence_low
  | "ai_mean_confidence_low"
  | "ai_llm_assisted_field"
  // S9
  | "staff_self_scan";

export interface FraudSignalSpec {
  readonly signal: FraudSignalType;
  readonly severity: FraudSeverity;
  readonly score: number;
}

// S2 ocr_similarity_dup is [V1] and deliberately absent: doc 37 says
// never block on text alone, and the detector does not exist yet.
// S6 gps_mismatch is [V1] and opt-in, likewise absent.
export const FRAUD_SIGNAL_SPECS: Record<FraudSignalCase, FraudSignalSpec> = {
  // S1: hamming 0-4 is the same photo re-encoded; 5-10 is the same
  // physical receipt re-photographed.
  phash_near_identical: {
    signal: "image_hash_dup",
    severity: "block",
    score: 1.0,
  },
  phash_similar: { signal: "image_hash_dup", severity: "warn", score: 0.6 },

  // S3: a live conflict means two claims on one number at one business.
  // A match against an already-rejected row is context only.
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

  // S5.
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
  // Stage 8 has already rejected as too_old; this is a history row only.
  timestamp_too_old: {
    signal: "timestamp_anomaly",
    severity: "info",
    score: 0.1,
  },

  // S7.
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

  // S8: never blocks, only contextualizes review.
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

  // S9: warn severity, but fraudVerdict routes it to review regardless
  // of what the composite says.
  staff_self_scan: { signal: "staff_self_scan", severity: "warn", score: 0.8 },
};

// Build a catalog-backed signal row. Detectors own the evidence, never
// the severity or the score.
export function buildSignal(
  signalCase: FraudSignalCase,
  evidence: Record<string, unknown>,
): FraudSignal {
  const spec = FRAUD_SIGNAL_SPECS[signalCase];
  return {
    signal: spec.signal,
    severity: spec.severity,
    score: spec.score,
    evidence,
  };
}
