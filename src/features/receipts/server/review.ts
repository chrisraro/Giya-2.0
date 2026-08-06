import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import { receiptRejectReasonSchema, reviewFieldsSchema } from "../schemas";
import type { ReviewFields } from "../schemas";
import type { ReceiptRejectReason } from "../types";
import { awardApprovedReceipt } from "./award";
import type { AwardResult } from "./award";
import { applyCooldownIfEarned, isFraudFamilyRejectReason } from "./cooldown";
import { notifyReceiptOutcome } from "./notify";
import { getReceiptSettings } from "./settings";
import type { ReceiptSettings } from "./settings";

// ===========================================================================
// The human review service: doc 36 Stage 9's "Human review queue", the only
// way a receipt leaves status='review'.
//
// This is simultaneously a MONEY path (approving mints points) and an
// INSIDER-CONTROL path (the person deciding is a member of the tenant that
// benefits). Both properties are why the guard order below is normative rather
// than incidental, and why it is tested as an ORDER, not as a set.
//
// ---------------------------------------------------------------------------
// GUARD ORDER (spec section 4, verbatim)
// ---------------------------------------------------------------------------
//   1. The receipt exists                      -> RECEIPT_NOT_FOUND
//   2. The actor is an ACTIVE owner/manager of
//      receipts.business_id                    -> FORBIDDEN
//   3. The receipt is in 'review'              -> RECEIPT_NOT_REVIEWABLE
//   4. The actor is NOT the submitter          -> FORBIDDEN   (doc 37 S9)
//   5. Approve: validate, persist, award       (./award.ts, shared verbatim
//                                               with the pipeline)
//   6. Reject: persist, run the strike ladder  (./cooldown.ts, ditto)
//   7. Exactly one audit_logs row, real before/after
//
// The order matters in both directions. Checking membership BEFORE status
// means a stranger probing receipt ids learns "forbidden" rather than "that id
// exists and has already been decided". Checking self-review AFTER membership
// means the error a staff member gets for their own receipt is the same
// FORBIDDEN a non-member gets, which is what doc 37 S9 asks for.
//
// GUARD 4 IS THE MOST IMPORTANT LINE IN THIS FILE. Doc 37 S9: "The review
// service additionally rejects a decision where the reviewer is the submitter
// (reviewed_by = receipts.user_id -> 403 FORBIDDEN)." The fraud pipeline
// already routes every staff self-scan to `review` unconditionally, so without
// this guard the pipeline's own control would hand the self-dealer the exact
// screen that lets them approve themselves.
//
// ---------------------------------------------------------------------------
// AUDIT ORDERING: the audit row is written BEFORE the award, not after
// ---------------------------------------------------------------------------
// These are separate statements through PostgREST, not one transaction, so one
// of two failure modes is unavoidable. The choice is deliberate.
//
// CAN IT BE MADE ATOMIC? Not without breaking a bigger rule. A single
// `review_receipt` RPC could hold the decision write, the audit row and the
// award in one transaction - but only by moving the AWARD into SQL, and the
// award is `computePoints`, a pure TypeScript engine that doc 35 section 11
// requires to have exactly one implementation (it also serves the consumer's
// optimistic preview). Reimplementing the rule math in plpgsql to gain
// atomicity would create the second award path that T2 exists to prevent, and
// a points engine that disagrees with itself is a far worse failure than a
// missing log line. A narrower RPC covering only the decision write plus the
// audit row IS possible, and would close most of this gap; it needs its own
// migration and is recorded as debt for the slice that has one, because the
// remaining gap (award outside the transaction) would still exist and is
// already the gap the pipeline lives with.
//
// GIVEN THAT, WHICH ORDER? Audit first, and the asymmetry is not close:
//
//   * Audit LAST, award fails to be audited: points are minted and there is no
//     record of who authorized it. That is unrecoverable - the actor cannot be
//     reconstructed after the fact from any other row - and it is precisely
//     threat-model item 6 (insider abuse), whose entire documented mitigation
//     is "least privilege, full audit" (doc 15).
//   * Audit FIRST, award then fails: an audit row exists saying "this manager
//     approved this receipt", which is TRUE - the receipt is 'approved' in the
//     database, written by the statement immediately before. The audit row
//     records the DECISION, not the payment; the payment has its own, better
//     record in `points_transactions`, and 0018 names `processed_at is null`
//     as exactly the difference between "approved and paid" and "approved,
//     award pending". Nothing is claimed that did not happen.
//
// For the same reason, a FAILED audit insert aborts the award (and the
// cooldown): the decision is already persisted and recoverable, whereas
// continuing would mint the unauditable points the ordering exists to prevent.
//
// Docs: docs/30-modules/36-receipt-ocr-pipeline.md Stages 9-10,
// docs/30-modules/37-fraud-detection.md (S9, consequences ladder step 2, the
// reviewer-action -> audit mapping), docs/10-architecture/15-security.md,
// supabase/migrations/0022_audit_logs.sql, and the slice spec section 4.
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The roles doc 01's permission matrix and 0017's `receipts_staff_select`
 * policy both name. `marketing` and `staff` are deliberately absent: they
 * cannot even SELECT a receipt, so they must not be able to decide one.
 */
