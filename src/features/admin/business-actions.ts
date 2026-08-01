"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveAdminContext } from "./access";
import { activateBusiness, rejectBusinessVerification } from "./business-decisions";
import type { BusinessDecisionErrorCode } from "./business-decisions";
import { MAX_REASON_LENGTH } from "./presenter";

// ===========================================================================
// The two go-live server actions.
//
// THIN BY DESIGN, exactly like ./actions.ts, and separate from it for one
// reason: that file is doc 37's consequences ladder, which acts on CONSUMERS
// and whose header says so. These act on TENANTS. Merging them would give the
// ladder a verb that has nothing to do with fraud and make its own header a
// lie.
//
// What this layer owns: the session resolved to an actor id the client cannot
// supply, a `request_id` for the audit row, and revalidating the paths each
// decision changes. Every guard that matters is in the RPC.
//
// BOTH ACTIONS TAKE A REASON AND NEITHER WILL RUN WITHOUT ONE.
// ===========================================================================

const QUEUE_PATH = "/admin/businesses";
const OVERVIEW_PATH = "/admin";

export type BusinessActionErrorCode =
  | BusinessDecisionErrorCode
  | "NOT_ALLOWED"
  | "INVALID_INPUT";

export type BusinessActionResult =
  | { ok: true; message: string }
  | { ok: false; code: BusinessActionErrorCode; message: string };

const decisionSchema = z.object({
  businessId: z.string().uuid(),
  reason: z.string().min(1).max(MAX_REASON_LENGTH),
});

function fail(code: BusinessActionErrorCode, message: string): BusinessActionResult {
  return { ok: false, code, message };
}

/**
 * Both queues and the overview count change on every decision, so both are
 * revalidated whichever way the decision went.
 */
function revalidateQueue(): void {
  revalidatePath(OVERVIEW_PATH);
  revalidatePath(QUEUE_PATH);
}

/**
 * THIS IS THE ACTION THAT PUTS A MERCHANT IN FRONT OF CONSUMERS. A successful
 * call is the only thing on this platform that sets `businesses.status` to
 * 'active', which is the predicate every consumer-facing read filters on.
 */
export async function approveBusinessAction(input: unknown): Promise<BusinessActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return fail("NOT_ALLOWED", "You do not have permission to take this action.");

  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_INPUT", "That request could not be read. Refresh and try again.");

  const outcome = await activateBusiness({
    businessId: parsed.data.businessId,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return fail(outcome.code, outcome.message);

  revalidateQueue();
  return {
    ok: true,
    message: "Approved. This business is now listed to customers and can start earning points for them.",
  };
}

export async function sendBusinessBackAction(input: unknown): Promise<BusinessActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return fail("NOT_ALLOWED", "You do not have permission to take this action.");

  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_INPUT", "That request could not be read. Refresh and try again.");

  const outcome = await rejectBusinessVerification({
    businessId: parsed.data.businessId,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return fail(outcome.code, outcome.message);

  revalidateQueue();
  return {
    ok: true,
    message: "Sent back. The owner sees your reason on their dashboard and can fix it and resubmit.",
  };
}
