import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import type { OcrProcessPayload } from "./schemas";

// =============================================================================
// The `ocr.process` worker. Doc 39's worker invocation contract, step 4.
// =============================================================================
//
// Signature verification, payload parsing and the job claim all happen before
// this function is reached (../../app/api/jobs/ocr.process/route.ts). What is
// left is one call and one question, and the question is the whole reason this
// module exists.
//
// THE CALL is `processReceipt(receipt_id)`. It is doc 36 Stages 2 through 10 -
// claim, OCR, parse, match, validate, fraud, outcome, award, notify - and this
// worker adds nothing to it and takes nothing away. `processReceipt` was
// written queue-shaped from the start (its header says so): the id is the
// entire input, everything else is re-read from the database under the service
// role, and it is safe to call twice and safe to call twice at once.
//
// THE QUESTION is what to tell QStash, and it is not answerable from the call.
//
// -----------------------------------------------------------------------------
// WHY THE OUTCOME HAS TO BE READ BACK OFF THE ROW
// -----------------------------------------------------------------------------
// `processReceipt` returns `Promise<void>` and NEVER THROWS. That is a contract
// it keeps deliberately (see its header) and it is the right contract, because
// the pipeline's failures are domain outcomes rather than exceptions: an
// unreadable photo is a `rejected` receipt, not a crash. But it means the
// return value carries no information at all, and a worker that answered 200
// because "nothing threw" would ack every single delivery - including the ones
// where the OCR service was down and the receipt is sitting at `processing`
// waiting for exactly the retry it just threw away.
//
// So the outcome is READ, not returned: after the call, `receipts.status` says
// what happened. That is not a workaround, it is the same fact doc 36 Stage 2
// already makes authoritative ("if `receipts.status` is not `queued`/
// `processing`, ack and exit") - the status IS the pipeline's terminal/
// retryable classification, durably, and reading it needs no change to
// process.ts and no second source of truth that could drift from it.
//
// -----------------------------------------------------------------------------
// THE MAPPING, AND WHY EACH HALF IS THE WAY ROUND IT IS
// -----------------------------------------------------------------------------
// QStash retries on 5xx and gives up on 2xx. Both mistakes are expensive and
// they are expensive in opposite directions:
//
//   TERMINAL -> 2xx.  `approved`, `review`, `rejected`. The pipeline has
//     decided. Nothing about a second delivery could change the answer, and
//     `processReceipt` would refuse to run anyway (Stage 2's ack-and-exit), so
//     a 5xx here would spend the remaining attempts re-confirming a decision
//     already made and then dead-letter a receipt that succeeded. Note that
//     `rejected` is in this list: A REJECTED RECEIPT IS A SUCCESSFUL JOB. Doc
//     39 says it outright - "unreadable image is terminal ... a *successful*
//     job with a negative domain outcome, not a job failure". Getting this half
//     backwards retries a rejected receipt until its attempt budget is gone and
//     fills the DLQ with receipts the platform correctly refused.
//
//   RETRYABLE -> 5xx. `processing`, `queued`. The pipeline parks a receipt at
//     `processing` on purpose when another attempt could still save it -
//     `handleOcrFailure` does this for an OCR 503, a timeout, and for wrong OCR
//     credentials, and doc 36 Stage 2 names `processing` retry-eligible for
//     precisely this reason. `queued` means the pipeline never got as far as
//     claiming the row at all (no service-role key, a misconfigured provider, a
//     read that failed). Both are recoverable by a later delivery against a
//     healthy deployment, and a 2xx here abandons a receipt a consumer is
//     watching - the failure the 24-hour `sweep_stuck_receipts` (0028) would
//     eventually turn into a rejection, hours after the consumer gave up.
//
// The retry is bounded by two budgets that agree at 3 on purpose:
// `jobs.max_attempts` (doc 36 Stage 2's override of the column default) and
// `ocr.max_attempts` (the pipeline's own per-attempt budget). Whichever runs
// out first, the receipt ends terminal - `handleOcrFailure` writes
// rejected/manual with `reject_note='processing_failed'` when it exhausts its
// attempts, and `claimJob` marks the job dead when it exhausts its own - so the
// 5xx branch cannot loop forever in either layer.
//
// Two branches remain and neither is a status:
//
//   GONE. The receipt row does not exist. A signed message for a receipt that
//     was never written, or was rolled back. Re-delivery cannot conjure it, so
//     2xx, and the job is marked dead rather than succeeded because nothing was
//     done.
//   UNREADABLE. The status query itself failed. NOTHING IS KNOWN, including
//     whether the pipeline ran, so the answer is 5xx: the safe direction is one
//     wasted delivery that finds a terminal receipt and acks it, not an ack of
//     a receipt that may still be mid-flight.

