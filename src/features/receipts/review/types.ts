// ===========================================================================
// Shapes for the business portal's receipt review surfaces.
//
// PURE. No IO, no React, no Supabase. `queue.ts` produces these from
// service-role reads and the client components consume them, so this file is
// the seam that lets the screens be unit tested without a database.
//
// EVERYTHING IN THIS DIRECTORY IS STAFF-ONLY. Spec section 2: 0017's
// column-level grant withholds `parse_meta`, `parse_confidence`,
// `match_confidence`, `reject_note`, `sha256` and `image_hash` from
// `authenticated`, and column privileges are role-wide, so the only way staff
// can see them is a service-role read in a server component. That makes this
// tree the one place in the app where those values exist as data, and
// `isolation.test.ts` is the fence that keeps it that way.
//
// Docs: docs/30-modules/36-receipt-ocr-pipeline.md Stage 9,
// docs/30-modules/37-fraud-detection.md "Review queues", and the slice spec
// section 5.
// ===========================================================================

import type { FraudSeverity } from "../fraud";

/** The three tabs of `/business/receipts`. `review` is the queue; the rest is history. */
export type ReviewQueueStatus = "review" | "approved" | "rejected";

/**
 * Doc 36's 24h SLA target and doc 37's 48h admin alert, as a rendering state.
 * `ok` is the steady state and gets no accent at all: a queue where every item
 * shouts is a queue nobody reads.
 */
export type QueueSlaState = "ok" | "due" | "overdue";

/** The editable half of the decision screen, pre-filled from the parsed row. */
export interface ReviewFieldValues {
  merchantName: string | null;
  receiptNumber: string | null;
  /** ISO-8601 instant, or null when the parser found no date. */
  receiptDate: string | null;
  subtotalCentavos: number | null;
  taxCentavos: number | null;
  totalCentavos: number | null;
}

export interface ReviewLineItemView {
  id: string;
  rawText: string;
  qty: number | null;
  unitPriceCentavos: number | null;
  lineTotalCentavos: number | null;
  sort: number;
}

/**
 * A receipt named by a duplicate signal's evidence, resolved ONLY when it
 * belongs to the same business. A pHash neighbour can legitimately come from
 * the consumer's history at another merchant (see `detectImageHashDuplicate`
 * in server/process.ts, which unions the consumer's own history with this
 * business's), and rendering that receipt's merchant, total and date here
 * would be a cross-tenant leak dressed up as evidence.
 */
export interface MatchedReceiptView {
  receiptId: string;
  merchantName: string | null;
  receiptNumber: string | null;
  receiptDate: string | null;
  totalCentavos: number | null;
  status: string;
  createdAt: string;
}

/** One `fraud_signals` row plus whatever of its evidence resolved in-tenant. */
export interface FraudSignalView {
  id: string;
  signal: string;
  severity: FraudSeverity;
  score: number;
  evidence: Record<string, unknown>;
  createdAt: string;
  /** The matched receipt, when the evidence names one AND it is this tenant's. */
  matchedReceipt: MatchedReceiptView | null;
  /**
   * The evidence names a matched receipt that this business cannot see. The
   * reviewer is told it exists, because "we have seen this image before"
   * is the finding; nothing about the other tenant is shown.
   */
  matchedReceiptOutsideTenant: boolean;
}

/** `parse_meta.fields.{key}` as written by `buildParseMeta` in server/process.ts. */
export interface ParseMetaFieldView {
  /** "template" or "heuristic": the tier the parse ran in. */
  tier: string | null;
  present: boolean;
}

/** The rival named by `parse_meta.merchant_check.rival`, when one was found. */
export interface MerchantCheckRivalView {
  businessId: string | null;
  name: string;
  score: number | null;
}

/**
 * `parse_meta.merchant_check` as written by `buildParseMeta`: doc 36 Stage 5's
 * merchant-name check, the defence against a receipt from another shop being
 * scanned against this one.
 *
 * `verdict` is three-valued rather than a boolean because "we could not read
 * the shop name" and "the shop name is not yours" are different findings that
 * a reviewer answers differently, and the queue must not flatten them.
 */
export interface MerchantCheckView {
  verdict: "match" | "mismatch" | "unreadable";
  score: number | null;
  threshold: number | null;
  /** The header exactly as the pipeline read it. Null when nothing was read. */
  headerText: string | null;
  matchedAlias: string | null;
  rival: MerchantCheckRivalView | null;
}

/** The readable half of `receipts.parse_meta`, narrowed from its jsonb. */
export interface ParseMetaView {
  engine: string | null;
  tier: string | null;
  templateId: string | null;
  fields: Record<string, ParseMetaFieldView>;
  vatConsistent: boolean | null;
  withinAmountSanity: boolean | null;
  dateAmbiguous: boolean | null;
  notes: string[];
  ocrMeanConfidence: number | null;
  /** Null on a row written before the check existed, or on an unmatched receipt. */
  merchantCheck: MerchantCheckView | null;
  /**
   * `parse_meta.review_reasons`: why the pipeline asked a human to look.
   * Empty on rows written before the field existed, which is indistinguishable
   * from "nothing forced a review" and is treated as such - the reasons
   * annotate the queue, they never gate it.
   */
  reviewReasons: string[];
}

/** One row of `/business/receipts`. */
export interface ReviewQueueItem {
  receiptId: string;
  /** `profiles.display_name` of the submitter, null when the profile is gone. */
  consumerName: string | null;
  merchantName: string | null;
  receiptNumber: string | null;
  totalCentavos: number | null;
  /** ISO-8601 submission time. The queue age is measured from here. */
  createdAt: string;
  receiptDate: string | null;
  status: ReviewQueueStatus;
  reviewedAt: string | null;
  rejectReason: string | null;
  /** The worst severity among this receipt's signals, null when it has none. */
  topSeverity: FraudSeverity | null;
  signalCount: number;
  /** doc 37's composite: min(1, sum(score x weight)). */
  fraudScore: number;
  /**
   * The viewer submitted this receipt themselves, so `reviewReceipt` will
   * refuse them (guard 4, doc 37 S9). Surfaced in the queue so they never
   * open it expecting to decide it.
   */
  submittedByViewer: boolean;
}

/** Doc 37's "consumer's history summary", scoped to the viewing tenant. */
export interface ConsumerHistoryView {
  receiptsAtBusiness: number;
  approvedAtBusiness: number;
  rejectedAtBusiness: number;
  priorSignalsAtBusiness: number;
}

/** Everything `/business/receipts/[receiptId]` renders. */
export interface ReviewDecisionItem {
  receiptId: string;
  status: ReviewQueueStatus;
  consumerName: string | null;
  /** Guard 4 again, this time as the thing that disables the actions. */
  submittedByViewer: boolean;
  createdAt: string;
  reviewedAt: string | null;
  rejectReason: string | null;
  fields: ReviewFieldValues;
  lineItems: ReviewLineItemView[];
  parseMeta: ParseMetaView | null;
  /** 0-1, or null on a row the pipeline never scored. */
  parseConfidence: number | null;
  matchConfidence: number | null;
  signals: FraudSignalView[];
  /** 5-minute signed URL (doc 15), null when the image could not be signed. */
  imageUrl: string | null;
  history: ConsumerHistoryView;
}
