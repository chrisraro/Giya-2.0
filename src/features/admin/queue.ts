import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

import type { FraudSeverity } from "../receipts/fraud";
import { FRAUD_FAMILY_REJECT_REASONS } from "../receipts/server/cooldown";
import { parseParseMeta } from "../receipts/review/queue";
import type { FraudSignalView, ReviewLineItemView } from "../receipts/review/types";
import { compositeFraudScore, highestSeverity } from "./presenter";
import type {
  AdminAuditEntry,
  AdminFraudFilter,
  AdminQueueItem,
  AdminReceiptDetail,
  AdminReceiptFilter,
  AdminSignalItem,
  ClawbackEligibility,
  ConsumerStandingView,
  PlatformOverview,
} from "./types";

// ===========================================================================
// SERVICE-ROLE READS FOR THE PLATFORM ADMIN PORTAL.
//
// ---------------------------------------------------------------------------
// THERE IS NO TENANCY PREDICATE IN THIS FILE. READ THIS FIRST.
// ---------------------------------------------------------------------------
// `features/receipts/review/queue.ts` opens with a long header explaining that
// every `.eq("business_id", businessId)` in it IS the fence, because the
// service role bypasses RLS. This file is its platform-wide sibling and the
// fence is somewhere else entirely: `resolveAdminContext()` in ./access.ts,
// called by the layout above every page and by every server action.
//
// That is not a weaker guarantee, but it IS a different one, and the difference
// has to be stated or someone will copy a function out of here into a business
// surface. Nothing in this module may ever be called from a route that is not
// under `(admin)`, and no function here takes a business id, precisely so that
// "which tenant am I allowed to see" is never a question this layer answers.
// If a business-scoped read is needed, the business queue already has it.
//
// Why the service role at all, same as the business queue: 0017's column-level
// grant withholds `parse_meta`, both confidences, `reject_note`, `sha256` and
// `image_hash` from `authenticated`, and column privileges are role-wide, so an
// admin is no better placed than a consumer to read them through a policy.
// 0031's admin policies fix the ROW visibility (and are what make a future
// admin API route or client-side lookup correct); they cannot fix the columns,
// and the migration says so at length.
//
// FAILURE SHAPE, inherited deliberately: every public read returns `null` for
// "could not be read" and `[]` / a number only for "read successfully". An
// empty admin fraud queue is a claim that the platform is clean. A dropped
// connection is not entitled to make it.
//
// Docs: docs/30-modules/31-admin-portal.md §2 and §5,
// docs/30-modules/37-fraud-detection.md ("Review queues", evidence contract).
// ===========================================================================

const RECEIPTS_BUCKET = "receipts";

/** doc 15: receipt images are private, signed URLs only, TTL 5 minutes. */
const SIGNED_URL_TTL_SECONDS = 300;

/** Ceiling on one queue page. These are working lists, not archives. */
const QUEUE_LIMIT = 100;

/** Ceiling on a standing read. Bounded because it is per-consumer and unfiltered. */
const STANDING_LIMIT = 500;

/**
 * How many MATCHED receipt images may be signed for one decision screen.
 *
 * Doc 37 asks for a side-by-side comparison on duplicate matches and a receipt
 * can carry several dup signals; each extra image is a storage round trip on a
 * page render. Four covers every real case (the pipeline emits at most one
 * pHash and one number match per receipt today) and puts a hard ceiling on the
 * worst one.
 */
const MATCHED_IMAGE_LIMIT = 4;

/** doc 37 consequences ladder step 2: strikes are counted over 30 days. */
const STRIKE_WINDOW_DAYS = 30;

/** doc 37 alerting: the block-signal rate is measured against a 7-day baseline. */
const BLOCK_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface AdminQueueDeps {
  /** MUST be the service-role client. See the header. */
  supabase: SupabaseClient<Database>;
  now: () => Date;
}

/**
 * Production wiring. Null when the service-role key is absent, which every
 * caller renders as an explicit "cannot load right now" rather than as an empty
 * platform.
 */
export function defaultAdminDeps(): AdminQueueDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[admin/queue] SUPABASE_SERVICE_ROLE_KEY is not configured; the admin portal cannot read anything",
    );
    return null;
  }
  return { supabase, now: () => new Date() };
}

