// ===========================================================================
// D10: the review rate, as a pure shape and a pure vocabulary.
//
// Eight independent rules can route a receipt to a human (see `ReviewReason`
// in ./server/process.ts, which names all of them and records the pre-agreed
// loosening order). Each is individually defensible and nobody had ever
// measured what fraction of real receipts trips at least one. This module is
// the arithmetic and the words for that measurement; ./server/routing-stats.ts
// is the one read behind it.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A DIAGNOSTIC AND NOT AN ANALYTICS PRODUCT
// ---------------------------------------------------------------------------
// The risk this number exists to catch is not fraud, it is merchant boredom.
// Giya's pitch is "customers scan and points appear". If the reality is "the
// owner approves every receipt by hand" then we have built a punch card with
// extra steps, and the merchant quits long before the alias learning ever pays
// off. One question ("is this working on its own?"), one follow-up ("which rule
// is costing me?"), and nothing else. No trends, no cohorts, no charts.
//
// ZERO IO. The server module hands this a list of tallies and it does the
// division. That keeps every edge case here testable without a database: an
// empty window, a window that is entirely unattributed, a reason that appears
// on more receipts than there are reviews.
// ===========================================================================

/**
 * The four outcomes a merchant cares about. `pending` collapses queued and
 * processing, matching `receiptOutcome` in ./components/receipt-copy.ts and the
 * same collapse the SQL performs, so the panel and the consumer's status screen
 * cannot disagree about what "still going" means.
 */
export type RoutingStatusKey = "approved" | "review" | "rejected" | "pending";

const STATUS_KEYS: readonly RoutingStatusKey[] = [
  "approved",
  "review",
  "rejected",
  "pending",
];

/** One row of `public.receipt_routing_breakdown` (migration 0035). */
export interface RoutingTally {
  kind: string;
  key: string;
  tally: number;
}

export interface RoutingReasonShare {
  /** A `ReviewReason` value, or "unattributed". */
  key: string;
  label: string;
  count: number;
  /**
   * Share of receipts IN REVIEW, not of all receipts. A receipt can trip
   * several rules, so these do not sum to 1 and the surfaces say so.
   */
  shareOfReviewed: number;
  /**
   * True for the backfill bucket, so a surface can render it differently
   * without string-matching the key.
   */
  unattributed: boolean;
}

export interface RoutingBreakdown {
  windowDays: number;
  /** Every receipt scanned in the window, whatever became of it. */
  total: number;
  counts: Record<RoutingStatusKey, number>;
  /**
   * Share of SETTLED receipts (approved + review + rejected) that needed a
   * human. Pending receipts are excluded from the denominator deliberately:
   * they have no outcome yet, and counting them would make the rate dip every
   * time the queue is busy, which is the exact moment it must not lie.
   */
  reviewRate: number;
  /** Same denominator, so the three shares are comparable. */
  approvalRate: number;
  rejectionRate: number;
  /** Descending by count, so the rule worth tuning is first. */
  reasons: RoutingReasonShare[];
}

/**
 * D10's action threshold, recorded as a number rather than left in a comment:
 * "more than roughly a quarter of receipts needing a human after a merchant's
 * first week" is when the loosening ladder starts. `roughly` is honest - this
 * is where a human looks, not where anything automatic happens - so nothing in
 * this codebase changes behaviour when a merchant crosses it.
 */
export const REVIEW_RATE_ATTENTION = 0.25;

/**
 * A merchant-facing name for every reason the pipeline can record.
 *
 * WRITTEN FOR A SHOP OWNER, NOT FOR US. "parse_confidence_low" is a true
 * description of a threshold and a useless thing to show someone deciding
 * whether this product works. Each label answers "what did the machine
 * struggle with", because that is what tells the owner whether the fix is
 * theirs (photograph the whole receipt, add an alias, raise your amount bound)
 * or ours.
 *
 * This is NOT ./components/receipt-copy.ts and is not bound by its
 * forbidden-vocabulary sweep: that module's fence exists because a CONSUMER
 * must never be told which detector tripped, and every audience for these
 * strings is a merchant or an admin looking at their own tenant's receipts. The
 * house style still applies: sentence case, no em-dashes, no blame.
 */
