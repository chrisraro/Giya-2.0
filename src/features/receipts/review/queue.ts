import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

import type { FraudSeverity } from "../fraud";
import { PENDING_COUNT_CAP, compositeFraudScore, highestSeverity } from "./presenter";
import type {
  ConsumerHistoryView,
  FraudSignalView,
  MatchedReceiptView,
  ParseMetaFieldView,
  ParseMetaView,
  ReviewDecisionItem,
  ReviewLineItemView,
  ReviewQueueItem,
  ReviewQueueStatus,
} from "./types";

// ===========================================================================
// SERVICE-ROLE READS FOR THE BUSINESS REVIEW SCREENS.
//
// ---------------------------------------------------------------------------
// EVERY QUERY IN THIS FILE IS A TENANCY ASSERTION. READ THIS FIRST.
// ---------------------------------------------------------------------------
// The client below is the SERVICE ROLE. It BYPASSES RLS. Nothing the database
// does will stop a query here from returning another business's receipts, so
// the `.eq("business_id", businessId)` predicates are not defence in depth the
// way they are in `features/campaigns/server/repo.ts`; they ARE the fence, and
// a missing one is a cross-tenant data leak that no policy will catch.
//
// The rules this file follows without exception:
//
//   1. `businessId` ALWAYS arrives as an argument, and its only legitimate
//      source is `resolveReviewerContext()` in ./access.ts, which reads it
//      from `business_staff` under the caller's own session. It is never taken
//      from a route parameter, a query string, a form field or a claim. The
//      pages call `resolveReviewerContext()` themselves and pass the result;
//      the route's `[receiptId]` segment is the ONLY caller-supplied value
//      that reaches this module, and it is always paired with the resolved
//      business id in the same WHERE clause.
//
//   2. Every query is annotated with what enforces tenancy on it. If a query
//      cannot be annotated, it does not belong here.
//
//   3. A row that fails the tenancy predicate is indistinguishable from a row
//      that does not exist: both surface as null, and the page renders its
//      404. There is no "you may not see this" branch, because that branch is
//      an existence oracle for other tenants' receipt ids.
//
// Why the service role at all: spec section 2. 0017 revoked the table-level
// SELECT on `receipts` from `authenticated` and re-granted 13 columns;
// `parse_meta`, `parse_confidence`, `match_confidence`, `reject_note`,
// `sha256` and `image_hash` are outside that grant. Column privileges are
// role-wide and staff are the same `authenticated` role as consumers, so no
// policy or grant can give a reviewer the columns the review screen needs.
// The service role is the documented consequence, recorded in 0017 itself.
// ===========================================================================

const RECEIPTS_BUCKET = "receipts";

/**
 * Doc 15: receipt images are private with access via signed URLs only, TTL
 * 5 minutes. 0019 records that the bucket has NO staff policy at all, so this
 * server-minted URL is the only path a business owner has to a receipt image,
 * and it stays server-mediated so it can be permission-checked (which is
 * exactly what `loadReviewDecisionItem` does before minting one).
 */
const SIGNED_URL_TTL_SECONDS = 300;

/** Ceiling on one queue page. The queue is a working list, not an archive. */
const QUEUE_LIMIT = 100;

/**
 * Ceiling on the badge count, so a runaway queue cannot cost an unbounded
 * read. Defined in ./presenter.ts and re-exported here because both the server
 * that stops counting and the copy that says "or more" must use one number.
 */
export { PENDING_COUNT_CAP };

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ReviewQueueDeps {
  /** MUST be the service-role client. See the header. */
  supabase: SupabaseClient<Database>;
  now: () => Date;
}

/**
 * Production wiring. Returns null when the service-role key is absent, which
 * every caller renders as an explicit "cannot load right now" rather than as
 * an empty queue: an empty queue is a claim that there is nothing to review,
 * and that claim must never be made by a misconfiguration.
 *
 * A FAILED READ IS THE SAME CLAIM. The two public reads below therefore return
 * `null` for "could not be read" and only ever return `[]` or a number for
 * "read successfully, and this is what is there". A misconfigured key and a
 * Supabase outage are one rendering state, because they are one fact from the
 * reviewer's side: we do not know what is in the queue.
 */
