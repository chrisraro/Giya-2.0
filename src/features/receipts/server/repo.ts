import "server-only";

import { createClient } from "@/lib/supabase/server";

import type {
  ReceiptDetailDTO,
  ReceiptLineItemDTO,
  ReceiptListItemDTO,
  ReceiptStatus,
} from "../types";

// Consumer-facing reads for the receipts slice (doc 36 "API surface":
// GET /api/v1/me/receipts and GET /api/v1/me/receipts/{id}, plus the
// /scan/[receiptId] status screen and the /receipts history list).
//
// TWO NON-NEGOTIABLES GOVERN EVERY QUERY IN THIS FILE.
//
// 1. COLUMNS ARE NAMED, ALWAYS. 0017_receipts.sql revoked the table-level
//    SELECT on `receipts` from `authenticated` and re-granted exactly 13
//    columns. `select *` as a signed-in user now raises 42501, and that is
//    the point: reject_note (free-text reviewer commentary that can name a
//    matched receipt or another consumer), parse_meta, match_confidence,
//    parse_confidence, sha256 and image_hash are deliberately unreadable.
//    RECEIPT_CLIENT_COLUMNS below is the whole allowlist; nothing in this
//    file may widen it, and nothing outside the service role may try.
//
// 2. RLS IS NOT OWNERSHIP. `receipts` RLS is a UNION of two select policies -
//    receipts_consumer_select (user_id = auth.uid()) OR receipts_staff_select
//    (active owner/manager of the matched business). A row coming back from a
//    session-scoped query is therefore NOT necessarily the caller's own
//    receipt: an owner of the business reads their whole tenant's receipts
//    through the same client. Every function here that serves a /me/ surface
//    therefore constrains user_id ITSELF and never relies on RLS alone. This
//    is the same trap src/features/rewards/server/claim-ownership.ts exists
//    for on reward_claims, and it is handled the same way: absent and
//    not-yours both resolve to null, so callers answer one indistinguishable
//    404 (doc 13).
//
// Query style matches every other repo in this codebase: plain single-table
// queries joined in application code, no PostgREST embedded-resource selects.

/**
 * Exactly the column allowlist granted to `authenticated` by
 * 0017_receipts.sql. Exported so a test can assert that no query in the
 * codebase names a column outside it.
 */
export const RECEIPT_CLIENT_COLUMNS = [
  "id",
  "user_id",
  "business_id",
  "status",
  "reject_reason",
  "merchant_name",
  "receipt_number",
  "receipt_date",
  "total_centavos",
  "image_path",
  "source",
  "created_at",
  "processed_at",
] as const;

/**
 * The subset this slice's read surfaces actually select. Narrower than the
 * grant on purpose (doc 13: "Response DTOs are ... explicitly mapped from DB
 * rows - never `select *` straight to JSON"):
 *
 *   - `user_id` is selected because the ownership re-check above needs it.
 *   - `image_path` is NOT selected. It is a private-bucket object key that is
 *     useless without a signed URL, and the thumbnail surface that needs one
 *     is doc 33's [V1] receipt detail, not this slice. Selecting it would
 *     publish the storage layout for no present benefit.
 *   - `source` is NOT selected: every row this slice creates is 'scan', and
 *     the pos/digital adapters are [SCALE].
 */
const RECEIPT_READ_COLUMNS =
  "id, user_id, business_id, status, reject_reason, merchant_name, receipt_number, receipt_date, total_centavos, created_at, processed_at";

/** Row shape returned by RECEIPT_READ_COLUMNS. */
interface ReceiptReadRow {
  id: string;
  user_id: string;
  business_id: string | null;
  status: string;
  reject_reason: string | null;
  merchant_name: string | null;
  receipt_number: string | null;
  receipt_date: string | null;
  total_centavos: number | null;
  created_at: string;
  processed_at: string | null;
}

const RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  "queued",
  "processing",
  "review",
  "approved",
  "rejected",
];