// ---------------------------------------------------------------------------
// Row shapes and column lists
// ---------------------------------------------------------------------------

/** Columns are named, never `select *`, for 0017's reasons and for auditability. */
const QUEUE_COLUMNS =
  "id, business_id, user_id, status, merchant_name, receipt_number, receipt_date, total_centavos, created_at, reviewed_at, reject_reason";

const DETAIL_COLUMNS = `${QUEUE_COLUMNS}, subtotal_centavos, tax_centavos, reject_note, image_path, parse_meta, parse_confidence, match_confidence, device_id`;

interface QueueRow {
  id: string;
  business_id: string | null;
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

interface DetailRow extends QueueRow {
  subtotal_centavos: number | null;
  tax_centavos: number | null;
  reject_note: string | null;
  image_path: string;
  parse_meta: unknown;
  parse_confidence: number | null;
  match_confidence: number | null;
  device_id: string | null;
}

interface SignalRow {
  id: string;
  receipt_id: string;
  business_id: string | null;
  consumer_id: string;
  signal: string;
  severity: string;
  score: number;
  evidence: unknown;
  created_at: string;
}

const SIGNAL_COLUMNS =
  "id, receipt_id, business_id, consumer_id, signal, severity, score, evidence, created_at";

const SEVERITIES: readonly FraudSeverity[] = ["info", "warn", "block"];

function toSeverity(value: string): FraudSeverity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as FraudSeverity) : "info";
}

function toEvidence(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toSignalView(row: SignalRow): FraudSignalView {
  return {
    id: row.id,
    signal: row.signal,
    severity: toSeverity(row.severity),
    score: Number(row.score),
    evidence: toEvidence(row.evidence),
    createdAt: row.created_at,
    // Resolved separately for the admin, across tenants. The business queue
    // resolves these two fields tenant-scoped and leaves the rest null; here
    // they are filled in by `loadAdminSignals` below.
    matchedReceipt: null,
    matchedReceiptOutsideTenant: false,
  };
}

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

/**
 * Business names for the ids on a page of rows.
 *
 * Only `id` and `name`. A queue row needs to say WHICH tenant a flagged receipt
 * belongs to; it does not need that tenant's address, plan or contact details,
 * and pulling the row wholesale would put them in a React tree.
 */
async function loadBusinessNames(
  deps: AdminQueueDeps,
  businessIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(businessIds.filter((id): id is string => id !== null)));
  if (unique.length === 0) return new Map();

  const { data, error } = await deps.supabase
    .from("businesses")
    .select("id, name")
    .in("id", unique);

  if (error !== null) {
    console.error("[admin/queue] business name read failed", error);
    return new Map();
  }
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]),
  );
}

/**
 * Display names for the consumers on a page of rows.
 *
 * Only `display_name`, exactly as the business queue does. An admin CAN see
 * more (0031 and the service role both allow it), but "may" is not "needs":
 * RA 10173 data minimisation applies to the platform operator too, and a queue
 * row that carries a phone number has published it to every screenshot of that
 * queue.
 */
async function loadDisplayNames(
  deps: AdminQueueDeps,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(userIds));
  if (unique.length === 0) return new Map();

  const { data, error } = await deps.supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", unique);

  if (error !== null) {
    console.error("[admin/queue] display name read failed", error);
    return new Map();
  }
  return new Map(
    ((data ?? []) as Array<{ id: string; display_name: string }>).map((row) => [
      row.id,
      row.display_name,
    ]),
  );
}

/** Signals for a page of receipts, grouped by receipt. */
async function loadSignalsByReceipt(
  deps: AdminQueueDeps,
  receiptIds: readonly string[],
): Promise<Map<string, SignalRow[]>> {
  const byReceipt = new Map<string, SignalRow[]>();
  if (receiptIds.length === 0) return byReceipt;

  const { data, error } = await deps.supabase
    .from("fraud_signals")
    .select(SIGNAL_COLUMNS)
    .in("receipt_id", [...receiptIds])
    .order("created_at", { ascending: true });

  if (error !== null) {
    console.error("[admin/queue] signal read failed", error);
    return byReceipt;
  }

  for (const row of (data ?? []) as SignalRow[]) {
    const list = byReceipt.get(row.receipt_id) ?? [];
    list.push(row);
    byReceipt.set(row.receipt_id, list);
  }
  return byReceipt;
}

