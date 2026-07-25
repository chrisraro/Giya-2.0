// Shared pure domain types for the receipts slice
// (docs/30-modules/36-receipt-ocr-pipeline.md +
// docs/30-modules/37-fraud-detection.md). This module is IO-free: no
// server, DB, or React imports anywhere in src/features/receipts/*.ts
// outside of server/. Shapes use camelCase like the rest of the app
// layer; loaders map DB snake_case columns into these.

// Exactly the receipt_reject_reason enum (doc 20 section "Enumerations",
// mirrored by the receipts.reject_reason check constraint in doc 24).
export type ReceiptRejectReason =
  | "duplicate"
  | "unreadable"
  | "wrong_business"
  | "too_old"
  | "fraud_suspected"
  | "manual";

// The subset of reject reasons the fraud stage can produce (doc 37
// "Scoring & routing"). Freshness, readability, and matching rejections
// are decided earlier in the pipeline (doc 36 Stage 8) and never come
// out of fraudVerdict.
export type FraudRejectReason = Extract<
  ReceiptRejectReason,
  "duplicate" | "fraud_suspected"
>;

// Outcome of the fraud stage, consumed by the Stage 9 router
// (confidence.ts) and by the processing orchestrator. `pass` means the
// receipt falls through to parse-confidence routing; it does NOT mean
// approved.
export type FraudVerdict =
  | { kind: "pass" }
  | { kind: "review" }
  | { kind: "block"; rejectReason: FraudRejectReason };

// Provenance of a single extracted field, feeding f() in the Stage 9
// parse-confidence formula (doc 36): validated = 1, llm_assisted = 0.5
// (recovered by the LLM parse-assist rather than a deterministic template
// or regex), missing = 0.
export type FieldSource = "validated" | "llm_assisted" | "missing";

// Stage 9 routing thresholds, always injected. Doc 37 is explicit that
// thresholds are data, not code: these are `settings` rows (platform
// scope, business scope overriding) under `ocr.approve_threshold` /
// `ocr.review_threshold` plus the Stage 5 match bands, so retuning
// sensitivity never requires a deploy.
export interface RoutingThresholds {
  // parse_confidence at or above this may auto-approve (doc 36 Stage 9).
  approve: number;
  // parse_confidence below this is rejected as unreadable.
  review: number;
  // match_confidence at or above this auto-accepts the business match
  // (doc 36 Stage 5).
  matchAccept: number;
  // match_confidence below this is rejected as wrong_business.
  matchReview: number;
}

// Terminal routing decision for a receipt, mapping 1:1 onto
// receipts.status plus receipts.reject_reason.
export type RouteOutcome =
  | { status: "approved" }
  | { status: "review" }
  | { status: "rejected"; reason: ReceiptRejectReason };