const REVIEWER_ROLES = ["owner", "manager"] as const;

/** Doc 37's reviewer-action -> `audit_logs.action` mapping. */
const AUDIT_ACTION_APPROVED = "receipt.review_approved";
const AUDIT_ACTION_REJECTED = "receipt.review_rejected";

/**
 * `audit_logs.entity_type`. Doc 25 annotates the column as "table name of the
 * subject row", which would read `receipts`; the slice spec fixes the singular
 * subject noun instead, and consistency across every row this system ever
 * writes matters more than either reading, since `audit_entity_idx` leads with
 * this column. Kept as one constant so a future registry can settle it in one
 * edit rather than in every writer.
 */
const AUDIT_ENTITY_TYPE = "receipt";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Everything this service talks to that is not pure, injected in the same
 * shape `ProcessReceiptDeps` uses so the two suites stay consistent.
 *
 * `supabase` MUST be the SERVICE ROLE client. Spec section 2: 0017's
 * column-level grant withholds `parse_meta` and friends from `authenticated`,
 * and column privileges are role-wide, so staff read and write receipts
 * through the service role with the tenancy predicate applied IN CODE. Guard 2
 * below is that predicate, and it is the only thing standing between a
 * reviewer and another tenant's queue.
 */
export interface ReviewDeps {
  supabase: SupabaseClient<Database>;
  now: () => Date;
  /** Business scope overrides platform scope; never throws (see settings.ts). */
  loadSettings: (businessId?: string) => Promise<ReceiptSettings>;
}

/**
 * The production wiring. Returns null when the service-role key is absent
 * (createServiceRoleClient's documented degraded path), which callers surface
 * as DEPENDENCY_UNAVAILABLE rather than silently doing nothing.
 */
export function defaultReviewDeps(): ReviewDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[receipts/review] SUPABASE_SERVICE_ROLE_KEY is not configured; cannot decide receipts",
    );
    return null;
  }
  return { supabase, loadSettings: getReceiptSettings, now: () => new Date() };
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type ReviewAction = "approve" | "reject";

/**
 * Every code this service can refuse with. `RECEIPT_NOT_REVIEWABLE` is doc
 * 36's registered 409; `FORBIDDEN` is doc 13's standard 403 and is used for
 * BOTH authorization failures on purpose (see the guard-order note above).
 */
export type ReviewErrorCode =
  | "RECEIPT_NOT_FOUND"
  | "FORBIDDEN"
  | "RECEIPT_NOT_REVIEWABLE"
  | "RECEIPT_FIELDS_INVALID"
  | "REVIEW_WRITE_FAILED"
  | "AUDIT_WRITE_FAILED"
  | "DEPENDENCY_UNAVAILABLE";

export type ReviewOutcome =
  | { ok: true; status: "approved"; award: AwardResult }
  | { ok: true; status: "rejected"; reason: ReceiptRejectReason }
  | { ok: false; code: ReviewErrorCode; message: string; fieldErrors: string[] };