/** Assemble queue rows into the shape the screens render. */
async function toQueueItems(
  deps: AdminQueueDeps,
  rows: readonly QueueRow[],
): Promise<AdminQueueItem[]> {
  if (rows.length === 0) return [];

  const [signalsByReceipt, businessNames, consumerNames] = await Promise.all([
    loadSignalsByReceipt(deps, rows.map((row) => row.id)),
    loadBusinessNames(deps, rows.map((row) => row.business_id)),
    loadDisplayNames(deps, rows.map((row) => row.user_id)),
  ]);

  return rows.map((row) => {
    const signals = (signalsByReceipt.get(row.id) ?? []).map(toSignalView);
    return {
      receiptId: row.id,
      businessId: row.business_id,
      businessName: row.business_id === null ? null : (businessNames.get(row.business_id) ?? null),
      consumerId: row.user_id,
      consumerName: consumerNames.get(row.user_id) ?? null,
      merchantName: row.merchant_name,
      receiptNumber: row.receipt_number,
      totalCentavos: row.total_centavos,
      createdAt: row.created_at,
      status: row.status,
      rejectReason: row.reject_reason,
      topSeverity: highestSeverity(signals),
      signalCount: signals.length,
      fraudScore: compositeFraudScore(signals),
      staffSelfScan: signals.some((signal) => signal.signal === "staff_self_scan"),
    } satisfies AdminQueueItem;
  });
}

// ---------------------------------------------------------------------------
// The fraud queue (doc 37 "Admin fraud queue", doc 31 §5)
// ---------------------------------------------------------------------------

/**
 * doc 37: "Fed by block/warn signals, S9 items, business escalations, ring
 * cases [V1]."
 *
 * Three of those four are implemented; the honesty about the fourth matters.
 * Ring cases are explicitly [V1] and need the nightly sweep. BUSINESS
 * ESCALATIONS have no mechanism in the schema yet - doc 36 describes items
 * reaching the admin queue by "cross-tenant patterns, staff dispute, or
 * business inactivity > SLA", and only the last of those is observable today.
 * It IS observable, though: a receipt still sitting in `review` long after the
 * tenant should have decided it is exactly "business inactivity > SLA", and the
 * `open` filter surfaces it with its queue age, so an escalation that nobody
 * files still lands in front of an admin.
 *
 * The two filters are driven off DIFFERENT tables on purpose, because they are
 * different questions and each has its own index:
 *
 *   * `open`    - "what needs a human", driven off `receipts.status='review'`
 *                 (`receipts_review_idx`, a partial index on exactly this).
 *   * `blocked` - "what did the platform stop", driven off `fraud_signals`
 *                 severity, which is not a receipt state at all: a blocking
 *                 signal auto-rejects, so these receipts are never in `review`
 *                 and a receipts-driven query would return none of them.
 *   * `all`     - every flagged receipt, driven off signals of warn severity
 *                 and above plus every staff self-scan.
 */
export interface ListAdminFraudQueueInput {
  filter: AdminFraudFilter;
}

