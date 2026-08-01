import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import {
  MAX_OPEN_ESCALATIONS,
  canEscalateRejection,
  escalationRefusalCopy,
} from "../components/receipt-copy";
import type { EscalationRefusal } from "../components/receipt-copy";
import { receiptRejectReasonSchema } from "../schemas";
import type { ReviewReason } from "./process";

// ===========================================================================
// CONTESTING A REJECTION.
//
// One tap on a rejected receipt moves it into that merchant's review queue with
// the image attached, and the merchant is the only party who adjudicates it:
// they hold the POS record and may literally remember the customer. It turns a
// dead end into a thirty-second decision by the best-placed person.
//
// ---------------------------------------------------------------------------
// WHAT THIS SERVICE IS NOT: A SECOND PATH TO THE LEDGER
// ---------------------------------------------------------------------------
// READ THIS BEFORE ADDING ANYTHING TO IT. This module moves a receipt from
// 'rejected' back to 'review' and does NOTHING ELSE. It does not approve, it
// does not price, it does not touch `points_transactions`, and it must never
// learn how. The merchant's decision on an escalated receipt runs through
// `reviewReceipt` in ./review.ts exactly as it does for a receipt the pipeline
// routed - same guard order, same self-review block, same optimistic
// concurrency predicate, same audit row, same shared `awardApprovedReceipt`.
// Doc 36 requires ONE approval path so the ledger invariants hold, and the
// entire design of this feature is arranged around not becoming a second one.
//
// That constraint is what fixes the target status. `reviewReceipt` guard 3
// requires status='review' and folds `.eq("status","review")` into its decision
// write, so 'review' is not merely the obvious destination for an escalated
// receipt: it is the only destination from which the existing approval path is
// reachable at all. Any other status would have required widening that guard,
// which is the first step toward the second path.
//
// ---------------------------------------------------------------------------
// GUARD ORDER (and why it is this order)
// ---------------------------------------------------------------------------
//   1. The receipt exists                    -> NOT_FOUND
//   2. The actor IS the submitter            -> NOT_FOUND  (see below)
//   3. The receipt is 'rejected'             -> NOT_ESCALATABLE
//   4. It has never been escalated           -> ALREADY_ESCALATED
//   5. The reason is not fraud family        -> NOT_ESCALATABLE
//   6. It has a business to be escalated TO  -> NOT_ESCALATABLE
//   7. The consumer is under the open cap    -> LIMIT_REACHED
//   8. No live row claims its receipt number -> SUPERSEDED
//   9. The conditional write, 23505 caught   -> SUPERSEDED
//  10. The audit row, best effort            (see the note on auditing)
//
// GUARD 2 ANSWERS "NOT FOUND", NOT "FORBIDDEN", and that is deliberate and
// differs from ./review.ts on purpose. There, a stranger probing receipt ids is
// a staff member who legitimately holds SOME queue, so FORBIDDEN tells them
// nothing they could not already work out. Here the caller is any signed-in
// consumer and the id space is every receipt on the platform, so a distinct
// "forbidden" would make this action an existence oracle for other people's
// receipts. `getMyReceipt` in ./repo.ts collapses the same two cases for the
// same reason, and doc 13 asks for it.
//
// GUARD 5 IS THE ONE THAT MATTERS. `duplicate` and `fraud_suspected` offer no
// escalation. The reasoning is long and lives in one place, beside the copy it
// governs: see the ESCALATION header in ../components/receipt-copy.ts. The
// short version is that both are fraud family, both already advanced doc 37's
// strike ladder, and handing an abuser a retry loop against a human is exactly
// what doc 37 warns about. It is enforced HERE, server side, and the UI merely
// agrees with it: `canEscalateRejection` is the same function both call, but
// the client's copy of it is a courtesy and this one is the control.
//
// ---------------------------------------------------------------------------
// IS THE ESCALATION ITSELF AUDITED? YES, AND NOT FATALLY. Both halves matter.
// ---------------------------------------------------------------------------
// WHY AUDIT IT AT ALL, given that the merchant's decision already writes a row.
// Because that row records the DECISION and not the REQUEST. Without this one,
// `audit_logs` shows a manager approving a receipt that was rejected an hour
// earlier with no record of who asked for the second look, and the two most
// interesting patterns this feature could ever produce are invisible: an
// account that escalates everything, and a merchant whose staff coach customers
// into escalating. `escalated_at` on the row is state, not evidence - it is a
// mutable column on a table the service role can update - whereas `audit_logs`
// is append-only at three layers (0022) and is where an investigation looks.
//
// WHY A FAILED AUDIT DOES NOT ABORT IT, which is the opposite of ./review.ts.
// That file stops before the consequences because its consequence is MINTED
// POINTS, and unauditable points are threat-model item 6. This service's only
// consequence is that a merchant looks at a photograph. Nothing is minted, no
// privilege changes, and the decision that DOES move money is audited in full
// by `reviewReceipt` whatever happens here. Against that, failing closed would
// mean denying a customer their single remedy because a log line did not
// insert, which trades the whole point of the feature for a redundant record.
// The receipt sitting in the queue carrying `escalated_at` and
// `consumer_escalation` is itself durable evidence that this happened. So: log
// loudly, carry on.
//
// Docs: docs/30-modules/36-receipt-ocr-pipeline.md Stage 9,
// docs/30-modules/37-fraud-detection.md, supabase/migrations/0017_receipts.sql
// (the status constraint, `receipts_number_unique`, the write fence),
// supabase/migrations/0035_receipt_routing_visibility.sql (`review_reasons`),
// supabase/migrations/0036_receipt_escalation.sql,
// supabase/tests/receipt_escalation_smoke.sql.
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * 0035's routing vocabulary. Typed as `ReviewReason` so a rename in
 * ./process.ts breaks this file at build time rather than silently splitting
 * the breakdown into two spellings of one reason.
 */
