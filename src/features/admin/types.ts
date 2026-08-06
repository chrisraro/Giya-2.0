// ===========================================================================
// Shapes for the platform admin portal.
//
// PURE. No IO, no React, no Supabase - the same seam `receipts/review/types.ts`
// draws, and for the same reason: `queue.ts` produces these from service-role
// reads and the screens consume them, so the screens can be unit tested
// without a database.
//
// WHAT MAKES THESE DIFFERENT FROM THE BUSINESS REVIEW SHAPES. The business
// queue's types are full of tenant-scoping compromises that this file
// deliberately does not carry:
//
//   * `MatchedReceiptView` there resolves ONLY when the matched receipt belongs
//     to the viewing tenant, and `matchedReceiptOutsideTenant` is the "we have
//     seen this before but cannot tell you where" placeholder. The admin
//     resolves it always, with the other business named, because a duplicate
//     spanning two tenants IS the finding (doc 37 S1: "A 0-4 match where
//     matched_consumer_id <> consumer_id is simultaneously ring evidence").
//   * `ConsumerHistoryView` there is scoped to one business and its own comment
//     says strikes and devices are "deliberately NOT answered ... doc 37
//     assigns the platform-wide view to the ADMIN fraud queue, which is out of
//     scope for this slice". `ConsumerStandingView` below is that view.
//
// The `FraudSignalView` type itself is imported rather than redefined, because
// `describeSignal` in the business presenter consumes it and this portal reuses
// that renderer verbatim. Doc 37's evidence contract is one contract; two
// implementations of it would drift and the direction they drift in is a
// reviewer reading different words about the same signal depending on which
// screen they opened.
//
// Docs: docs/30-modules/31-admin-portal.md §2 and §5,
// docs/30-modules/37-fraud-detection.md ("Review queues", the evidence display
// contract, the consequences ladder).
// ===========================================================================

import type { FraudSeverity } from "../receipts/fraud";
import type {
  FraudSignalView,
  ParseMetaView,
  ReviewFieldValues,
  ReviewLineItemView,
} from "../receipts/review/types";
// Type-only: erased at compile time (tsconfig `isolatedModules`), so this file
// stays IO-free even though the source module is `server-only`. Reused rather
// than redeclared so the Queue Status screen's shapes cannot drift from what
// t2-3's metrics module actually reads.
import type { JobsDepthByStatus, SweepJobHealthRow } from "@/lib/observability/metrics";

/** The tabs of `/admin/fraud`. `open` is the working queue; the rest is history. */
export type AdminFraudFilter = "open" | "blocked" | "all";

/** The tabs of `/admin/receipts`. `unmatched` is the admin-only one. */
export type AdminReceiptFilter = "review" | "unmatched" | "recent";

/**
 * One `fraud_signals` row as the admin sees it: the shared view the business
 * presenter renders, plus the cross-tenant context the business queue is not
 * allowed to resolve.
 */
export interface AdminSignalItem {
  /** Fed verbatim to `describeSignal` / `severityMeta` from the review presenter. */
  signal: FraudSignalView;
  /** The tenant this signal was raised for; null on a signal with no business. */
  businessName: string | null;
  /** The tenant the matched receipt belongs to, when the evidence names one. */
  matchedBusinessName: string | null;
  /** The account that submitted the matched receipt, when it is a different one. */
  matchedConsumerName: string | null;
  /**
   * A 5-minute signed URL for the MATCHED receipt's image (doc 15 TTL).
   *
   * This is the half of doc 37's evidence contract the business queue could not
   * deliver: "side-by-side image comparison for dup matches (both receipts via
   * 5-min signed URLs)". The business version links the matched receipt instead
   * and its own comment explains that a cross-tenant match has no URL that
   * business is entitled to. An admin is entitled to both.
   */
  matchedImageUrl: string | null;
}