export function defaultReviewQueueDeps(): ReviewQueueDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[receipts/review-queue] SUPABASE_SERVICE_ROLE_KEY is not configured; the review queue cannot be read",
    );
    return null;
  }
  return { supabase, now: () => new Date() };
}

// ---------------------------------------------------------------------------
// Row shapes and column lists
// ---------------------------------------------------------------------------

/**
 * Columns are named, never `select *`. Two reasons, and the second is the one
 * that matters: naming them keeps this read auditable against 0017's grant
 * table, and it means a column added to `receipts` later cannot start flowing
 * into a React tree nobody re-reviewed.
 */
const QUEUE_COLUMNS =
  "id, user_id, status, merchant_name, receipt_number, receipt_date, total_centavos, created_at, reviewed_at, reject_reason";

const DECISION_COLUMNS = `${QUEUE_COLUMNS}, business_id, subtotal_centavos, tax_centavos, reject_note, image_path, parse_meta, parse_confidence, match_confidence`;

interface QueueRow {
  id: string;
  user_id: string;
  status: string;
  merchant_name: string | null;
  receipt_number: string | null;
  receipt_date: string | null;
  total_centavos: number | null;
  created_at: string;
  reviewed_at: string | null;
  reject_reason: string | null;
}

interface DecisionRow extends QueueRow {
  business_id: string | null;
  subtotal_centavos: number | null;
  tax_centavos: number | null;
  reject_note: string | null;
  image_path: string;
  parse_meta: unknown;
  parse_confidence: number | null;
  match_confidence: number | null;
}

interface SignalRow {
  id: string;
  receipt_id: string;
  signal: string;
  severity: string;
  score: number;
  evidence: unknown;
  created_at: string;
}

const SEVERITIES: readonly FraudSeverity[] = ["info", "warn", "block"];

function toSeverity(value: string): FraudSeverity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as FraudSeverity) : "info";
}

const QUEUE_STATUSES: readonly ReviewQueueStatus[] = ["review", "approved", "rejected"];

export function isReviewQueueStatus(value: string): value is ReviewQueueStatus {
  return (QUEUE_STATUSES as readonly string[]).includes(value);
}