const ESCALATION_REVIEW_REASON: ReviewReason = "consumer_escalation";

/** Doc 25's dot-namespaced verb registry, and 0022's `audit_logs_action_shape`. */
const AUDIT_ACTION_ESCALATED = "receipt.escalation_requested";

/** Matches ./review.ts: one singular subject noun across every writer. */
const AUDIT_ENTITY_TYPE = "receipt";

/**
 * The statuses `receipts_number_unique` covers (0017). A receipt number held by
 * a row in any of these is a LIVE claim, and an escalation cannot create a
 * second one.
 */
const LIVE_STATUSES = ["approved", "review", "processing"] as const;

/** Postgres unique-violation. The collision `receipts_number_unique` raises. */
const UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Injected in the same shape `ReviewDeps` uses, so the two suites stay
 * consistent and a test can drive both services the same way.
 *
 * `supabase` MUST be the SERVICE ROLE client. 0017 revoked INSERT and UPDATE on
 * `receipts` from `authenticated` and gave no client audience a write policy,
 * so this write has nowhere else to come from - and that is the point rather
 * than an inconvenience. Every guard below is code the client cannot skip; a
 * policy permissive enough to let a consumer set their own status='review'
 * would also let them set it on a receipt rejected as fraudulent.
 */
export interface EscalateDeps {
  supabase: SupabaseClient<Database>;
  now: () => Date;
}

/** Production wiring. Null when the service-role key is absent, per ./review.ts. */
export function defaultEscalateDeps(): EscalateDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[receipts/escalate] SUPABASE_SERVICE_ROLE_KEY is not configured; receipts cannot be escalated",
    );
    return null;
  }
  return { supabase, now: () => new Date() };
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type EscalateOutcome =
  | { ok: true; receiptId: string }
  | { ok: false; refusal: EscalationRefusal; message: string };

export interface EscalateReceiptInput {
  receiptId: string;
  /**
   * `profiles.id` of the signed-in consumer, resolved from the SESSION by the
   * caller and never taken from the payload. Guard 2 compares it against
   * `receipts.user_id`, so a value the client could supply would be the whole
   * authorization check handed to the browser.
   */
  actorId: string;
  /** Correlates this request with the log line and the audit row (doc 25). */
  requestId: string;
  deps?: EscalateDeps | null;
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  business_id: string | null;
  user_id: string;
  status: string;
  reject_reason: string | null;
  receipt_number: string | null;
  escalated_at: string | null;
  parse_meta: unknown;
}

const RECEIPT_COLUMNS =
  "id, business_id, user_id, status, reject_reason, receipt_number, escalated_at, parse_meta";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(refusal: EscalationRefusal): EscalateOutcome {
  // The sentence comes from the consumer copy matrix, which is the module the
  // forbidden-vocabulary sweep covers. This service never authors a string.
  return { ok: false, refusal, message: escalationRefusalCopy(refusal) };
}

function isUniqueViolation(error: PostgrestError | null): boolean {
  return error !== null && error.code === UNIQUE_VIOLATION;
}