/** Narrow the DB's `text` status to the domain union, defaulting to the safest reading. */
function toReceiptStatus(value: string): ReceiptStatus {
  return (RECEIPT_STATUSES as readonly string[]).includes(value)
    ? (value as ReceiptStatus)
    : "processing";
}

const REJECT_REASONS = [
  "duplicate",
  "unreadable",
  "wrong_business",
  "too_old",
  "fraud_suspected",
  "manual",
] as const;

function toRejectReason(value: string | null): ReceiptDetailDTO["rejectReason"] {
  if (!value) return null;
  return (REJECT_REASONS as readonly string[]).includes(value)
    ? (value as ReceiptDetailDTO["rejectReason"])
    : // An unrecognised reason must never fall through to "no reason", which
      // would render the rejected screen with no explanation at all. 'manual'
      // is the catch-all bucket and its copy is deliberately generic.
      "manual";
}

function toListItem(row: ReceiptReadRow, businessName: string | null, points: number | null): ReceiptListItemDTO {
  return {
    receiptId: row.id,
    businessId: row.business_id,
    businessName,
    status: toReceiptStatus(row.status),
    rejectReason: toRejectReason(row.reject_reason),
    merchantName: row.merchant_name,
    receiptNumber: row.receipt_number,
    receiptDate: row.receipt_date,
    totalCentavos: row.total_centavos,
    createdAt: row.created_at,
    processedAt: row.processed_at,
    pointsAwarded: points,
  };
}

/**
 * Points actually awarded for a set of receipts, read from the LEDGER rather
 * than inferred.
 *
 * Sourcing note (this was a deliberate choice, see the task report): the
 * awarded figure comes from `points_transactions` rows with `type='earn'` and
 * this `receipt_id`, which consumers may read for themselves via
 * pt_consumer_select (`consumer_id = auth.uid()`, verified live) with no
 * column-level restriction on that table. The ledger is the only truth about
 * points (doc 35); deriving the number from a wallet balance delta would be a
 * guess that breaks the moment a redemption or an expiry lands in the same
 * window, and `pt_receipt_earn_once` guarantees at most one earn row per
 * receipt so there is nothing to disambiguate.
 *
 * Receipts with no earn row are simply absent from the map (not zero): the
 * UI must distinguish "awarded 0" from "not awarded yet".
 */
async function loadAwardedPoints(receiptIds: readonly string[]): Promise<Map<string, number>> {
  if (receiptIds.length === 0) return new Map();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("points_transactions")
    .select("receipt_id, points")
    .eq("type", "earn")
    .in("receipt_id", [...receiptIds]);

  if (error || !data) return new Map();

  const byReceipt = new Map<string, number>();
  for (const row of data) {
    if (!row.receipt_id) continue;
    byReceipt.set(row.receipt_id, (byReceipt.get(row.receipt_id) ?? 0) + row.points);
  }
  return byReceipt;
}

async function loadBusinessNames(businessIds: readonly string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(businessIds));
  if (unique.length === 0) return new Map();

  const supabase = await createClient();
  const { data } = await supabase.from("businesses").select("id, name").in("id", unique);
  return new Map((data ?? []).map((business) => [business.id, business.name]));
}

export interface ListMyReceiptsArgs {
  userId: string;
  limit: number;
  /** Keyset position from the previous page: rows strictly older than this. */
  cursor: { sortKey: string; id: string } | null;
  // Explicitly `| undefined` because this project runs with
  // exactOptionalPropertyTypes: callers pass a status that may or may not be
  // present, and forcing each of them to build the object conditionally buys
  // nothing here.
  status?: ReceiptStatus | undefined;
}

export interface ListMyReceiptsResult {
  /** `limit + 1` rows when another page exists; the caller trims via buildPage. */
  rows: ReceiptListItemDTO[];
}