/**
 * The statuses doc 36's state machine calls final. A receipt in any of these
 * has been decided by the pipeline or by a reviewer, and `processReceipt` will
 * refuse to touch it again.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["approved", "review", "rejected"]);

export interface OcrProcessDeps {
  /** SERVICE ROLE. `receipts` has no client read policy the worker could use. */
  readonly supabase: SupabaseClient<Database>;
  /**
   * `processReceipt` from src/features/receipts/server/process.ts, injected so
   * the mapping above is testable without an OCR provider, a storage bucket, a
   * Redis instance and a database. The production route passes the real one.
   */
  readonly processReceipt: (receiptId: string) => Promise<void>;
}

export type OcrProcessResult =
  /** Decided. Ack. */
  | { readonly kind: "terminal"; readonly status: string }
  /** Recoverable by another delivery. Ask for one. */
  | { readonly kind: "retryable"; readonly status: string }
  /** No such receipt. Ack, but the job did no work. */
  | { readonly kind: "gone" }
  /** The outcome could not be read. Ask for another delivery. */
  | { readonly kind: "unreadable"; readonly reason: string };

const LOG_PREFIX = "[workers/receipts/ocr]";

/**
 * Run one receipt through the pipeline and classify what it did.
 *
 * NEVER THROWS, for the same reason `processReceipt` does not: the route turns
 * this into a status code, and an exception escaping here would become a 500
 * whose meaning ("retry") happened to be right by accident rather than by
 * decision. Any unexpected fault is reported as `unreadable`, which asks for
 * the retry explicitly.
 */
export async function runOcrProcess(
  payload: OcrProcessPayload,
  deps: OcrProcessDeps,
): Promise<OcrProcessResult> {
  const receiptId = payload.receipt_id;

  try {
    // Doc 36 Stages 2-10. Idempotent by receipt status, by the `claimReceipt`
    // compare-and-swap, and by `pt_receipt_earn_once` at the database, so a
    // duplicate delivery that slipped past the job claim still cannot
    // double-award.
    await deps.processReceipt(receiptId);
  } catch (error) {
    // `processReceipt` is documented not to throw, so this is a genuine fault
    // in the wiring rather than in a receipt. Retryable: nothing here proves
    // another attempt would fail the same way, and the receipt is left in
    // whatever state its last successful write put it in - which the status
    // read below would report accurately if it could run. It cannot be trusted
    // to, so this reports the fault instead.
    console.error(`${LOG_PREFIX} processReceipt threw for receipt ${receiptId}`, error);
    return { kind: "unreadable", reason: "processReceipt threw" };
  }

  const { data, error } = await deps.supabase
    .from("receipts")
    .select("status")
    .eq("id", receiptId)
    .maybeSingle<{ status: string }>();

  if (error !== null) {
    console.error(`${LOG_PREFIX} could not read the outcome of receipt ${receiptId}`, error);
    return { kind: "unreadable", reason: error.message };
  }

  if (data === null) {
    console.error(`${LOG_PREFIX} receipt ${receiptId} does not exist`);
    return { kind: "gone" };
  }

  if (TERMINAL_STATUSES.has(data.status)) {
    console.info(`${LOG_PREFIX} receipt ${receiptId} is '${data.status}'; acking`);
    return { kind: "terminal", status: data.status };
  }

  // 'queued' or 'processing'. Doc 36 Stage 2 names both retry-eligible.
  console.warn(
    `${LOG_PREFIX} receipt ${receiptId} is still '${data.status}' after a pass; asking QStash to retry`,
  );
  return { kind: "retryable", status: data.status };
}