/**
 * `fields` and `rejectReason` are `unknown` deliberately. The caller is a
 * server action or a Route Handler holding a form payload, so the Zod parse in
 * step 5/6 has to be the real gate rather than a formality a typed parameter
 * lets someone skip with a cast.
 */
export interface ReviewReceiptInput {
  receiptId: string;
  /** `profiles.id` of the signed-in reviewer, resolved from the session by the caller. */
  actorId: string;
  action: ReviewAction;
  fields?: unknown;
  rejectReason?: unknown;
  rejectNote?: string;
  /** Correlates this decision with the request log line (doc 25). */
  requestId: string;
  deps?: ReviewDeps | null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** Exactly the columns the guards, the write, the audit diff and pricing need. */
interface ReceiptRow {
  id: string;
  business_id: string | null;
  user_id: string;
  status: string;
  created_at: string;
  merchant_name: string | null;
  receipt_number: string | null;
  receipt_date: string | null;
  subtotal_centavos: number | null;
  tax_centavos: number | null;
  total_centavos: number | null;
  reject_reason: string | null;
  reject_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

const RECEIPT_COLUMNS =
  "id, business_id, user_id, status, created_at, merchant_name, receipt_number, receipt_date, subtotal_centavos, tax_centavos, total_centavos, reject_reason, reject_note, reviewed_by, reviewed_at";

type AuditLogColumns = Database["public"]["Tables"]["audit_logs"]["Insert"];

/**
 * The columns a STAFF DECISION always supplies. `audit_logs` (0022) also
 * carries system-actor rows, so the generated `Insert` makes nearly everything
 * optional and nullable; a decision made by a person has all of it, and an
 * audit row for one with no actor, no business or no reason is not a record of
 * anything. Listing them here re-requires them without restating their types,
 * which the generated `Database` now owns.
 */
type AlwaysAudited =
  | "actor_id"
  | "actor_role"
  | "business_id"
  | "entity_id"
  | "reason"
  | "request_id";

/**
 * One `audit_logs` row as this service writes it, built on the generated
 * `Database` type so the column names and their types are checked against the
 * live schema and a later migration that renames one fails the build here.
 *
 * `actor_kind` is pinned to "user" rather than left as the column's `string`,
 * because this file is only ever reached from a signed-in reviewer; a system
 * actor writing through here would be a bug in the caller, not a widening.
 * `before` and `after` are required but stay `Json`, which is nullable by
 * construction: a decision that changed nothing writes two empty objects, and
 * the diff, not the type, is what says so.
 *
 * Note what this does NOT open up: no update, no delete, no upsert.
 * `writeAuditRow` below is the only statement this feature aims at the table,
 * and the table itself is append-only at three layers in the database
 * (privilege revoke, row trigger, truncate trigger).
 */
type AuditLogInsert = AuditLogColumns & {
  [K in AlwaysAudited]: NonNullable<AuditLogColumns[K]>;
} & { actor_kind: "user"; before: Json; after: Json };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(
  code: ReviewErrorCode,
  message: string,
  fieldErrors: string[] = [],
): ReviewOutcome {
  return { ok: false, code, message, fieldErrors };
}

/** Round-trip through JSON exactly as the wire would, as every jsonb writer here does. */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

type FieldValue = string | number | null;

/**
 * The audit diff. Only keys whose value ACTUALLY changed appear, in both
 * `before` and `after`, so the pair reads as a genuine statement about this
 * decision rather than a copy of the row.
 *
 * Doc 25 is explicit that PII minimization is the writer's job because the
 * columns are granted to the tenant owner: dumping the whole receipt in here
 * would publish `parse_meta` and the consumer's submitted GPS to a surface
 * 0017 deliberately withholds them from.
 */
function diffFields(
  before: Readonly<Record<string, FieldValue>>,
  after: Readonly<Record<string, FieldValue>>,
): { before: Json; after: Json; changed: string[] } {
  const beforeChanged: Record<string, FieldValue> = {};
  const afterChanged: Record<string, FieldValue> = {};
  const changed: string[] = [];

  for (const key of Object.keys(after)) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (from === to) continue;
    beforeChanged[key] = from;
    afterChanged[key] = to;
    changed.push(key);
  }