/**
 * The caller's own receipts, newest first, keyset-paginated on
 * `(created_at desc, id desc)` per doc 13's default sort.
 *
 * PostgREST has no row-value comparison, so `(created_at, id) < ($1, $2)` is
 * written as its disjunctive equivalent. `.or()` inside a filtered query is
 * ANDed with the other filters by PostgREST, so the user_id and status
 * constraints still apply to both branches.
 *
 * Over-fetches one row so the caller can answer `has_more` without a count.
 */
export async function listMyReceipts(args: ListMyReceiptsArgs): Promise<ListMyReceiptsResult> {
  const supabase = await createClient();

  let query = supabase
    .from("receipts")
    .select(RECEIPT_READ_COLUMNS)
    // Not redundant with RLS: receipts_staff_select would otherwise fold an
    // owner's whole tenant into their personal /me/ history.
    .eq("user_id", args.userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(args.limit + 1);

  if (args.status) {
    query = query.eq("status", args.status);
  }

  if (args.cursor) {
    // Both components are interpolated into PostgREST's filter grammar, where
    // `,` `(` `)` are structural. They are safe to interpolate only because
    // decodeCursor has already pinned sortKey to an ISO-8601 timestamp and id
    // to a UUID; do not build a cursor here by any other route.
    query = query.or(
      `created_at.lt.${args.cursor.sortKey},and(created_at.eq.${args.cursor.sortKey},id.lt.${args.cursor.id})`,
    );
  }

  const { data, error } = await query;
  if (error || !data) return { rows: [] };

  const rows = data as ReceiptReadRow[];
  const [businessNames, awarded] = await Promise.all([
    loadBusinessNames(rows.flatMap((row) => (row.business_id ? [row.business_id] : []))),
    loadAwardedPoints(rows.map((row) => row.id)),
  ]);

  return {
    rows: rows.map((row) =>
      toListItem(
        row,
        row.business_id ? (businessNames.get(row.business_id) ?? null) : null,
        awarded.get(row.id) ?? null,
      ),
    ),
  };
}

/**
 * One receipt belonging to the caller, with its line items.
 *
 * Returns null both when the receipt does not exist and when it exists but
 * belongs to somebody else (including the case where RLS let a business
 * owner's read through). Callers answer a single generic 404 for both, per
 * doc 13's rule that absent and outside-caller-scope are never distinguished -
 * the same decision the reward-claim token route made, for the same reason:
 * distinguishing them turns the endpoint into an id oracle.
 */
export async function getMyReceipt(
  receiptId: string,
  userId: string,
): Promise<ReceiptDetailDTO | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("receipts")
    .select(RECEIPT_READ_COLUMNS)
    .eq("id", receiptId)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as ReceiptReadRow;
  if (row.user_id !== userId) return null;

  const [businessNames, awarded, lineItems] = await Promise.all([
    loadBusinessNames(row.business_id ? [row.business_id] : []),
    loadAwardedPoints([row.id]),
    listReceiptLineItems(row.id),
  ]);

  return {
    ...toListItem(
      row,
      row.business_id ? (businessNames.get(row.business_id) ?? null) : null,
      awarded.get(row.id) ?? null,
    ),
    lineItems,
  };
}

/**
 * Line items for one receipt. `receipt_line_items` has no column-level grant
 * narrowing (0017 left the table grant intact and fenced it with RLS alone,
 * because nothing on it is fraud-sensitive), but the columns are still named:
 * `match_score` and `product_id` are parser internals of no use to a consumer
 * and are not selected.
 */
export async function listReceiptLineItems(receiptId: string): Promise<ReceiptLineItemDTO[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("receipt_line_items")
    .select("id, raw_text, qty, unit_price_centavos, line_total_centavos, sort")
    .eq("receipt_id", receiptId)
    .order("sort", { ascending: true });

  if (error || !data) return [];

  return data.map((item) => ({
    id: item.id,
    rawText: item.raw_text,
    qty: item.qty,
    unitPriceCentavos: item.unit_price_centavos,
    lineTotalCentavos: item.line_total_centavos,
    sort: item.sort,
  }));
}
