import type {
  FieldSource,
  FraudVerdict,
  RouteOutcome,
  RoutingThresholds,
} from "./types";

// Pure confidence + outcome-routing engine, per
// docs/30-modules/36-receipt-ocr-pipeline.md Stage 9 (the parse-confidence
// formula and the routing table) and docs/30-modules/37-fraud-detection.md
// ("Scoring & routing"). ZERO IO: the processing orchestrator loads the
// thresholds from `settings`, runs parse/match/fraud, and calls these
// functions with data it already has; status writes, fraud_signals rows,
// and the points award all live in the service layer.

// f(field) of the Stage 9 formula.
const FIELD_FACTOR: Record<FieldSource, number> = {
  validated: 1,
  llm_assisted: 0.5,
  missing: 0,
};

// Field weights of the Stage 9 formula. They sum to 0.70; the remaining
// 0.30 is carried by mean OCR confidence.
const WEIGHT_TOTAL = 0.35;
const WEIGHT_DATE = 0.2;
const WEIGHT_RECEIPT_NUMBER = 0.15;
const WEIGHT_MEAN_OCR = 0.3;

// Stage 9 bonus for a passing PH VAT 12% sanity check (Stage 7), capped
// with the rest of the score at 1.0.
const VAT_BONUS = 0.05;

// Stage 9 trailing note: mean OCR confidence below this emits the
// ai_confidence_low info signal. It is deliberately NOT a routing
// threshold and so is not part of RoutingThresholds.
const LOW_OCR_CONFIDENCE = 0.5;

// Platform defaults from doc 36 Stage 9 (`ocr.approve_threshold` 0.8,
// `ocr.review_threshold` 0.5) and doc 36 Stage 5 (match accept 0.85,
// match review floor 0.5). Thresholds are data, not code (doc 37): these
// exist only as the fallback the settings loader uses when a `settings`
// row is missing, so a bad or absent row degrades to documented
// behaviour instead of breaking the pipeline. Never inline them at a
// call site; always pass what the loader resolved.
export const DEFAULT_ROUTING_THRESHOLDS: RoutingThresholds = {
  approve: 0.8,
  review: 0.5,
  matchAccept: 0.85,
  matchReview: 0.5,
};

// Confidences are persisted as numeric(4,3) (doc 24: receipts
// .parse_confidence / .match_confidence), so 3 decimals is the domain's
// actual precision. Both the formula and the router quantize to it.
//
// This is not cosmetic. The weights 0.35/0.20/0.15/0.30 are not
// representable in binary floating point, so honest sums land a few ulps
// off the decimal value the doc specifies. Two real combinations of
// documented inputs:
//
//   total validated + date llm + number llm + mean 0.75 + VAT
//     = 0.800 exactly, but sums to 0.7999999999999999 in IEEE 754
//   total validated + date llm + number missing + mean 0 + VAT
//     = 0.500 exactly, but sums to 0.49999999999999994
//
// Compared raw, the first receipt routes to review instead of approving
// and the second is REJECTED as unreadable, both purely from float noise
// and neither reproducible by a human reading the doc. Quantizing first
// also makes the engine agree with the database: the value a reviewer
// sees in receipts.parse_confidence is the value that was routed on, so
// re-running the router over a stored row cannot change the decision.
// Half-up matches PostgreSQL's numeric rounding for positive values.
const STORED_PRECISION = 1000;

function toStoredPrecision(value: number): number {
  return Math.round(value * STORED_PRECISION) / STORED_PRECISION;
}

// Defensive normalization of an externally computed 0-1 confidence. OCR
// providers, and later a swapped-in engine, are not trusted to stay in
// range; a non-finite value means the upstream computation failed (an
// empty page yielding 0/0, say) and the safe reading of "we learned
// nothing" is 0, not NaN. NaN would silently make every comparison
// false, which routes to approved.
function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export interface ParseConfidenceInput {
  total: FieldSource;
  date: FieldSource;
  receiptNumber: FieldSource;
  // Mean confidence across the ocr_results rows for this receipt.
  meanOcrConfidence: number;
  // Whether the Stage 7 VAT 12% sanity check passed.
  vatConsistent: boolean;
}