export async function listAdminFraudQueue(
  input: ListAdminFraudQueueInput,
  deps: AdminQueueDeps | null = defaultAdminDeps(),
): Promise<AdminQueueItem[] | null> {
  if (deps === null) return null;

  if (input.filter === "open") {
    const { data, error } = await deps.supabase
      .from("receipts")
      .select(QUEUE_COLUMNS)
      .eq("status", "review")
      // Oldest first: doc 36 sets the SLA and the oldest item is the one at
      // risk, exactly as in the business queue.
      .order("created_at", { ascending: true })
      .limit(QUEUE_LIMIT);

    if (error !== null) {
      console.error("[admin/queue] open fraud queue read failed", error);
      return null;
    }
    return toQueueItems(deps, (data ?? []) as QueueRow[]);
  }

  const severities = input.filter === "blocked" ? ["block"] : ["warn", "block"];
  const { data: signalRows, error: signalError } = await deps.supabase
    .from("fraud_signals")
    .select("receipt_id, created_at, severity, signal")
    .in("severity", severities)
    .order("created_at", { ascending: false })
    // Read more signals than the page holds: several signals can share one
    // receipt, so the distinct receipt count after grouping is smaller than the
    // row count before it.
    .limit(QUEUE_LIMIT * 4);

  if (signalError !== null) {
    console.error("[admin/queue] fraud signal feed read failed", signalError);
    return null;
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const row of (signalRows ?? []) as Array<{ receipt_id: string }>) {
    if (seen.has(row.receipt_id)) continue;
    seen.add(row.receipt_id);
    ordered.push(row.receipt_id);
    if (ordered.length >= QUEUE_LIMIT) break;
  }
  if (ordered.length === 0) return [];

  const { data, error } = await deps.supabase
    .from("receipts")
    .select(QUEUE_COLUMNS)
    .in("id", ordered);

  if (error !== null) {
    console.error("[admin/queue] fraud queue receipt read failed", error);
    return null;
  }

  const items = await toQueueItems(deps, (data ?? []) as QueueRow[]);
  // Restore the signal ordering (most recently flagged first). The `in` query
  // above returns rows in whatever order the planner likes, and "most recent
  // signal" is the order an admin works this list in.
  const rank = new Map(ordered.map((id, index) => [id, index]));
  return items.sort((a, b) => (rank.get(a.receiptId) ?? 0) - (rank.get(b.receiptId) ?? 0));
}

// ---------------------------------------------------------------------------
// The cross-tenant receipt queue (doc 31 §5 `/admin/receipts`)
// ---------------------------------------------------------------------------

/**
 * doc 31 §5's escalation queue, plus the filter that only this portal can
 * serve.
 *
 * `unmatched` is the one to read twice. 0017's comment: "an unmatched receipt
 * (business_id null) is invisible to every tenant, and there is no admin policy
 * to catch it either. The pipeline MUST therefore always write a best-guess
 * business_id before routing a receipt to status='review'; a review-routed
 * receipt with a null business_id lands in a queue that no audience on this
 * database can select, and it would sit there forever." 0031 added the policy
 * and this filter is the surface that reads it. The pipeline's obligation is
 * unchanged - this is the safety net, not a licence to stop matching.
 */
export interface ListAdminReceiptsInput {
  filter: AdminReceiptFilter;
}

export async function listAdminReceipts(
  input: ListAdminReceiptsInput,
  deps: AdminQueueDeps | null = defaultAdminDeps(),
): Promise<AdminQueueItem[] | null> {
  if (deps === null) return null;

  let query = deps.supabase.from("receipts").select(QUEUE_COLUMNS);

  if (input.filter === "review") {
    query = query.eq("status", "review").order("created_at", { ascending: true });
  } else if (input.filter === "unmatched") {
    query = query.is("business_id", null).order("created_at", { ascending: true });
  } else {
    query = query
      .not("reviewed_at", "is", null)
      .order("reviewed_at", { ascending: false });
  }

  const { data, error } = await query.limit(QUEUE_LIMIT);

  if (error !== null) {
    console.error("[admin/queue] receipt queue read failed", error);
    return null;
  }
  return toQueueItems(deps, (data ?? []) as QueueRow[]);
}

// ---------------------------------------------------------------------------
// The decision screen
// ---------------------------------------------------------------------------

export interface LoadAdminReceiptInput {
  receiptId: string;
}

/**
 * Everything `/admin/receipts/[receiptId]` renders, or null when the id does
 * not name a receipt.
 *
 * There is no tenancy predicate here and there must not be: this is the screen
 * that exists to look at a receipt no tenant can. The `null` return therefore
 * genuinely means "no such receipt", which is safe to say to an admin and to
 * nobody else - which is why `resolveAdminContext()` runs in the layout above
 * this page.
 */