/** One row of `/admin/fraud` and of `/admin/receipts`. */
export interface AdminQueueItem {
  receiptId: string;
  businessId: string | null;
  /** Null when the receipt never matched a tenant, which is its own finding. */
  businessName: string | null;
  consumerId: string;
  consumerName: string | null;
  merchantName: string | null;
  receiptNumber: string | null;
  totalCentavos: number | null;
  /** ISO-8601 submission time. Queue age is measured from here. */
  createdAt: string;
  status: string;
  rejectReason: string | null;
  /** The worst severity among this receipt's signals, null when it has none. */
  topSeverity: FraudSeverity | null;
  signalCount: number;
  /** doc 37's composite: min(1, sum(score x weight)). */
  fraudScore: number;
  /** doc 37 S9: submitted by a member of the business it was submitted to. */
  staffSelfScan: boolean;
}

/**
 * doc 37's "consumer's history summary: approval ratio, prior signals, strikes,
 * devices" - PLATFORM-WIDE, which is the whole reason this queue exists.
 *
 * `strikes` is the count the cooldown ladder actually counts (fraud-family
 * REJECTIONS in the trailing 30 days, per `receipts/server/cooldown.ts`, which
 * explains at length why the count is over rejections and not over signals).
 * Reproducing it with a different definition here would put a number in front
 * of an admin that disagrees with the automatic block they are looking at.
 */
export interface ConsumerStandingView {
  receiptsTotal: number;
  approved: number;
  rejected: number;
  /** 0-1, or null when nothing has been decided yet (0/0 is not a ratio). */
  approvalRatio: number | null;
  priorSignals: number;
  /** Fraud-family rejections in the trailing 30 days. */
  strikes: number;
  /** Distinct devices seen across this consumer's submissions. */
  devices: number;
  /** Distinct businesses scanned at; a ring hint, not a verdict. */
  businesses: number;
  /** `consumers.scan_blocked_until`, ISO-8601, null when not in cooldown. */
  scanBlockedUntil: string | null;
  isSuspended: boolean;
  suspendedReason: string | null;
}

/** One `audit_logs` row rendered on the receipt's decision history. */
export interface AdminAuditEntry {
  id: string;
  action: string;
  actorKind: string;
  actorRole: string | null;
  actorName: string | null;
  reason: string | null;
  createdAt: string;
}

/**
 * Whether doc 37 ladder step 5 is available on this receipt, and why not when
 * it is not.
 *
 * The reason is carried rather than reduced to a boolean because the screen
 * must SAY it: "this receipt was never awarded" and "this was already clawed
 * back" are different facts and an admin who is told neither will assume the
 * button is broken.
 */
export type ClawbackEligibility =
  | { kind: "eligible"; earnPoints: number }
  | { kind: "never_awarded" }
  | { kind: "already_reversed"; clawedPoints: number };

/** Everything `/admin/receipts/[receiptId]` renders. */
export interface AdminReceiptDetail {
  receiptId: string;
  businessId: string | null;
  businessName: string | null;
  consumerId: string;
  consumerName: string | null;
  status: string;
  rejectReason: string | null;
  rejectNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  fields: ReviewFieldValues;
  lineItems: ReviewLineItemView[];
  parseMeta: ParseMetaView | null;
  parseConfidence: number | null;
  matchConfidence: number | null;
  signals: AdminSignalItem[];
  /** 5-minute signed URL (doc 15), null when the image could not be signed. */
  imageUrl: string | null;
  standing: ConsumerStandingView;
  clawback: ClawbackEligibility;
  history: AdminAuditEntry[];
}

/**
 * doc 31 §2's dashboard, cut down to the four tiles this slice can answer from
 * LIVE tables.
 *
 * Every field is `number | null` and null means "could not be read", never
 * zero. The distinction is the same one `countPendingReview` makes in the
 * business queue and it matters more here: a platform dashboard reading "0
 * receipts in review" is a claim that the whole platform is clear, and a failed
 * count is not entitled to make it.
 *
 * Deliberately absent: every tile doc 31 backs with `analytics_daily_business`
 * (scan success rate, points issued, WASC trend). That table does not exist
 * yet, and a tile computed from a fixture would be worse than a missing tile.
 */
export interface PlatformOverview {
  businessesAwaitingVerification: number | null;
  receiptsInReview: number | null;
  /** `block`-severity signals in the trailing 7 days (doc 37's alerting input). */
  fraudBlocks7d: number | null;
  /** Receipts with no `business_id`: visible to no tenant, only to this portal. */
  unmatchedReceipts: number | null;
  /** The most recent blocking signals, for the "what just happened" strip. */
  recentBlocks: AdminQueueItem[];
}

