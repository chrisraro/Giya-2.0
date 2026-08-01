"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveStaffContext } from "../server/resolve-owner-business";
import { MAX_SUBMISSION_NOTE_LENGTH } from "./presenter";
import { submitForReview } from "./server/submit";
import type { SubmitErrorCode } from "./server/submit";

// ===========================================================================
// The merchant's one activation action.
//
// THIN BY DESIGN, exactly like `admin/actions.ts`. Every guard that matters -
// the owner check, the draft check, the earning-rule precondition, the round
// row and the audit row - lives inside `public.submit_business_for_review`
// (0033) and is tested there in `supabase/tests/rpc_activation_smoke.sql`.
// Re-implementing any of them here would create a second copy that can drift
// from the one the database enforces.
//
// What this layer owns, and only this:
//   * the session, resolved to a BUSINESS ID and an ACTOR ID the client cannot
//     supply,
//   * a `request_id` for the audit row,
//   * revalidating the paths this changes,
//   * turning typed error codes into sentences a merchant can act on.
//
// Note what is absent: nothing here accepts a business id. It comes from
// `resolveStaffContext(["owner"])`, the same resolver every other business
// server action uses, so a caller cannot submit somebody else's shop. The RPC
// re-verifies the pair against `business_staff` regardless.
// ===========================================================================

const DASHBOARD_PATH = "/business/dashboard";
const CAMPAIGNS_PATH = "/business/campaigns";
const SETTINGS_PATH = "/business/settings";

export type ActivationActionErrorCode = SubmitErrorCode | "NOT_ALLOWED" | "INVALID_INPUT";

export type ActivationActionResult =
  | { ok: true; message: string }
  | { ok: false; code: ActivationActionErrorCode; message: string };

const submitSchema = z.object({
  note: z.string().max(MAX_SUBMISSION_NOTE_LENGTH).optional(),
});

/**
 * Owner only, per doc 32 section 2.2 and doc 01's permission matrix. A manager
 * runs the shop; committing the business to a platform review under the owner's
 * name is not a shop operation, and the RPC refuses it with SUBMIT_FORBIDDEN
 * even if this check were removed.
 */
export async function submitForReviewAction(input: unknown): Promise<ActivationActionResult> {
  const staff = await resolveStaffContext(["owner"]);
  if (staff === null) {
    return {
      ok: false,
      code: "NOT_ALLOWED",
      message: "Only the owner of this business can send it for review.",
    };
  }

  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "That request could not be read. Refresh and try again.",
    };
  }

  const outcome = await submitForReview({
    businessId: staff.businessId,
    actorId: staff.userId,
    note: parsed.data.note ?? null,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

  // The dashboard carries the checklist and the banner; the other two show the
  // status chip and the activation-gated controls.
  revalidatePath(DASHBOARD_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  revalidatePath(SETTINGS_PATH);

  return {
    ok: true,
    message:
      "Sent for review. The Giya team will look at your business and you will see the decision here.",
  };
}
