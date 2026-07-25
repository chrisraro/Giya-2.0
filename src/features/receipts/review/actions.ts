"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { receiptIdSchema } from "../schemas";
import { reviewReceipt } from "../server/review";
import type { ReviewErrorCode } from "../server/review";
import { resolveReviewerContext } from "./access";

// ===========================================================================
// The two decision actions behind `/business/receipts/[receiptId]`.
//
// These are THIN by design. Every guard that matters (active owner/manager of
// the receipt's tenant, the receipt is still in `review`, the reviewer is not
// the submitter, the shared award path, the audit row) lives in
// `server/review.ts` and is tested there. Re-implementing any of them here
// would create a second copy that can drift from the one the API route will
// also call.
//
// What this layer owns, and only this:
//   * the session, resolved to an ACTOR ID that the client cannot supply,
//   * a `request_id` for the audit row,
//   * revalidating the two paths the decision changes,
//   * translating the service's typed error codes into sentences a reviewer
//     can act on. `RECEIPT_NOT_REVIEWABLE` in particular is NOT a generic
//     failure: it is "another manager already decided this", and the screen
//     says so and refreshes rather than showing a red box.
//
// Note what is absent: no business id is accepted, produced or passed.
// `reviewReceipt` derives the tenant from the RECEIPT and checks the actor's
// membership of THAT tenant, which is stronger than anything this layer could
// assert, and it means a caller cannot widen their scope by naming a business.
// ===========================================================================

const RECEIPTS_PATH = "/business/receipts";

export type ReviewActionErrorCode = ReviewErrorCode | "NOT_ALLOWED" | "INVALID_INPUT";

export type ReviewActionResult =
  | { ok: true; status: "approved"; pointsAwarded: number | null }
  | { ok: true; status: "rejected"; reason: string }
  | { ok: false; code: ReviewActionErrorCode; message: string; fieldErrors: string[] };

function fail(
  code: ReviewActionErrorCode,
  message: string,
  fieldErrors: string[] = [],
): ReviewActionResult {
  return { ok: false, code, message, fieldErrors };
}

const NOT_ALLOWED = "You do not have permission to review receipts for this business.";

/**
 * `fields` stays `unknown` on the way through. `reviewFieldsSchema` inside the
 * service is the real gate (its own comment says so), and parsing here as well
 * would mean two schemas that can disagree about what a valid correction is.
 */
const approveInputSchema = z.object({
  receiptId: receiptIdSchema,
  fields: z.unknown(),
});

const rejectInputSchema = z.object({
  receiptId: receiptIdSchema,
  reason: z.unknown(),
  note: z.string().max(1000).optional(),
});

function revalidateDecision(receiptId: string): void {
  revalidatePath(RECEIPTS_PATH);
  revalidatePath(`${RECEIPTS_PATH}/${receiptId}`);
  // The sidebar badge and the dashboard tile both read the pending count, and
  // a decision is exactly the event that changes it.
  revalidatePath("/business/dashboard");
}

/**
 * Approve, with the reviewer's corrections. THIS IS A MONEY ACTION: a
 * successful call mints points through the same path auto-approval uses. The
 * screen confirms before calling it and shows the total the points will be
 * computed from.
 */
export async function approveReceiptAction(input: unknown): Promise<ReviewActionResult> {
  const reviewer = await resolveReviewerContext();
  if (reviewer === null) return fail("NOT_ALLOWED", NOT_ALLOWED);

  const parsed = approveInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail("INVALID_INPUT", "That receipt could not be identified. Refresh and try again.");
  }

  const outcome = await reviewReceipt({
    receiptId: parsed.data.receiptId,
    // From the session, never from the payload. This is the value that lands
    // in `audit_logs.actor_id` and in `receipts.reviewed_by`, and it is the
    // value guard 4 compares against `receipts.user_id`.
    actorId: reviewer.userId,
    action: "approve",
    fields: parsed.data.fields,
    requestId: randomUUID(),
  });

  if (!outcome.ok) {
    return fail(outcome.code, outcome.message, outcome.fieldErrors);
  }

  revalidateDecision(parsed.data.receiptId);

  if (outcome.status !== "approved") {
    // Unreachable: an approve call that succeeds returns the approved variant.
    return fail("REVIEW_WRITE_FAILED", "The decision did not save. Refresh and try again.");
  }

  return {
    ok: true,
    status: "approved",
    // null covers both "the rules priced this at zero" and "the award was
    // refused", which the screen words differently from a points figure.
    pointsAwarded: outcome.award.kind === "awarded" ? outcome.award.points : null,
  };
}

/** Reject, with a reason from the enum and an optional note. */
export async function rejectReceiptAction(input: unknown): Promise<ReviewActionResult> {
  const reviewer = await resolveReviewerContext();
  if (reviewer === null) return fail("NOT_ALLOWED", NOT_ALLOWED);

  const parsed = rejectInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail("INVALID_INPUT", "That receipt could not be identified. Refresh and try again.");
  }

  const outcome = await reviewReceipt({
    receiptId: parsed.data.receiptId,
    actorId: reviewer.userId,
    action: "reject",
    rejectReason: parsed.data.reason,
    ...(parsed.data.note === undefined ? {} : { rejectNote: parsed.data.note }),
    requestId: randomUUID(),
  });

  if (!outcome.ok) {
    return fail(outcome.code, outcome.message, outcome.fieldErrors);
  }

  revalidateDecision(parsed.data.receiptId);

  if (outcome.status !== "rejected") {
    return fail("REVIEW_WRITE_FAILED", "The decision did not save. Refresh and try again.");
  }

  return { ok: true, status: "rejected", reason: outcome.reason };
}
