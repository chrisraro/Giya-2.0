"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

import { escalationRefusalCopy } from "./components/receipt-copy";
import type { EscalationRefusal } from "./components/receipt-copy";
import { receiptIdSchema } from "./schemas";
import { escalateReceipt } from "./server/escalate";

// ===========================================================================
// The consumer's escalation action: "ask the store to look at this".
//
// THIN BY DESIGN, exactly like review/actions.ts. Every guard that matters -
// the submitter check, the rejected-status check, the once-per-receipt rule,
// the excluded fraud family, the cap, the receipt-number collision - lives in
// server/escalate.ts and is tested there. Re-implementing any of them here
// would create a second copy that can drift from the one an API route will
// also call.
//
// What this layer owns, and only this:
//   * the session, resolved to an ACTOR ID the client cannot supply,
//   * a `request_id` for the audit row,
//   * revalidating the two screens the escalation changes.
//
// NOTE WHAT THE PAYLOAD IS: a receipt id and nothing else. No business id, no
// reason, no status, no "escalate: true". The service re-reads every one of
// those from the row and proves the caller owns it, which is the same property
// `learnMerchantAliasAction` relies on and for the same reason: nothing the
// browser holds can widen what this does.
// ===========================================================================

export type EscalateActionResult =
  | { ok: true }
  | { ok: false; refusal: EscalationRefusal; message: string };

const escalateInputSchema = z.object({ receiptId: receiptIdSchema });

export async function escalateReceiptAction(input: unknown): Promise<EscalateActionResult> {
  const parsed = escalateInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: "NOT_FOUND",
      message: escalationRefusalCopy("NOT_FOUND"),
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // No session is answered with the SAME sentence as a receipt that is not
  // theirs. A signed-out caller learns nothing about whether the id is real,
  // and a consumer whose session expired mid-screen gets a sentence they can
  // act on rather than a redirect that loses the receipt they were looking at.
  if (!user) {
    return {
      ok: false,
      refusal: "NOT_FOUND",
      message: escalationRefusalCopy("NOT_FOUND"),
    };
  }

  const outcome = await escalateReceipt({
    receiptId: parsed.data.receiptId,
    // From the session, never from the payload. This is the value guard 2
    // compares against `receipts.user_id` and the value that lands in
    // `audit_logs.actor_id`.
    actorId: user.id,
    requestId: randomUUID(),
  });

  if (!outcome.ok) {
    return { ok: false, refusal: outcome.refusal, message: outcome.message };
  }

  // The status screen now reads "the store is looking at this again", and the
  // history list's row for it changes label. The wallet is deliberately not
  // revalidated: no points moved, and nothing on it changed.
  revalidatePath(`/scan/${parsed.data.receiptId}`);
  revalidatePath("/receipts");

  return { ok: true };
}