export async function loadAdminReceiptDetail(
  input: LoadAdminReceiptInput,
  deps: AdminQueueDeps | null = defaultAdminDeps(),
): Promise<AdminReceiptDetail | null> {
  if (deps === null) return null;

  const { data, error } = await deps.supabase
    .from("receipts")
    .select(DETAIL_COLUMNS)
    .eq("id", input.receiptId)
    .maybeSingle<DetailRow>();

  if (error !== null) {
    console.error(`[admin/queue] detail read failed for receipt ${input.receiptId}`, error);
    return null;
  }
  if (data === null) return null;

  const [signals, lineItems, businessNames, consumerNames, standing, imageUrl, clawback, history] =
    await Promise.all([
      loadAdminSignals(deps, data.id),
      loadLineItems(deps, data.id),
      loadBusinessNames(deps, [data.business_id]),
      loadDisplayNames(deps, [data.user_id]),
      loadConsumerStanding(deps, data.user_id),
      signReceiptImage(deps, data.image_path),
      loadClawbackEligibility(deps, data.id),
      loadReceiptAuditHistory(deps, data.id),
    ]);

  return {
    receiptId: data.id,
    businessId: data.business_id,
    businessName: data.business_id === null ? null : (businessNames.get(data.business_id) ?? null),
    consumerId: data.user_id,
    consumerName: consumerNames.get(data.user_id) ?? null,
    status: data.status,
    rejectReason: data.reject_reason,
    rejectNote: data.reject_note,
    createdAt: data.created_at,
    reviewedAt: data.reviewed_at,
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
    standing,
    clawback,
    history,
  };
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

/**
 * One receipt's signals with their evidence resolved ACROSS TENANTS.
 *
 * This is the function that most differs from its business counterpart, and the
 * difference is doc 37's whole point. `loadSignalsForReceipt` in the business
 * queue scopes the matched-receipt lookup to the viewing tenant and reports an
 * out-of-tenant match as "the matching receipt was scanned at a different
 * business, so its details are not shown here". That placeholder IS the
 * cross-tenant duplicate ring, seen from inside one tenant. Here it resolves:
 * the other business is named, the other account is named, and both images are
 * signed so doc 37's "side-by-side image comparison for dup matches" is
 * actually possible.
 */
interface MatchedReceiptRow {
  id: string;
  business_id: string | null;
  user_id: string;
  image_path: string;
  merchant_name: string | null;
  receipt_number: string | null;
  receipt_date: string | null;
  total_centavos: number | null;
  status: string;
  created_at: string;
}

async function loadAdminSignals(
  deps: AdminQueueDeps,
  receiptId: string,
): Promise<AdminSignalItem[]> {
  const byReceipt = await loadSignalsByReceipt(deps, [receiptId]);
  const rows = byReceipt.get(receiptId) ?? [];
  if (rows.length === 0) return [];

  const matchedIds = Array.from(
    new Set(
      rows
        .map((row) => toEvidence(row.evidence).matched_receipt_id)
        .filter((value): value is string => typeof value === "string"),
    ),
  );

  const matchedRows = new Map<string, MatchedReceiptRow>();
  if (matchedIds.length > 0) {
    const { data, error } = await deps.supabase
      .from("receipts")
      .select(
        "id, business_id, user_id, image_path, merchant_name, receipt_number, receipt_date, total_centavos, status, created_at",
      )
      .in("id", matchedIds);

    if (error !== null) {
      console.error("[admin/queue] matched receipt read failed", error);
    }
    for (const row of (data ?? []) as MatchedReceiptRow[]) {
      matchedRows.set(row.id, row);
    }
  }

  const matched = Array.from(matchedRows.values());
  // One lookup for both the tenants that RAISED these signals and the tenants
  // the matched receipts belong to, so the N+1 that a per-signal lookup would
  // create never exists.
  const [businessNames, consumerNames] = await Promise.all([
    loadBusinessNames(deps, [
      ...rows.map((row) => row.business_id),
      ...matched.map((row) => row.business_id),
    ]),
    loadDisplayNames(deps, matched.map((row) => row.user_id)),
  ]);

  const items: AdminSignalItem[] = [];
  let signedCount = 0;

  for (const row of rows) {
    const view = toSignalView(row);
    const matchedId = view.evidence.matched_receipt_id;
    const hit = typeof matchedId === "string" ? (matchedRows.get(matchedId) ?? null) : null;

    if (hit !== null) {
      view.matchedReceipt = {
        receiptId: hit.id,
        merchantName: hit.merchant_name,
        receiptNumber: hit.receipt_number,
        receiptDate: hit.receipt_date,
        totalCentavos: hit.total_centavos,
        status: hit.status,
        createdAt: hit.created_at,
      };
    } else if (typeof matchedId === "string") {
      // The evidence names a receipt that no longer resolves. Reported as
      // existing-but-unresolvable rather than dropped, reusing the flag the
      // business view uses, so the shared renderer still says something honest.
      view.matchedReceiptOutsideTenant = true;
    }

    let matchedImageUrl: string | null = null;
    if (hit !== null && signedCount < MATCHED_IMAGE_LIMIT) {
      matchedImageUrl = await signReceiptImage(deps, hit.image_path);
      signedCount += 1;
    }

    items.push({
      signal: view,
      businessName: row.business_id === null ? null : (businessNames.get(row.business_id) ?? null),
      matchedBusinessName:
        hit === null || hit.business_id === null
          ? null
          : (businessNames.get(hit.business_id) ?? null),
      matchedConsumerName: hit === null ? null : (consumerNames.get(hit.user_id) ?? null),
      matchedImageUrl,
    });
  }

  return items;
}

async function loadLineItems(
  deps: AdminQueueDeps,
  receiptId: string,
): Promise<ReviewLineItemView[]> {
  const { data, error } = await deps.supabase
    .from("receipt_line_items")
    .select("id, raw_text, qty, unit_price_centavos, line_total_centavos, sort")
    .eq("receipt_id", receiptId)
    .order("sort", { ascending: true });

  if (error !== null) {
    console.error("[admin/queue] line item read failed", error);
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
 * doc 37's "consumer's history summary", PLATFORM-WIDE.
 *
 * The business queue's version answers two of the doc's four items and its own
 * comment explains that "strikes and devices are deliberately NOT answered: a
 * strike count is cross-tenant by construction ... so surfacing either would
 * tell one merchant what a consumer did at another merchant. Doc 37 assigns the
 * platform-wide view to the ADMIN fraud queue." This is that view, and all four
 * items are answered.
 *
 * `strikes` reuses `FRAUD_FAMILY_REJECT_REASONS` from the cooldown module
 * rather than restating the list. That module is what the automatic ladder
 * counts, and a screen that counted a different set would show an admin a
 * number that contradicts the block the system already applied.
 */
async function loadConsumerStanding(
  deps: AdminQueueDeps,
  consumerId: string,
): Promise<ConsumerStandingView> {
  const empty: ConsumerStandingView = {
    receiptsTotal: 0,
    approved: 0,
    rejected: 0,
    approvalRatio: null,
    priorSignals: 0,
    strikes: 0,
    devices: 0,
    businesses: 0,
    scanBlockedUntil: null,
    isSuspended: false,
    suspendedReason: null,
  };

  const windowStart = isoDaysAgo(deps.now(), STRIKE_WINDOW_DAYS);

  const [receipts, signals, consumer, profile] = await Promise.all([
    deps.supabase
      .from("receipts")
      .select("status, reject_reason, business_id, device_id, created_at")
      .eq("user_id", consumerId)
      .order("created_at", { ascending: false })
      .limit(STANDING_LIMIT),
    deps.supabase
      .from("fraud_signals")
      .select("id")
      .eq("consumer_id", consumerId)
      .limit(STANDING_LIMIT),
    deps.supabase
      .from("consumers")
      .select("scan_blocked_until")
      .eq("id", consumerId)
      .maybeSingle<{ scan_blocked_until: string | null }>(),
    deps.supabase
      .from("profiles")
      .select("is_suspended, suspended_reason")
      .eq("id", consumerId)
      .maybeSingle<{ is_suspended: boolean; suspended_reason: string | null }>(),
  ]);

  if (receipts.error !== null) {
    console.error("[admin/queue] consumer standing read failed", receipts.error);
    return empty;
  }

  const rows = (receipts.data ?? []) as Array<{
    status: string;
    reject_reason: string | null;
    business_id: string | null;
    device_id: string | null;
    created_at: string;
  }>;

  const approved = rows.filter((row) => row.status === "approved").length;
  const rejected = rows.filter((row) => row.status === "rejected").length;
  const decided = approved + rejected;

  const strikes = rows.filter(
    (row) =>
      row.status === "rejected" &&
      row.reject_reason !== null &&
      (FRAUD_FAMILY_REJECT_REASONS as readonly string[]).includes(row.reject_reason) &&
      row.created_at >= windowStart,
  ).length;

  return {
    receiptsTotal: rows.length,
    approved,
    rejected,
    approvalRatio: decided === 0 ? null : approved / decided,
    priorSignals: (signals.data ?? []).length,
    strikes,
    devices: new Set(rows.map((row) => row.device_id).filter((id) => id !== null)).size,
    businesses: new Set(rows.map((row) => row.business_id).filter((id) => id !== null)).size,
    scanBlockedUntil: consumer.data?.scan_blocked_until ?? null,
    isSuspended: profile.data?.is_suspended ?? false,
    suspendedReason: profile.data?.suspended_reason ?? null,
  };
}

/**
 * Whether doc 37 ladder step 5 is available on this receipt.
 *
 * Asked here, from the ledger, so the screen can DISABLE the control and say
 * why. The RPC re-checks both conditions under the receipt lock and raises
 * `CLAWBACK_INVALID_STATE`; this read is a courtesy to the admin, never the
 * guard. Between this render and that call the state can change, and the RPC
 * is what decides.
 */
async function loadClawbackEligibility(
  deps: AdminQueueDeps,
  receiptId: string,
): Promise<ClawbackEligibility> {
  const { data, error } = await deps.supabase
    .from("points_transactions")
    .select("id, type, points, reverses_id")
    .eq("receipt_id", receiptId);

  if (error !== null) {
    console.error("[admin/queue] clawback eligibility read failed", error);
    return { kind: "never_awarded" };
  }

  const rows = (data ?? []) as Array<{
    id: string;
    type: string;
    points: number;
    reverses_id: string | null;
  }>;

  const earn = rows.find((row) => row.type === "earn");
  if (earn === undefined) return { kind: "never_awarded" };

  const reversal = rows.find(
    (row) => (row.type === "clawback" || row.type === "reversal") && row.reverses_id === earn.id,
  );
  if (reversal !== undefined) {
    return { kind: "already_reversed", clawedPoints: Math.abs(reversal.points) };
  }

  return { kind: "eligible", earnPoints: earn.points };
}

/**
 * Every audited decision ever made about this receipt, newest first.
 *
 * Served by `audit_entity_idx` (0022's `(entity_type, entity_id, created_at
 * desc)`), which is why the query names `entity_type` even though `entity_id`
 * alone would be selective enough in practice - 0022's own comment explains
 * that ids come from different tables and nothing stops a collision.
 *
 * `ip` and `user_agent` are NOT selected. They are outside the `authenticated`
 * grant on purpose and the service role can read them, but doc 15 draws the
 * privacy line well short of putting an actor's network address on a review
 * screen; the incident-response read that legitimately needs them is a separate
 * surface with its own justification.
 */
async function loadReceiptAuditHistory(
  deps: AdminQueueDeps,
  receiptId: string,
): Promise<AdminAuditEntry[]> {
  const { data, error } = await deps.supabase
    .from("audit_logs")
    .select("id, action, actor_id, actor_kind, actor_role, reason, created_at")
    .eq("entity_type", "receipt")
    .eq("entity_id", receiptId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error !== null) {
    console.error("[admin/queue] audit history read failed", error);
    return [];
  }

  const rows = (data ?? []) as Array<{
    id: string;
    action: string;
    actor_id: string | null;
    actor_kind: string;
    actor_role: string | null;
    reason: string | null;
    created_at: string;
  }>;

  const names = await loadDisplayNames(
    deps,
    rows.map((row) => row.actor_id).filter((id): id is string => id !== null),
  );

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    actorKind: row.actor_kind,
    actorRole: row.actor_role,
    actorName: row.actor_id === null ? null : (names.get(row.actor_id) ?? null),
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

/**
 * A 5-minute signed URL (doc 15).
 *
 * `imagePath` is never a parameter of this module's public API: it is read off
 * a receipt row this module already fetched. 0019 gives the bucket no client
 * policy at all, so a server-minted URL is the only path to a receipt image.
 */
async function signReceiptImage(
  deps: AdminQueueDeps,
  imagePath: string,
): Promise<string | null> {
  const prefix = `${RECEIPTS_BUCKET}/`;
  const objectPath = imagePath.startsWith(prefix) ? imagePath.slice(prefix.length) : imagePath;

  const { data, error } = await deps.supabase.storage
    .from(RECEIPTS_BUCKET)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS);

  if (error !== null || data === null) {
    console.error("[admin/queue] could not sign a receipt image", error);
    return null;
  }
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// The platform overview (doc 31 §2)
// ---------------------------------------------------------------------------

/**
 * Counts a bounded read can answer, plus the most recent blocking signals.
 *
 * REAL DATA ONLY. Every number below is a live count over an indexed predicate;
 * there is no fixture, no seeded sample and no placeholder. A tile whose
 * backing table does not exist yet is simply not on this screen (see
 * `PlatformOverview` for the list and why).
 *
 * Each count is capped by a `limit` and counted client-side rather than asked
 * for as an exact `count`, the same shape `countPendingReview` uses: the
 * difference between 140 and 200 changes nothing an admin does, and a bounded
 * read cannot be made slow by a bad week.
 */
export const OVERVIEW_COUNT_CAP = 499;

export async function loadPlatformOverview(
  deps: AdminQueueDeps | null = defaultAdminDeps(),
): Promise<PlatformOverview> {
  const unavailable: PlatformOverview = {
    businessesAwaitingVerification: null,
    receiptsInReview: null,
    fraudBlocks7d: null,
    unmatchedReceipts: null,
    recentBlocks: [],
  };
  if (deps === null) return unavailable;

  const blockWindowStart = isoDaysAgo(deps.now(), BLOCK_WINDOW_DAYS);

  const [pendingBusinesses, inReview, blocks, unmatched] = await Promise.all([
    deps.supabase
      .from("businesses")
      .select("id")
      .eq("status", "pending_verification")
      .is("deleted_at", null)
      .limit(OVERVIEW_COUNT_CAP + 1),
    deps.supabase
      .from("receipts")
      .select("id")
      .eq("status", "review")
      .limit(OVERVIEW_COUNT_CAP + 1),
    deps.supabase
      .from("fraud_signals")
      .select("receipt_id, created_at")
      .eq("severity", "block")
      .gte("created_at", blockWindowStart)
      .order("created_at", { ascending: false })
      .limit(OVERVIEW_COUNT_CAP + 1),
    deps.supabase
      .from("receipts")
      .select("id")
      .is("business_id", null)
      .limit(OVERVIEW_COUNT_CAP + 1),
  ]);

  const blockRows = (blocks.data ?? []) as Array<{ receipt_id: string }>;
  const recentIds = Array.from(new Set(blockRows.map((row) => row.receipt_id))).slice(0, 5);

  let recentBlocks: AdminQueueItem[] = [];
  if (blocks.error === null && recentIds.length > 0) {
    const { data, error } = await deps.supabase
      .from("receipts")
      .select(QUEUE_COLUMNS)
      .in("id", recentIds);
    if (error === null) {
      recentBlocks = await toQueueItems(deps, (data ?? []) as QueueRow[]);
    } else {
      console.error("[admin/queue] recent block read failed", error);
    }
  }

  return {
    businessesAwaitingVerification:
      pendingBusinesses.error === null ? (pendingBusinesses.data ?? []).length : null,
    receiptsInReview: inReview.error === null ? (inReview.data ?? []).length : null,
    fraudBlocks7d: blocks.error === null ? blockRows.length : null,
    unmatchedReceipts: unmatched.error === null ? (unmatched.data ?? []).length : null,
    recentBlocks,
  };
}