function toEvidence(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * `receipts.parse_meta` is jsonb written by `buildParseMeta` in
 * server/process.ts, but it is still jsonb: rows written by an older build, or
 * by a future one, are shapes this code has never seen. Every field is read
 * defensively and a value of the wrong type degrades to null rather than
 * throwing, because a reviewer with no chips can still work and a reviewer
 * looking at a stack trace cannot.
 */
export function parseParseMeta(value: unknown): ParseMetaView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const meta = value as Record<string, unknown>;

  const fields: Record<string, ParseMetaFieldView> = {};
  const rawFields = meta.fields;
  if (typeof rawFields === "object" && rawFields !== null && !Array.isArray(rawFields)) {
    for (const [key, raw] of Object.entries(rawFields as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const field = raw as Record<string, unknown>;
      fields[key] = {
        tier: typeof field.tier === "string" ? field.tier : null,
        present: field.present === true,
      };
    }
  }

  const ocr = typeof meta.ocr === "object" && meta.ocr !== null ? (meta.ocr as Record<string, unknown>) : {};

  return {
    engine: typeof meta.engine === "string" ? meta.engine : null,
    tier: typeof meta.tier === "string" ? meta.tier : null,
    templateId: typeof meta.template_id === "string" ? meta.template_id : null,
    fields,
    vatConsistent: typeof meta.vat_consistent === "boolean" ? meta.vat_consistent : null,
    withinAmountSanity:
      typeof meta.within_amount_sanity === "boolean" ? meta.within_amount_sanity : null,
    dateAmbiguous: typeof meta.date_ambiguous === "boolean" ? meta.date_ambiguous : null,
    notes: Array.isArray(meta.notes)
      ? meta.notes.filter((note): note is string => typeof note === "string")
      : [],
    ocrMeanConfidence:
      typeof ocr.mean_confidence === "number" && Number.isFinite(ocr.mean_confidence)
        ? ocr.mean_confidence
        : null,
  };
}

// ---------------------------------------------------------------------------
// The pending badge
// ---------------------------------------------------------------------------

/**
 * How many receipts are waiting on a human at this business, or NULL when that
 * could not be established.
 *
 * Feeds the sidebar badge and the dashboard tile. Capped rather than counted
 * exactly: the difference between 140 and 200 changes nothing a reviewer does,
 * and "99+" is a cheaper, bounded read.
 *
 * Null rather than 0 on a failure, because 0 is an ASSERTION: it renders as
 * "Nothing waiting" beside a tile that says every scan went through on its own.
 * Callers render null as no badge and no number at all. A wrong number is worse
 * than no number: no badge is a surface the reviewer will still open, while a
 * confident zero is a surface they will skip.
 */
export async function countPendingReview(
  businessId: string,
  deps: ReviewQueueDeps | null = defaultReviewQueueDeps(),
): Promise<number | null> {
  if (deps === null) return null;

  // TENANCY: `.eq("business_id", businessId)`, where businessId came from
  // resolveReviewerContext() reading business_staff under the caller's own
  // session. Without this predicate the badge would count the platform.
  const { data, error } = await deps.supabase
    .from("receipts")
    .select("id")
    .eq("business_id", businessId)
    .eq("status", "review")
    .limit(PENDING_COUNT_CAP + 1);

  if (error !== null) {
    console.error(`[receipts/review-queue] pending count failed for business ${businessId}`, error);
    return null;
  }
  return (data ?? []).length;
}

// ---------------------------------------------------------------------------
// The queue list
// ---------------------------------------------------------------------------

export interface ListReviewQueueInput {
  businessId: string;
  status: ReviewQueueStatus;
  /** The signed-in reviewer, used only to flag their own submissions. */
  viewerId: string;
}

/**
 * One page of the queue, or NULL when it could not be read.
 *
 * `[]` means the query ran and this business has nothing in this status. Null
 * means we do not know, and the screen says so instead of rendering the empty
 * state, whose copy ("every scan went through on its own") is a claim about the
 * pipeline that a dropped connection is in no position to make.
 */
export async function listReviewQueue(
  input: ListReviewQueueInput,
  deps: ReviewQueueDeps | null = defaultReviewQueueDeps(),
): Promise<ReviewQueueItem[] | null> {
  if (deps === null) return null;
  const { businessId, status, viewerId } = input;

  // TENANCY: `.eq("business_id", businessId)` from resolveReviewerContext().
  // The status filter is a UI concern; the business predicate is the fence.
  //
  // Sort: the review tab is oldest-first because doc 36 sets a 24h SLA and the
  // oldest item is the one at risk. History is newest-first, because history
  // is read for "what did we just decide", not for the backlog.
  const ascending = status === "review";
  const { data, error } = await deps.supabase
    .from("receipts")
    .select(QUEUE_COLUMNS)
    .eq("business_id", businessId)
    .eq("status", status)
    .order("created_at", { ascending })
    .limit(QUEUE_LIMIT);

  if (error !== null) {
    console.error(`[receipts/review-queue] queue read failed for business ${businessId}`, error);
    return null;
  }

  const rows = (data ?? []) as QueueRow[];
  if (rows.length === 0) return [];

  const receiptIds = rows.map((row) => row.id);
  const [signalsByReceipt, names] = await Promise.all([
    loadSignalsByReceipt(deps, businessId, receiptIds),
    loadDisplayNames(deps, rows.map((row) => row.user_id)),
  ]);

  return rows.map((row) => {
    const signals = signalsByReceipt.get(row.id) ?? [];
    return {
      receiptId: row.id,
      consumerName: names.get(row.user_id) ?? null,
      merchantName: row.merchant_name,
      receiptNumber: row.receipt_number,
      totalCentavos: row.total_centavos,
      createdAt: row.created_at,
      receiptDate: row.receipt_date,
      status: isReviewQueueStatus(row.status) ? row.status : "review",
      reviewedAt: row.reviewed_at,
      rejectReason: row.reject_reason,
      topSeverity: highestSeverity(signals),
      signalCount: signals.length,
      fraudScore: compositeFraudScore(signals),
      submittedByViewer: row.user_id === viewerId,
    } satisfies ReviewQueueItem;
  });
}

// ---------------------------------------------------------------------------
// The decision screen
// ---------------------------------------------------------------------------

export interface LoadReviewDecisionInput {
  businessId: string;
  /** The ONLY caller-supplied value in this module. Never used without businessId. */
  receiptId: string;
  viewerId: string;
}

/**
 * Everything `/business/receipts/[receiptId]` renders, or null when the id
 * does not name a receipt belonging to this business.
 *
 * Null covers "no such receipt" and "someone else's receipt" identically, so
 * the page's 404 cannot be used to probe for receipt ids across tenants.
 */
export async function loadReviewDecisionItem(
  input: LoadReviewDecisionInput,
  deps: ReviewQueueDeps | null = defaultReviewQueueDeps(),
): Promise<ReviewDecisionItem | null> {
  if (deps === null) return null;
  const { businessId, receiptId, viewerId } = input;

  // TENANCY: the receipt id comes from the URL, so it is untrusted, and the
  // `.eq("business_id", businessId)` beside it is what makes it safe. This is
  // the single most important predicate in this file: every read below keys
  // off values taken from THIS row, so a row from another tenant here would
  // poison all of them.
  const { data, error } = await deps.supabase
    .from("receipts")
    .select(DECISION_COLUMNS)
    .eq("id", receiptId)
    .eq("business_id", businessId)
    .maybeSingle<DecisionRow>();

  if (error !== null) {
    console.error(`[receipts/review-queue] decision read failed for receipt ${receiptId}`, error);
    return null;
  }
  if (data === null) return null;

  const [signals, lineItems, names, history, imageUrl] = await Promise.all([
    loadSignalsForReceipt(deps, businessId, data.id),
    loadLineItems(deps, businessId, data.id),
    loadDisplayNames(deps, [data.user_id]),
    loadConsumerHistory(deps, businessId, data.user_id),
    signReceiptImage(deps, data.image_path),
  ]);

  return {
    receiptId: data.id,
    status: isReviewQueueStatus(data.status) ? data.status : "review",
    consumerName: names.get(data.user_id) ?? null,
    // Doc 37 S9 / guard 4 of server/review.ts. Computed here so the screen can
    // explain it up front rather than letting the reviewer discover it after
    // they have retyped six fields.
    submittedByViewer: data.user_id === viewerId,
    createdAt: data.created_at,
    reviewedAt: data.reviewed_at,
    rejectReason: data.reject_reason,
    fields: {
      merchantName: data.merchant_name,
      receiptNumber: data.receipt_number,
      receiptDate: data.receipt_date,
      subtotalCentavos: data.subtotal_centavos,
      taxCentavos: data.tax_centavos,
      totalCentavos: data.total_centavos,
    },
    lineItems,
    parseMeta: parseParseMeta(data.parse_meta),
    parseConfidence: data.parse_confidence,
    matchConfidence: data.match_confidence,
    signals,
    imageUrl,
    history,
  };
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

async function loadSignalsByReceipt(
  deps: ReviewQueueDeps,
  businessId: string,
  receiptIds: readonly string[],
): Promise<Map<string, FraudSignalView[]>> {
  const byReceipt = new Map<string, FraudSignalView[]>();
  if (receiptIds.length === 0) return byReceipt;

  // TENANCY: `.eq("business_id", businessId)` on `fraud_signals` itself. The
  // receipt ids were already tenant-filtered by the caller, so this is the
  // second fence rather than the first, but 0017 gives fraud_signals its own
  // business_id (tied to the parent receipt by a composite FK) precisely so
  // this table can be filtered on its own terms, and it is.
  const { data, error } = await deps.supabase
    .from("fraud_signals")
    .select("id, receipt_id, signal, severity, score, evidence, created_at")
    .eq("business_id", businessId)
    .in("receipt_id", [...receiptIds])
    .order("created_at", { ascending: true });

  if (error !== null) {
    console.error("[receipts/review-queue] signal read failed", error);
    return byReceipt;
  }

  for (const row of (data ?? []) as SignalRow[]) {
    const list = byReceipt.get(row.receipt_id) ?? [];
    list.push({
      id: row.id,
      signal: row.signal,
      severity: toSeverity(row.severity),
      score: Number(row.score),
      evidence: toEvidence(row.evidence),
      createdAt: row.created_at,
      matchedReceipt: null,
      matchedReceiptOutsideTenant: false,
    });
    byReceipt.set(row.receipt_id, list);
  }
  return byReceipt;
}

/**
 * One receipt's signals, with any `matched_receipt_id` in their evidence
 * resolved into something a human can read.
 *
 * The resolution is the delicate part. A pHash neighbour is drawn from the
 * union of the consumer's own history and this business's history (see
 * `detectImageHashDuplicate` in server/process.ts), so the matched receipt can
 * legitimately belong to ANOTHER MERCHANT. Rendering its merchant, date and
 * total here would publish one tenant's data inside another tenant's review
 * screen, which is exactly the leak this file exists to prevent. So the lookup
 * is tenant-scoped, and a match that does not resolve is reported as existing
 * and nothing more.
 */
async function loadSignalsForReceipt(
  deps: ReviewQueueDeps,
  businessId: string,
  receiptId: string,
): Promise<FraudSignalView[]> {
  const byReceipt = await loadSignalsByReceipt(deps, businessId, [receiptId]);
  const signals = byReceipt.get(receiptId) ?? [];

  const matchedIds = Array.from(
    new Set(
      signals
        .map((signal) => signal.evidence.matched_receipt_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  );
  if (matchedIds.length === 0) return signals;

  // TENANCY: `.eq("business_id", businessId)`. The ids in `matchedIds` come
  // out of a jsonb evidence column and may name receipts at other businesses;
  // this predicate is the only thing that keeps those rows out of the render.
  const { data, error } = await deps.supabase
    .from("receipts")
    .select(
      "id, merchant_name, receipt_number, receipt_date, total_centavos, status, created_at",
    )
    .eq("business_id", businessId)
    .in("id", matchedIds);

  if (error !== null) {
    console.error("[receipts/review-queue] matched receipt read failed", error);
  }

  const matched = new Map<string, MatchedReceiptView>();
  for (const row of (data ?? []) as Array<{
    id: string;
    merchant_name: string | null;
    receipt_number: string | null;
    receipt_date: string | null;
    total_centavos: number | null;
    status: string;
    created_at: string;
  }>) {
    matched.set(row.id, {
      receiptId: row.id,
      merchantName: row.merchant_name,
      receiptNumber: row.receipt_number,
      receiptDate: row.receipt_date,
      totalCentavos: row.total_centavos,
      status: row.status,
      createdAt: row.created_at,
    });
  }

  return signals.map((signal) => {
    const id = signal.evidence.matched_receipt_id;
    if (typeof id !== "string") return signal;
    const hit = matched.get(id) ?? null;
    return { ...signal, matchedReceipt: hit, matchedReceiptOutsideTenant: hit === null };
  });
}

async function loadLineItems(
  deps: ReviewQueueDeps,
  businessId: string,
  receiptId: string,
): Promise<ReviewLineItemView[]> {
  // TENANCY: `.eq("business_id", businessId)` alongside the receipt id.
  // `receipt_line_items` carries its own business_id under the same composite
  // FK pattern, so it is filtered on its own terms rather than trusted to
  // follow its parent.
  const { data, error } = await deps.supabase
    .from("receipt_line_items")
    .select("id, raw_text, qty, unit_price_centavos, line_total_centavos, sort")
    .eq("business_id", businessId)
    .eq("receipt_id", receiptId)
    .order("sort", { ascending: true });

  if (error !== null) {
    console.error("[receipts/review-queue] line item read failed", error);
    return [];
  }

  return ((data ?? []) as Array<{
    id: string;
    raw_text: string;
    qty: number | null;
    unit_price_centavos: number | null;
    line_total_centavos: number | null;
    sort: number;
  }>).map((row) => ({
    id: row.id,
    rawText: row.raw_text,
    qty: row.qty === null ? null : Number(row.qty),
    unitPriceCentavos: row.unit_price_centavos,
    lineTotalCentavos: row.line_total_centavos,
    sort: row.sort,
  }));
}

/**
 * Display names for the submitters shown in the queue.
 *
 * TENANCY NOTE, since this is the one query here with no `business_id`
 * predicate and the reviewer will look for it: `profiles` has no tenant. The
 * ids handed in are always taken from `receipts.user_id` on rows that a
 * business-scoped query already returned, so the set of names this can reach
 * is exactly the set of people who submitted a receipt to THIS business. Only
 * `display_name` is selected: `phone`, `birth_date` and the suspension columns
 * are not the reviewer's business and RA 10173 data minimisation says so.
 */
async function loadDisplayNames(
  deps: ReviewQueueDeps,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return new Map();

  const { data, error } = await deps.supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", unique);

  if (error !== null) {
    console.error("[receipts/review-queue] display name read failed", error);
    return new Map();
  }
  return new Map(
    ((data ?? []) as Array<{ id: string; display_name: string }>).map((row) => [
      row.id,
      row.display_name,
    ]),
  );
}

/**
 * Doc 37's "consumer's history summary", SCOPED TO THIS TENANT.
 *
 * The doc's own list is "approval ratio, prior signals, strikes, devices". The
 * first two are answered here from this business's own rows. Strikes and
 * devices are deliberately NOT answered: a strike count is cross-tenant by
 * construction (doc 37's cooldown ladder counts fraud-family rejections
 * platform-wide) and a device list is cross-tenant personal data, so surfacing
 * either would tell one merchant what a consumer did at another merchant. Doc
 * 37 assigns the platform-wide view to the ADMIN fraud queue, which is out of
 * scope for this slice; this is the business queue.
 */
async function loadConsumerHistory(
  deps: ReviewQueueDeps,
  businessId: string,
  consumerId: string,
): Promise<ConsumerHistoryView> {
  const empty: ConsumerHistoryView = {
    receiptsAtBusiness: 0,
    approvedAtBusiness: 0,
    rejectedAtBusiness: 0,
    priorSignalsAtBusiness: 0,
  };

  // TENANCY: `.eq("business_id", businessId)` AND `.eq("user_id", consumerId)`.
  // Without the business predicate this would be the consumer's entire scan
  // history across every merchant on the platform.
  const receipts = await deps.supabase
    .from("receipts")
    .select("status")
    .eq("business_id", businessId)
    .eq("user_id", consumerId)
    .limit(500);

  if (receipts.error !== null) {
    console.error("[receipts/review-queue] consumer history read failed", receipts.error);
    return empty;
  }

  const rows = (receipts.data ?? []) as Array<{ status: string }>;
  const approved = rows.filter((row) => row.status === "approved").length;
  const rejected = rows.filter((row) => row.status === "rejected").length;

  // TENANCY: same pair of predicates on `fraud_signals`. Its `consumer_id` is
  // the submitter and its `business_id` is the tenant the signal was raised
  // for, so both are required for "prior signals AT THIS BUSINESS".
  const signals = await deps.supabase
    .from("fraud_signals")
    .select("id")
    .eq("business_id", businessId)
    .eq("consumer_id", consumerId)
    .limit(500);

  if (signals.error !== null) {
    console.error("[receipts/review-queue] consumer signal count failed", signals.error);
  }

  return {
    receiptsAtBusiness: rows.length,
    approvedAtBusiness: approved,
    rejectedAtBusiness: rejected,
    priorSignalsAtBusiness: (signals.data ?? []).length,
  };
}

/**
 * The 5-minute signed URL (doc 15), minted only after the caller has proven
 * the receipt belongs to their business.
 *
 * TENANCY: `imagePath` is never a parameter of this module's public API. It is
 * read off the receipt row that `loadReviewDecisionItem` already constrained
 * with `.eq("business_id", businessId)`, so an object key can only be signed
 * for a receipt the caller was allowed to open. 0019 gives the bucket no staff
 * policy at all, which makes this the ONLY path a business owner has to a
 * receipt image, and it is why the minting stays server-side.
 */
async function signReceiptImage(
  deps: ReviewQueueDeps,
  imagePath: string,
): Promise<string | null> {
  const prefix = `${RECEIPTS_BUCKET}/`;
  const objectPath = imagePath.startsWith(prefix) ? imagePath.slice(prefix.length) : imagePath;

  const { data, error } = await deps.supabase.storage
    .from(RECEIPTS_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

  if (error !== null || data === null) {
    console.error("[receipts/review-queue] could not sign the receipt image", error);
    return null;
  }
  return data.signedUrl;
}