// ---------------------------------------------------------------------------
// `/admin/monitoring/queues` (doc 31 §5, doc 39's DLQ view)
// ---------------------------------------------------------------------------

/**
 * One `jobs` row in `status='dead'`, with enough to act on it (doc 31 §5:
 * "dead list with `last_error` + requeue action").
 *
 * `payloadIdentity` is a rendered summary, not the raw payload: doc 39's own
 * rule ("payloads carry identifiers, never denormalized state") makes the
 * payload safe to summarise, but the raw JSON is still operator vocabulary -
 * same standing as `lastError` - so the screen never receives it unshaped.
 */
export interface DeadJobItem {
  jobId: string;
  queue: string;
  businessId: string | null;
  payloadIdentity: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /** `finished_at` - when the job was marked dead. Null should not occur for a
   * dead row (0029's `jobs_terminal_finished_at`), but the type stays honest
   * about what the column allows. */
  deadAt: string | null;
  createdAt: string;
  /** How many times `job.replayed` has landed on this job id (review finding
   * I6: `attempts` resets on every replay, so this is the only thing on the
   * screen that tells a job's fifth replay apart from its first). Null means
   * the audit-history read failed - NOT "never replayed", which a silent `0`
   * would claim. */
  replayCount: number | null;
}

/**
 * Everything `/admin/monitoring/queues` renders.
 *
 * Three independent nullable slices, not one - mirroring `loadMetrics`'s own
 * per-field failure shape (see its module header) rather than collapsing to a
 * single `unavailable` flag. A dead-letter read that fails must not blank out
 * a jobs-by-status count that succeeded, and vice versa: they come from
 * different queries and fail independently.
 */
export interface QueueStatusView {
  /** Null only when the count read itself failed to run at all (no
   * service-role key). Per-status nulls inside a non-null value are `loadMetrics`'s
   * own "this one status could not be counted" signal - see its header. */
  byStatus: JobsDepthByStatus | null;
  sweepHealth: readonly SweepJobHealthRow[] | null;
  /** Null means the read failed. `[]` means nothing is dead right now - a
   * claim this screen must not make on a dropped connection's behalf. */
  deadJobs: readonly DeadJobItem[] | null;
}

// ---------------------------------------------------------------------------
// The merchant verification queue (doc 31 section 3, doc 32 section 2)
// ---------------------------------------------------------------------------

/**
 * One business awaiting a go-live decision, with enough context to make it.
 *
 * WHAT "ENOUGH" MEANS HERE, because the temptation is to send the whole row.
 * An admin approving a merchant is answering two questions: "is this a real
 * shop in a real place" and "will their customers actually earn anything". The
 * fields below are exactly those two questions plus the applicant's own note.
 * Nothing else from `businesses` is carried, on the same data-minimisation
 * argument `loadDisplayNames` makes in queue.ts: a queue row that carries a
 * merchant's full address history has published it to every screenshot of that
 * queue.
 *
 * `earningRule` is the one field that is not identity. It is here because it is
 * the PRECONDITION `activate_business` (0033) enforces, and an admin who
 * presses approve and is refused by the database learns nothing about why; the
 * summary lets the screen say so before they press it. It can be null even in
 * this queue, because the rule can be deleted between submission and decision,
 * which is exactly the race the RPC re-checks under the row lock.
 */
export interface AdminBusinessReviewItem {
  businessId: string;
  name: string;
  slug: string;
  /** `ref_cities.name`, or null when the business set no city. */
  cityName: string | null;
  /** `ref_business_types.name`: cafe, restaurant, and so on. */
  businessTypeName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** The owner's `profiles.display_name`, or null when it could not be read. */
  ownerName: string | null;
  /** When the tenant registered, which is not when they applied. */
  createdAt: string;
  /** When the open round was opened, or null when there is no open round. */
  submittedAt: string | null;
  /** The applicant's own note on the round. */
  applicantNote: string | null;
  /**
   * A sentence describing the active base earning rule, or null when there is
   * none. Null means `activate_business` WILL refuse this business.
   */
  earningRule: string | null;
  /** Whether the merchant has put anything on their menu. Context, not a gate. */
  hasMenu: boolean;
}