  return { before: toJson(beforeChanged), after: toJson(afterChanged), changed };
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * Postgres hands a `timestamptz` back as `2026-07-24T05:45:00+00:00` while
 * everything written from here is `...Z`. Both name the same instant, so the
 * diff has to compare normalized forms or every untouched date would show up
 * as a correction the reviewer never made.
 */
function normalizeTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Decide one receipt sitting in `review`.
 *
 * NEVER THROWS: every refusal is a typed `ok: false` outcome, because the
 * caller is a server action rendering a message beside the receipt image, and
 * an exception there would lose the reviewer's work on a state they could have
 * been told about.
 */
export async function reviewReceipt(input: ReviewReceiptInput): Promise<ReviewOutcome> {
  const deps = input.deps === undefined ? defaultReviewDeps() : input.deps;
  if (deps === null) {
    return fail(
      "DEPENDENCY_UNAVAILABLE",
      "Receipt review is not available right now. Try again shortly.",
    );
  }

  const { supabase } = deps;
  const { receiptId, actorId, requestId } = input;

  // ---- Guard 1: the receipt exists ---------------------------------------
  const { data: receipt, error: loadError } = await supabase
    .from("receipts")
    .select(RECEIPT_COLUMNS)
    .eq("id", receiptId)
    .maybeSingle<ReceiptRow>();

  if (loadError !== null) {
    console.error(`[receipts/review] could not load receipt ${receiptId}`, loadError);
    return fail("REVIEW_WRITE_FAILED", "Could not load that receipt. Try again.");
  }
  if (receipt === null) {
    return fail("RECEIPT_NOT_FOUND", "That receipt does not exist.");
  }

  // ---- Guard 2: active owner/manager of THIS receipt's tenant -------------
  //
  // Table truth, exactly the predicate `private.is_active_staff` evaluates
  // (0010): business_staff row, this business, this user, status='active',
  // role in the list. No claim, no session assertion, no business id from the
  // caller - the tenant is taken from the RECEIPT, so a staff member of tenant
  // A cannot reach tenant B's queue by supplying B's id.
  const businessId = receipt.business_id;
  if (businessId === null) {
    // 0017 states that a review-routed receipt always carries a business_id
    // (a receipt with no match is rejected as wrong_business, never parked in
    // review), so this is unreachable by construction. If construction is ever
    // wrong, no one is staff of null and the answer is the same FORBIDDEN.
    return fail("FORBIDDEN", "You cannot review that receipt.");
  }

  const { data: staff, error: staffError } = await supabase
    .from("business_staff")
    .select("role")
    .eq("business_id", businessId)
    .eq("user_id", actorId)
    .eq("status", "active")
    .in("role", [...REVIEWER_ROLES])
    .maybeSingle<{ role: string }>();

  if (staffError !== null) {
    // FAIL CLOSED. An authorization read that errored proves nothing, and the
    // one thing it must never do is fall through to the decision.
    console.error(
      `[receipts/review] staff check failed for actor ${actorId} on business ${businessId}`,
      staffError,
    );
    return fail("FORBIDDEN", "You cannot review that receipt.");
  }
  if (staff === null) {
    return fail("FORBIDDEN", "You cannot review that receipt.");
  }
  const actorRole = staff.role;

  // ---- Guard 3: the receipt is still in 'review' --------------------------
  //
  // This check is the ERROR ORDER, not the race guard. The race guard is the
  // `.eq("status", "review")` predicate carried by the decision write below,
  // which is the campaigns slice's `setCampaignStatus` pattern: fold the
  // expected state into the WHERE clause and treat zero affected rows as a
  // conflict, so two managers with the same item open cannot both decide it.
  // Checking here as well is what lets an already-decided receipt answer
  // RECEIPT_NOT_REVIEWABLE without first writing anything.
  if (receipt.status !== "review") {
    return fail(
      "RECEIPT_NOT_REVIEWABLE",
      "That receipt has already been decided. Refresh the queue.",
    );
  }

  // ---- Guard 4: the reviewer is not the submitter (doc 37 S9) ------------
  //
  // THE INSIDER CONTROL. Placed before every write in this function, which is
  // why the test for it asserts that NOTHING was written, not merely that the
  // call returned an error.
  if (receipt.user_id === actorId) {
    console.warn(
      `[receipts/review] actor ${actorId} attempted to decide their own receipt ${receiptId}`,
    );
    return fail("FORBIDDEN", "You cannot decide a receipt you submitted yourself.");
  }

  if (input.action === "approve") {
    return approve({ deps, receipt, businessId, actorId, actorRole, requestId, input });
  }
  return reject({ deps, receipt, businessId, actorId, actorRole, requestId, input });
}

interface DecisionContext {
  deps: ReviewDeps;
  receipt: ReceiptRow;
  businessId: string;
  actorId: string;
  actorRole: string;
  requestId: string;
  input: ReviewReceiptInput;
}

// ---------------------------------------------------------------------------
// Guard 5: approve
// ---------------------------------------------------------------------------

async function approve(context: DecisionContext): Promise<ReviewOutcome> {
  const { deps, receipt, businessId, actorId, actorRole, requestId, input } = context;
  const { supabase } = deps;

  // ---- Validate the reviewer's corrections -------------------------------
  let fields: ReviewFields | null = null;
  if (input.fields !== undefined && input.fields !== null) {
    const parsed = reviewFieldsSchema.safeParse(input.fields);
    if (!parsed.success) {
      return fail(
        "RECEIPT_FIELDS_INVALID",
        "Some of the corrected fields are not valid.",
        parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "fields"}: ${issue.message}`,
        ),
      );
    }
    fields = parsed.data;
  }

  const parsedDate = normalizeTimestamp(receipt.receipt_date);
  const effective = {
    merchant_name: fields === null ? receipt.merchant_name : fields.merchant_name,
    receipt_number: fields === null ? receipt.receipt_number : fields.receipt_number,
    receipt_date: fields === null ? parsedDate : toIsoOrNull(fields.receipt_date),
    subtotal_centavos: fields === null ? receipt.subtotal_centavos : fields.subtotal_centavos,
    tax_centavos: fields === null ? receipt.tax_centavos : fields.tax_centavos,
    total_centavos: fields === null ? receipt.total_centavos : fields.total_centavos,
  };

  // Doc 36 Stage 8's readability rule, restated for the human path: a receipt
  // with no total cannot be priced, and approving one would award zero without
  // ever telling the reviewer why. Only reachable when the reviewer approved
  // as-parsed; the field schema makes the total mandatory when they edit.
  if (effective.total_centavos === null) {
    return fail(
      "RECEIPT_FIELDS_INVALID",
      "This receipt has no total. Enter the total before approving it.",
      ["total_centavos: Required"],
    );
  }

  // ---- The single conditional decision write -----------------------------
  const decidedAt = deps.now().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("receipts")
    .update({
      ...effective,
      status: "approved",
      // A receipt that reaches 'approved' carries no rejection. `reject_note`
      // is deliberately left alone: `awardPoints` writes its award-failure
      // diagnostics there moments from now, and clearing it here would be
      // clearing a field that only ever gets written after this statement.
      reject_reason: null,
      reviewed_by: actorId,
      reviewed_at: decidedAt,
    })
    .eq("id", receipt.id)
    .eq("business_id", businessId)
    // OPTIMISTIC CONCURRENCY, per `setCampaignStatus` (campaigns/server/repo.ts):
    // the expected state is a WHERE predicate, not an in-memory check, so the
    // loser of a two-manager race matches zero rows and is told so.
    .eq("status", "review")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (updateError !== null) {
    console.error(
      `[receipts/review] could not approve receipt ${receipt.id}`,
      updateError,
    );
    return fail("REVIEW_WRITE_FAILED", "Could not save that decision. Try again.");
  }
  if (updated === null) {
    // Zero affected rows: the status is no longer 'review'. Someone else
    // decided it between our load and this statement.
    return fail(
      "RECEIPT_NOT_REVIEWABLE",
      "That receipt has already been decided. Refresh the queue.",
    );
  }

  // ---- Guard 7: the audit row, BEFORE the money -------------------------
  const diff = diffFields(
    {
      status: receipt.status,
      merchant_name: receipt.merchant_name,
      receipt_number: receipt.receipt_number,
      receipt_date: parsedDate,
      subtotal_centavos: receipt.subtotal_centavos,
      tax_centavos: receipt.tax_centavos,
      total_centavos: receipt.total_centavos,
      reject_reason: receipt.reject_reason,
      reviewed_by: receipt.reviewed_by,
      reviewed_at: receipt.reviewed_at,
    },
    {
      status: "approved",
      ...effective,
      reject_reason: null,
      reviewed_by: actorId,
      reviewed_at: decidedAt,
    },
  );
  // The reason text names the reviewer's CORRECTIONS, so the columns that move
  // on every approval by definition are not corrections and are dropped.
  const decisionKeys = ["status", "reject_reason", "reviewed_by", "reviewed_at"];
  const corrected = diff.changed.filter((key) => !decisionKeys.includes(key));

  const audited = await writeAuditRow(deps, {
    actor_id: actorId,
    actor_kind: "user",
    actor_role: actorRole,
    business_id: businessId,
    action: AUDIT_ACTION_APPROVED,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: receipt.id,
    before: diff.before,
    after: diff.after,
    reason:
      corrected.length === 0
        ? "Approved from the review queue with no field corrections."
        : `Approved from the review queue with corrected fields: ${corrected.join(", ")}.`,
    request_id: requestId,
  });
  if (!audited) {
    return fail(
      "AUDIT_WRITE_FAILED",
      "The decision was saved but could not be recorded, so no points were awarded. Contact support with this receipt.",
    );
  }

  // ---- Line items (analytics enrichment, never a gate on approval) -------
  // Deliberately after the audit row and outside its before/after: doc 36 says
  // line items "never gate approval", the rows themselves are the record of
  // what the reviewer entered, and copying an item list into an audit column
  // the tenant owner can read buys nothing.
  if (fields?.line_items !== undefined) {
    await replaceLineItems(deps, receipt.id, businessId, fields.line_items);
  }

  // ---- Guard 5, second half: the shared award path -----------------------
  //
  // The receipt is 'approved' in the database by now, which is exactly
  // `awardApprovedReceipt`'s stated precondition and 0018 step 2's guard. The
  // values handed over are the CORRECTED ones, so pricing follows the
  // reviewer's total rather than the parser's.
  const isFirstVisit = await readIsFirstVisit(deps, businessId, receipt.user_id);
  const award = await awardApprovedReceipt({
    deps: { supabase, now: deps.now },
    businessId,
    receipt: {
      id: receipt.id,
      userId: receipt.user_id,
      createdAt: receipt.created_at,
      totalCentavos: effective.total_centavos,
      receiptDate:
        effective.receipt_date === null ? null : new Date(effective.receipt_date),
    },
    isFirstVisit,
  });

  // `processed_at` is deliberately NOT written here on any branch. The shared
  // award path owns it: 0018 step 7 stamps it on the awarding path and 0023's
  // `record_receipt_visit` stamps it on the zero-point path, both inside the
  // same transaction as the work they describe. A REFUSED award leaves it
  // null on purpose - that is 0018's own marker for "approved, award pending",
  // and it is how support finds the row.

  // ---- Tell the consumer -------------------------------------------------
  // Doc 36 Stage 10 makes no distinction between an auto-approval and a human
  // one ("On `approved` (auto or human) ... enqueues notify.push
  // (kind='points_awarded')"), and neither does this: the same adapter, the
  // same copy matrix, the same shared `AwardResult`, so a reviewer's approval
  // reads identically to the pipeline's in the consumer's inbox.
  //
  // LAST, AND FAIL-SOFT. The decision is persisted, the audit row is written
  // and the points are minted by the time this runs, and
  // `notifyReceiptOutcome` cannot throw - a message that could not be composed
  // must not turn a completed approval into an error the reviewer sees.
  //
  // TODO(queue): doc 39's `notify.push`. The push send is enqueued from
  // ../../notifications/server/raise.ts once the jobs slice and the delivery
  // credentials land; this call site does not change shape.
  await notifyReceiptOutcome({
    deps: { supabase },
    userId: receipt.user_id,
    receiptId: receipt.id,
    businessId,
    outcome: { status: "approved", award },
  });

  console.info(
    `[receipts/review] receipt ${receipt.id} approved by ${actorRole} ${actorId} (award=${award.kind}) request=${requestId}`,
  );
  return { ok: true, status: "approved", award };
}

// ---------------------------------------------------------------------------
// Guard 6: reject
// ---------------------------------------------------------------------------

async function reject(context: DecisionContext): Promise<ReviewOutcome> {
  const { deps, receipt, businessId, actorId, actorRole, requestId, input } = context;
  const { supabase } = deps;

  const parsedReason = receiptRejectReasonSchema.safeParse(input.rejectReason);
  if (!parsedReason.success) {
    return fail(
      "RECEIPT_FIELDS_INVALID",
      "Choose a rejection reason.",
      parsedReason.error.issues.map((issue) => `rejectReason: ${issue.message}`),
    );
  }
  const reason: ReceiptRejectReason = parsedReason.data;

  const trimmedNote = input.rejectNote?.trim() ?? "";
  if (trimmedNote.length > 1000) {
    return fail("RECEIPT_FIELDS_INVALID", "That note is too long.", [
      "rejectNote: Maximum 1000 characters",
    ]);
  }
  const note = trimmedNote.length === 0 ? null : trimmedNote;

  const decidedAt = deps.now().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("receipts")
    .update({
      status: "rejected",
      reject_reason: reason,
      reject_note: note,
      reviewed_by: actorId,
      reviewed_at: decidedAt,
      // No award will write it, so the rejection stamps it itself.
      processed_at: decidedAt,
    })
    .eq("id", receipt.id)
    .eq("business_id", businessId)
    // Same optimistic-concurrency predicate as the approve path.
    .eq("status", "review")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (updateError !== null) {
    console.error(`[receipts/review] could not reject receipt ${receipt.id}`, updateError);
    return fail("REVIEW_WRITE_FAILED", "Could not save that decision. Try again.");
  }
  if (updated === null) {
    return fail(
      "RECEIPT_NOT_REVIEWABLE",
      "That receipt has already been decided. Refresh the queue.",
    );
  }

  const diff = diffFields(
    {
      status: receipt.status,
      reject_reason: receipt.reject_reason,
      reject_note: receipt.reject_note,
      reviewed_by: receipt.reviewed_by,
      reviewed_at: receipt.reviewed_at,
    },
    {
      status: "rejected",
      reject_reason: reason,
      reject_note: note,
      reviewed_by: actorId,
      reviewed_at: decidedAt,
    },
  );

  const audited = await writeAuditRow(deps, {
    actor_id: actorId,
    actor_kind: "user",
    actor_role: actorRole,
    business_id: businessId,
    action: AUDIT_ACTION_REJECTED,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: receipt.id,
    before: diff.before,
    after: diff.after,
    reason:
      note === null
        ? `Rejected from the review queue as ${reason}.`
        : `Rejected from the review queue as ${reason}: ${note}`,
    request_id: requestId,
  });
  if (!audited) {
    // Same rule as the approve path: an unrecorded decision does not get to
    // have consequences. The rejection itself stands; the strike does not.
    return fail(
      "AUDIT_WRITE_FAILED",
      "The decision was saved but could not be recorded. Contact support with this receipt.",
    );
  }

  // ---- Doc 37 consequences ladder step 2 ---------------------------------
  // ./cooldown.ts, the same function the pipeline calls on a fraud-family
  // rejection. A reviewer answering "duplicate" or "fraud_suspected" is
  // answering the same question the detector answers, so it counts the same;
  // `unreadable`, `too_old`, `wrong_business` and `manual` are quality or
  // matching outcomes and must never accumulate toward a scan block.
  if (isFraudFamilyRejectReason(reason)) {
    const settings = await deps.loadSettings(businessId);
    await applyCooldownIfEarned(
      { supabase, now: deps.now },
      receipt.user_id,
      settings,
      requestId,
    );
  }

  // ---- Tell the consumer -------------------------------------------------
  // The CONSUMER-SAFE reason only. `rejectionCopy(reason)` in ./notify.ts maps
  // the six enum values onto the tested copy matrix, and `rejectNote` - the
  // reviewer's free text, which may legitimately name another consumer's
  // receipt - is not passed to it and has no parameter that could carry it.
  // The reviewer's note stays where 0017 put it: unreadable by the client.
  //
  // Fail-soft and last, for the same reason as the approve path: the rejection
  // and the strike are already recorded.
  //
  // TODO(queue): doc 39's `notify.push`, as above.
  await notifyReceiptOutcome({
    deps: { supabase },
    userId: receipt.user_id,
    receiptId: receipt.id,
    businessId,
    outcome: { status: "rejected", reason },
  });

  console.info(
    `[receipts/review] receipt ${receipt.id} rejected (${reason}) by ${actorRole} ${actorId} request=${requestId}`,
  );
  return { ok: true, status: "rejected", reason };
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/**
 * The one audit row per decision. Returns false rather than throwing so the
 * caller can decide what a missing security record costs; both callers decide
 * the same thing (stop before the consequences).
 */
async function writeAuditRow(deps: ReviewDeps, row: AuditLogInsert): Promise<boolean> {
  const { error } = await deps.supabase.from("audit_logs").insert(row);
  if (error !== null) {
    console.error(
      `[receipts/review] could not audit ${row.action} on receipt ${row.entity_id}`,
      error,
    );
    return false;
  }
  return true;
}

/**
 * Delete and re-insert, exactly as the pipeline does: the previous split is a
 * parse artefact rather than evidence, which is why 0017 keeps DELETE on this
 * table for service_role and withholds it from `ocr_results` and
 * `fraud_signals`.
 *
 * Never fatal. Line items are analytics enrichment and "never a gate on
 * approval" (doc 36 Stage 7); losing them must not undo an approval that has
 * already been written and audited.
 */
async function replaceLineItems(
  deps: ReviewDeps,
  receiptId: string,
  businessId: string,
  items: ReviewFields["line_items"],
): Promise<void> {
  const rows = items ?? [];

  const { error: deleteError } = await deps.supabase
    .from("receipt_line_items")
    .delete()
    .eq("receipt_id", receiptId);
  if (deleteError !== null) {
    console.error(
      `[receipts/review] could not clear line items for receipt ${receiptId}`,
      deleteError,
    );
    return;
  }
  if (rows.length === 0) return;

  const { error } = await deps.supabase.from("receipt_line_items").insert(
    rows.map((item, index) => ({
      business_id: businessId,
      receipt_id: receiptId,
      raw_text: item.raw_text,
      qty: item.qty,
      unit_price_centavos: item.unit_price_centavos,
      line_total_centavos: item.line_total_centavos,
      sort: index,
    })),
  );
  if (error !== null) {
    console.error(
      `[receipts/review] could not write line items for receipt ${receiptId}`,
      error,
    );
  }
}

/**
 * Doc 35's `first_visit` condition. Read BEFORE the award, because the award
 * RPC increments `visit_count` itself (0018 step 5) and reading afterwards
 * would report every first visit as a repeat one.
 *
 * A missing pair row means the consumer has never transacted with this
 * business, which is a first visit by definition; a failed read degrades to
 * "not a first visit", the direction that under-awards rather than over-awards.
 */
async function readIsFirstVisit(
  deps: ReviewDeps,
  businessId: string,
  consumerId: string,
): Promise<boolean> {
  const { data, error } = await deps.supabase
    .from("business_customers")
    .select("visit_count")
    .eq("business_id", businessId)
    .eq("consumer_id", consumerId)
    .maybeSingle<{ visit_count: number }>();

  if (error !== null) {
    console.error(
      `[receipts/review] could not read the customer pair for ${businessId}`,
      error,
    );
    return false;
  }
  return (data?.visit_count ?? 0) === 0;
}