/**
 * `parse_meta` with `consumer_escalation` appended to `review_reasons`.
 *
 * MERGED, NEVER ASSIGNED, for the same reason 0035's sweep merges rather than
 * assigns: whatever the pipeline recorded about this receipt is still true and
 * is still the reviewer's context. The reason that got it rejected in the first
 * place stays in the list beside the escalation, because both are honest
 * answers to "why is a human looking at this".
 *
 * Every read is defensive. `parse_meta` is jsonb written by an older build, a
 * newer build, or a hand-edit, and a malformed document must degrade to a fresh
 * list rather than throw and cost the customer their remedy.
 */
export function withEscalationReason(parseMeta: unknown): Json {
  const base: Record<string, unknown> =
    typeof parseMeta === "object" && parseMeta !== null && !Array.isArray(parseMeta)
      ? { ...(parseMeta as Record<string, unknown>) }
      : {};

  const existing = Array.isArray(base.review_reasons)
    ? base.review_reasons.filter((reason): reason is string => typeof reason === "string")
    : [];

  // Deduplicated, so a receipt that somehow reaches here twice cannot inflate
  // its own share of 0035's breakdown.
  const reasons = existing.includes(ESCALATION_REVIEW_REASON)
    ? existing
    : [...existing, ESCALATION_REVIEW_REASON];

  base.review_reasons = reasons;
  return JSON.parse(JSON.stringify(base)) as Json;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Move one rejected receipt back into its merchant's review queue.
 *
 * NEVER THROWS. Every refusal is a typed `ok: false` carrying a sentence from
 * the copy matrix, because the caller is a server action rendering beside a
 * receipt the customer is already unhappy about, and an exception there would
 * replace a plain explanation with an error page.
 */
export async function escalateReceipt(input: EscalateReceiptInput): Promise<EscalateOutcome> {
  const deps = input.deps === undefined ? defaultEscalateDeps() : input.deps;
  if (deps === null) return fail("UNAVAILABLE");

  const { supabase } = deps;
  const { receiptId, actorId, requestId } = input;

  // ---- Guard 1: the receipt exists ---------------------------------------
  const { data: receipt, error: loadError } = await supabase
    .from("receipts")
    .select(RECEIPT_COLUMNS)
    .eq("id", receiptId)
    .maybeSingle<ReceiptRow>();

  if (loadError !== null) {
    console.error(`[receipts/escalate] could not load receipt ${receiptId}`, loadError);
    return fail("UNAVAILABLE");
  }
  if (receipt === null) return fail("NOT_FOUND");

  // ---- Guard 2: the actor is the submitter -------------------------------
  //
  // THE AUTHORIZATION CHECK, and the only one. Enforced here rather than in the
  // UI, against the row rather than against anything the caller sent. Answers
  // NOT_FOUND so the action cannot be used to discover other people's receipts
  // (see the header).
  if (receipt.user_id !== actorId) {
    console.warn(
      `[receipts/escalate] actor ${actorId} attempted to escalate receipt ${receiptId}, which is not theirs`,
    );
    return fail("NOT_FOUND");
  }

  // ---- Guard 3: it is rejected -------------------------------------------
  // A receipt still in flight has nothing to contest yet, and an approved one
  // has already paid.
  if (receipt.status !== "rejected") return fail("NOT_ESCALATABLE");

  // ---- Guard 4: once per receipt, forever --------------------------------
  //
  // THIS IS WHAT STOPS THE LOOP. After a merchant re-rejects an escalated
  // receipt it is back at 'rejected' with a reason that is still escalatable,
  // so without this the customer could push it back indefinitely and the
  // "thirty-second decision by the best-placed person" becomes an argument
  // conducted through a queue.
  if (receipt.escalated_at !== null) return fail("ALREADY_ESCALATED");

  // ---- Guard 5: not the fraud family -------------------------------------
  //
  // The stored value is `text`, so it is narrowed through the same schema the
  // review service parses reviewer input with rather than cast. A value this
  // build does not recognise (a reason added to the database ahead of this
  // deploy) resolves to null, which `canEscalateRejection` treats as
  // escalatable: the fail-open direction here favours the customer, and the
  // two reasons that must never be escalatable are named positively rather
  // than by exclusion, so a new enum member cannot accidentally join them.
  const parsedReason = receiptRejectReasonSchema.safeParse(receipt.reject_reason);
  const rejectReason = parsedReason.success ? parsedReason.data : null;
  if (!canEscalateRejection(rejectReason)) return fail("NOT_ESCALATABLE");

  // ---- Guard 6: there is a queue to escalate INTO -------------------------
  //
  // 0017 is explicit that a receipt with a null business_id is invisible to
  // every tenant and to every audience on the database, so escalating one would
  // file it in a queue nobody can open, forever - strictly worse than the
  // rejection, which at least told the customer something. The pipeline rejects
  // an unmatched receipt as `wrong_business` rather than parking it, and 0035's
  // sweep makes the same call for the same reason.
  const businessId = receipt.business_id;
  if (businessId === null) return fail("NOT_ESCALATABLE");

  // ---- Guard 7: the cap ---------------------------------------------------
  const open = await countOpenEscalations(deps, actorId);
  if (open === null) return fail("UNAVAILABLE");
  if (open >= MAX_OPEN_ESCALATIONS) return fail("LIMIT_REACHED");

  // ---- Guard 8: the receipt-number collision, checked before writing ------
  if (await hasLiveNumberClaim(deps, businessId, receipt)) {
    return fail("SUPERSEDED");
  }

  // ---- The conditional write ---------------------------------------------
  const escalatedAt = deps.now().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("receipts")
    .update({
      status: "review",
      escalated_at: escalatedAt,
      // 0035's attribution. Merged, so the reason the pipeline recorded is
      // still there beside this one.
      parse_meta: withEscalationReason(receipt.parse_meta),
      // BACK IN FLIGHT, SO IT HAS NO TERMINAL OUTCOME AGAIN. Leaving the
      // rejection's `processed_at` in place would break 0018's "approved, award
      // pending" marker for this receipt: if the merchant approves and the
      // award then fails, support finds the row by `processed_at is null`, and
      // a stale timestamp from the rejection would hide it.
      processed_at: null,
      // Cleared for the reason 0035 gives when its sweep moves a receipt into
      // review: these columns name the human decision that produced the CURRENT
      // status, and no human decided this one. The prior reviewer is not
      // forgotten - `audit_logs` holds their decision, which is where history
      // belongs.
      reviewed_by: null,
      reviewed_at: null,
      // `reject_reason` and `reject_note` are deliberately KEPT. The merchant is
      // being asked "was our machine wrong?", and the machine's verdict is the
      // thing they are re-deciding; erasing it would take away the question.
      // `reject_note` stays unreadable by any client (0017's column grant), so
      // keeping it leaks nothing to the consumer who triggered this.
    })
    .eq("id", receipt.id)
    .eq("user_id", actorId)
    // OPTIMISTIC CONCURRENCY, the `setCampaignStatus` pattern ./review.ts uses:
    // the expected state is a WHERE predicate rather than an in-memory check.
    // Both halves are load-bearing. A merchant deciding this receipt between
    // our load and this statement moves it off 'rejected'; a double-tapped
    // button races itself on `escalated_at`, and whichever request loses
    // matches zero rows instead of writing a second escalation.
    .eq("status", "rejected")
    .is("escalated_at", null)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (updateError !== null) {
    // THE COLLISION, AS THE DATABASE SEES IT. Guard 8 checks first, but the
    // window between that read and this write is real, and
    // `receipts_number_unique` is the only thing that closes it. A raw 23505
    // must never reach a consumer, so it becomes the same sentence guard 8
    // would have produced. receipt_escalation_smoke.sql test 7 proves this
    // branch is reachable rather than theoretical.
    if (isUniqueViolation(updateError)) {
      console.info(
        `[receipts/escalate] receipt ${receipt.id} lost the receipt-number race request=${requestId}`,
      );
      return fail("SUPERSEDED");
    }
    console.error(`[receipts/escalate] could not escalate receipt ${receipt.id}`, updateError);
    return fail("UNAVAILABLE");
  }
  if (updated === null) {
    // Zero affected rows. Either a merchant decided it first, or this is the
    // second of two taps. `ALREADY_ESCALATED` is the honest answer to the
    // common case and is harmless in the rare one: the customer refreshes and
    // sees the receipt's real state.
    return fail("ALREADY_ESCALATED");
  }

  // ---- The audit row, best effort ----------------------------------------
  await writeAuditRow(deps, {
    receipt,
    businessId,
    actorId,
    escalatedAt,
    requestId,
  });

  console.info(
    `[receipts/escalate] receipt ${receipt.id} escalated by consumer ${actorId} to business ${businessId} request=${requestId}`,
  );
  return { ok: true, receiptId: receipt.id };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * How many escalations this consumer has OPEN, or null when that could not be
 * established.
 *
 * NULL IS NOT ZERO, and the caller refuses rather than proceeding. A failed
 * read proves nothing about the cap, and the direction to fail in is the one
 * that cannot flood a merchant's queue: the customer is told to try again in a
 * moment, which is recoverable, where an unbounded escalation is not.
 *
 * Counted platform-wide rather than per merchant. The cap exists to bound what
 * one account can put in front of human beings, and a per-merchant cap would
 * let a determined account open three at every business on the platform.
 * Served by `receipts_open_escalation_idx` (0036).
 */
async function countOpenEscalations(
  deps: EscalateDeps,
  consumerId: string,
): Promise<number | null> {
  const { data, error } = await deps.supabase
    .from("receipts")
    .select("id")
    .eq("user_id", consumerId)
    .eq("status", "review")
    .not("escalated_at", "is", null)
    // Bounded: nothing here needs the exact number, only whether it has reached
    // the cap, so the read cannot grow with a runaway account.
    .limit(MAX_OPEN_ESCALATIONS);

  if (error !== null) {
    console.error(
      `[receipts/escalate] could not count open escalations for consumer ${consumerId}`,
      error,
    );
    return null;
  }
  return (data ?? []).length;
}

/**
 * Whether a LIVE row at this business already claims this receipt's number.
 *
 * This is `receipts_number_unique` (0017) read ahead of time. The index covers
 * ('approved','review','processing') and excludes 'rejected', so two rejected
 * rows can share a number quite legally and moving one back into 'review'
 * collides with any live claimant. The commonest way to arrive here is entirely
 * innocent: the customer's first scan was rejected as unreadable, they retook
 * the photo, the second scan was approved, and only later did they tap the
 * button on the first one.
 *
 * A FAILED READ RETURNS FALSE, i.e. proceeds. That is the opposite posture to
 * the cap above, and deliberately: here the database itself is the real fence
 * (the write catches 23505), so this read is an optimisation that buys a
 * cleaner refusal, and failing an honest escalation over a transient error
 * would cost the customer their remedy to prevent nothing.
 */
async function hasLiveNumberClaim(
  deps: EscalateDeps,
  businessId: string,
  receipt: ReceiptRow,
): Promise<boolean> {
  if (receipt.receipt_number === null) return false;

  const { data, error } = await deps.supabase
    .from("receipts")
    .select("id")
    .eq("business_id", businessId)
    .eq("receipt_number", receipt.receipt_number)
    .in("status", [...LIVE_STATUSES])
    .neq("id", receipt.id)
    .limit(1);

  if (error !== null) {
    console.error(
      `[receipts/escalate] could not pre-check the receipt number for ${receipt.id}`,
      error,
    );
    return false;
  }
  return (data ?? []).length > 0;
}

// ---------------------------------------------------------------------------
// The audit row
// ---------------------------------------------------------------------------

interface AuditContext {
  receipt: ReceiptRow;
  businessId: string;
  actorId: string;
  escalatedAt: string;
  requestId: string;
}

/**
 * One append-only record of the REQUEST, as distinct from the decision.
 *
 * `actor_kind` is 'user' and `actor_role` is 'consumer'. 0022 leaves
 * `actor_role` as free text with no FK precisely so it can hold a snapshot of
 * who the actor was at the time, and 'consumer' is the honest snapshot: this is
 * the first row in `audit_logs` written by somebody who is not staff, and it
 * should be greppable as such.
 *
 * The diff is minimal, per doc 25's rule that PII minimization is the writer's
 * job because these columns are readable by the tenant owner. It carries the
 * status transition and the reason that was on the row, both of which the
 * merchant is about to see on the decision screen anyway. It carries no
 * `reject_note`, no `parse_meta` and no image.
 *
 * Never throws and never blocks. See the header for why this one failure is
 * survivable where ./review.ts's is not.
 */
async function writeAuditRow(deps: EscalateDeps, context: AuditContext): Promise<void> {
  const { receipt, businessId, actorId, escalatedAt, requestId } = context;

  const { error } = await deps.supabase.from("audit_logs").insert({
    actor_id: actorId,
    actor_kind: "user",
    actor_role: "consumer",
    business_id: businessId,
    action: AUDIT_ACTION_ESCALATED,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: receipt.id,
    before: { status: "rejected", reject_reason: receipt.reject_reason, escalated_at: null },
    after: { status: "review", escalated_at: escalatedAt },
    reason:
      receipt.reject_reason === null
        ? "The customer asked the store to look at this receipt again after it was rejected."
        : `The customer asked the store to look at this receipt again after it was rejected as ${receipt.reject_reason}.`,
    request_id: requestId,
  });

  if (error !== null) {
    console.error(
      `[receipts/escalate] could not audit the escalation of receipt ${receipt.id}; the escalation stands`,
      error,
    );
  }
}