const REASON_LABELS: Record<string, string> = {
  // The forced family: rules that upgraded an otherwise clean approval.
  amount_sanity: "Total was outside the expected range",
  customer_blacklisted: "Customer is under review",
  llm_assisted_field: "A field needed AI help to read",
  merchant_name_mismatch: "Shop name on the receipt did not match",
  merchant_name_unreadable: "Could not read the shop name",
  // The routed family: the thresholds that decided.
  parse_confidence_low: "Could not read the receipt confidently",
  match_confidence_low: "Not sure the receipt is yours",
  fraud_composite: "Fraud checks asked for a look",
  staff_self_scan: "Submitted by your own staff",
  // D7: our failure, and it says so. A merchant seeing a pile of these is
  // seeing something true that the old dead-letter path hid from them.
  ocr_operator_failure: "We could not process it on our side",
  // The tenth reason, and the only one no rule produced: the customer rejected
  // our rejection. It is listed here so the breakdown does not credit whatever
  // rejected the receipt originally, and it is the one row on this panel a
  // merchant should read as a QUESTION about the other rows: a pile of these
  // beside a pile of "could not read the receipt confidently" is customers
  // telling us our threshold is wrong, in the only vocabulary they have.
  consumer_escalation: "The customer asked you to look again",
};

/**
 * The backfill bucket's label. Kept out of `REASON_LABELS` because it is not a
 * reason: it is an admission that we did not record one, and it must read as
 * such rather than as a ninth rule anybody could act on.
 */
const UNATTRIBUTED_KEY = "unattributed";
const UNATTRIBUTED_LABEL = "Scanned before we recorded reasons";

/**
 * A label for a key this build has not heard of.
 *
 * Reachable in one real direction: the database is ahead of the deploy, because
 * a pipeline writing a newly added `ReviewReason` is live while an older bundle
 * is still being served. Rendering the raw key is deliberate - it is ugly, it
 * is honest, and it is greppable - where inventing a friendly name would hide a
 * rule the reader is trying to count.
 */
export function reasonLabel(key: string): string {
  if (key === UNATTRIBUTED_KEY) return UNATTRIBUTED_LABEL;
  return REASON_LABELS[key] ?? key;
}

function safeShare(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return part / whole;
}

/**
 * Fold the RPC's rows into the shape the surfaces render.
 *
 * TOTAL AND DENOMINATOR ARE DERIVED FROM THE STATUS ROWS, never from a separate
 * count. One read, one arithmetic, so the tiles cannot disagree with each other
 * the way two differently-filtered queries eventually always do.
 *
 * A reason whose count exceeds the review count is not clamped. It cannot
 * happen with a single reason (each receipt contributes at most one row per
 * reason) but a stale or hand-edited `parse_meta` could produce one, and a
 * share above 1 is a visible symptom where a silent clamp is a hidden bug.
 */
export function foldRoutingBreakdown(
  rows: readonly RoutingTally[],
  windowDays: number,
): RoutingBreakdown {
  const counts: Record<RoutingStatusKey, number> = {
    approved: 0,
    review: 0,
    rejected: 0,
    pending: 0,
  };
  const reasonCounts = new Map<string, number>();

  for (const row of rows) {
    const tally = Number.isFinite(row.tally) ? row.tally : 0;
    if (row.kind === "status") {
      const key = STATUS_KEYS.find((candidate) => candidate === row.key);
      // An unrecognized status is dropped rather than bucketed. The enum is
      // fixed by 0017 and a new member would be a schema change that has to
      // reach this file anyway; guessing which bucket it belongs in would
      // corrupt the rate silently.
      if (key !== undefined) counts[key] += tally;
    } else if (row.kind === "reason") {
      reasonCounts.set(row.key, (reasonCounts.get(row.key) ?? 0) + tally);
    }
  }

  const total = counts.approved + counts.review + counts.rejected + counts.pending;
  const settled = counts.approved + counts.review + counts.rejected;

  const reasons = [...reasonCounts]
    .map(([key, count]) => ({
      key,
      label: reasonLabel(key),
      count,
      shareOfReviewed: safeShare(count, counts.review),
      unattributed: key === UNATTRIBUTED_KEY,
    }))
    // Count first, then key, so two reasons that tie render in a stable order
    // across reloads rather than shuffling on every render.
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));

  return {
    windowDays,
    total,
    counts,
    reviewRate: safeShare(counts.review, settled),
    approvalRate: safeShare(counts.approved, settled),
    rejectionRate: safeShare(counts.rejected, settled),
    reasons,
  };
}

/**
 * A share as a whole-number percentage.
 *
 * Rounds toward the nearest and never invents precision: "26%" is the number a
 * ladder decision is made on and a decimal place would imply a confidence the
 * sample size does not support on a merchant's first week.
 */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  return `${Math.round(share * 100)}%`;
}

/**
 * Whether this merchant's review rate has crossed D10's attention line.
 *
 * Returns false for an empty window: zero of zero receipts is not a healthy
 * platform and is certainly not an unhealthy one, and a "needs attention" flag
 * on a merchant who has not opened yet is the fastest way to teach an operator
 * to ignore the flag.
 */
export function needsLoosening(breakdown: RoutingBreakdown): boolean {
  const settled =
    breakdown.counts.approved + breakdown.counts.review + breakdown.counts.rejected;
  if (settled === 0) return false;
  return breakdown.reviewRate > REVIEW_RATE_ATTENTION;
}