// Doc 36 Stage 9:
//   parse_confidence = 0.35 f(total) + 0.20 f(date) + 0.15 f(number)
//                    + 0.30 mean_confidence(ocr_results)
//   bonus: +0.05 if the VAT sanity check passed (cap 1.0)
// Returned at stored precision, in [0, 1].
export function parseConfidence(input: ParseConfidenceInput): number {
  const fields =
    WEIGHT_TOTAL * FIELD_FACTOR[input.total] +
    WEIGHT_DATE * FIELD_FACTOR[input.date] +
    WEIGHT_RECEIPT_NUMBER * FIELD_FACTOR[input.receiptNumber];
  const ocr = WEIGHT_MEAN_OCR * normalizeConfidence(input.meanOcrConfidence);
  const bonus = input.vatConsistent ? VAT_BONUS : 0;
  return normalizeConfidence(toStoredPrecision(fields + ocr + bonus));
}

export interface RouteReceiptInput {
  parseConfidence: number;
  // Stage 5 business-match confidence.
  matchConfidence: number;
  // Stage 8.5 fraud verdict (doc 37), produced by fraud.ts.
  fraud: FraudVerdict;
  // Resolved from `settings`; DEFAULT_ROUTING_THRESHOLDS is the fallback.
  thresholds: RoutingThresholds;
}

// Stage 9 outcome routing, doc 36's table read together with doc 37's.
// The two tables overlap, so the precedence below is the merged reading;
// it is ordered, not a set of independent rules.
//
// 1. Fraud `block` first, ahead of the unreadable rejection. Golden rule
//    5 (doc 37 line 10) permits automatic rejection only for
//    DETERMINISTIC facts: byte-identical image, live duplicate receipt
//    number, near-identical perceptual hash. A block verdict is exactly
//    that set, and it is a statement about the submission, not about how
//    well we read it. An unreadable rejection is a statement about our
//    own OCR quality. When a known-duplicate photo also happens to be
//    blurry, "duplicate" is the true and more useful reason: it is what
//    the cooldown ladder counts as a fraud-family strike (doc 37 step 2)
//    and what the consumer must be told, whereas "unreadable" would
//    invite a retake of a receipt that can never be accepted. Deciding
//    it the other way round would also let an abuser launder a block
//    into a softer reason by degrading the image on purpose.
// 2. parse_confidence below the review threshold: unreadable.
// 3. match_confidence below the match-review floor: wrong_business. It
//    outranks review because it is terminal in doc 36 Stage 5, and it is
//    checked after unreadable because a receipt we could not read gives
//    the matcher nothing to work with, so its low match score is a
//    symptom of the unreadable image rather than an independent finding.
// 4. Anything probabilistic that falls short goes to a human: a fraud
//    `review` verdict, a parse score under the approve threshold, or a
//    match score under the accept threshold. Doc 37 is explicit that a
//    fraud review wins even when parse confidence alone would approve.
// 5. Otherwise approved. AI never final-decides an approval it is not
//    confident about; it only ever routes such a receipt to review.
export function routeReceipt(input: RouteReceiptInput): RouteOutcome {
  const { fraud, thresholds } = input;
  const parse = toStoredPrecision(normalizeConfidence(input.parseConfidence));
  const match = toStoredPrecision(normalizeConfidence(input.matchConfidence));

  if (fraud.kind === "block") {
    return { status: "rejected", reason: fraud.rejectReason };
  }
  if (parse < thresholds.review) {
    return { status: "rejected", reason: "unreadable" };
  }
  if (match < thresholds.matchReview) {
    return { status: "rejected", reason: "wrong_business" };
  }
  if (
    fraud.kind === "review" ||
    parse < thresholds.approve ||
    match < thresholds.matchAccept
  ) {
    return { status: "review" };
  }
  return { status: "approved" };
}

// Doc 36 Stage 9 trailing note: sub-threshold mean OCR confidence emits an
// `ai_confidence_low` fraud signal at severity `info` so reviewers see it
// as context. Severity `info` carries weight 0.1 in doc 37's composite,
// so this never rejects anything on its own; it only annotates. Input is
// normalized exactly as parseConfidence normalizes it, so an unusable
// mean (non-finite, i.e. no OCR result to average) reads as 0 and does
// emit the signal.
export function shouldEmitLowConfidenceSignal(
  meanOcrConfidence: number,
): boolean {
  return normalizeConfidence(meanOcrConfidence) < LOW_OCR_CONFIDENCE;
}
