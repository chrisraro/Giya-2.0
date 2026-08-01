import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

// ===========================================================================
// "Ask the Giya team to review this business."
//
// THE THINNEST SERVICE IN THIS FEATURE, on purpose, and for the same reason
// `clawbackReceipt` is the thinnest function in the admin consequences module:
// everything that matters is inside `public.submit_business_for_review` (0033),
// in ONE transaction. The owner check, the draft check, the earning-rule
// precondition, the `business_verifications` round and the audit row commit or
// roll back together, so the failure mode this codebase would otherwise have to
// design around - a tenant sitting at `pending_verification` with no round for
// an admin to decide - is unreachable rather than merely unlikely.
//
// So this layer owns exactly two things: the service-role client (0033 grants
// EXECUTE to `service_role` alone, because the merchant's own role can no
// longer write `businesses.status` at all), and the translation of the RPC's
// stable message strings into sentences a merchant can act on. That mapping is
// the 0013 pattern, already used by `rewards/server/service.ts` and
// `admin/consequences.ts`.
//
// The actor id is resolved from the session by the caller and RE-VERIFIED by
// the RPC against `business_staff`; it is never taken on trust, here or there.
// ===========================================================================

export type SubmitErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "NO_EARNING_RULE"
  | "WRITE_FAILED"
  | "DEPENDENCY_UNAVAILABLE";

export type SubmitOutcome =
  | { ok: true; verificationId: string | null }
  | { ok: false; code: SubmitErrorCode; message: string };

export interface SubmitDeps {
  /** MUST be the service-role client: 0033 grants EXECUTE to nobody else. */
  supabase: SupabaseClient<Database>;
}

export function defaultSubmitDeps(): SubmitDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[businesses/activation] SUPABASE_SERVICE_ROLE_KEY is not configured; no business can be submitted for review",
    );
    return null;
  }
  return { supabase };
}

export interface SubmitForReviewInput {
  businessId: string;
  /** `profiles.id` of the signed-in owner, resolved from the session. */
  actorId: string;
  /** Optional applicant note. Empty is normal and is sent as null. */
  note: string | null;
  /** Correlates this action with the request log line (doc 25). */
  requestId: string;
}

function fail(code: SubmitErrorCode, message: string): SubmitOutcome {
  return { ok: false, code, message };
}

export async function submitForReview(
  input: SubmitForReviewInput,
  deps: SubmitDeps | null = defaultSubmitDeps(),
): Promise<SubmitOutcome> {
  if (deps === null) {
    return fail("DEPENDENCY_UNAVAILABLE", "This is not available right now. Try again shortly.");
  }

  const trimmed = input.note === null ? "" : input.note.trim();

  // `p_note` is OMITTED rather than passed as undefined when there is none, so
  // the RPC's own default applies. Under `exactOptionalPropertyTypes` an
  // explicit undefined is not the same thing as an absent key, and the
  // generated argument type says so.
  const { data, error } = await deps.supabase.rpc("submit_business_for_review", {
    p_business_id: input.businessId,
    p_actor_id: input.actorId,
    p_request_id: input.requestId,
    ...(trimmed.length > 0 ? { p_note: trimmed } : {}),
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("SUBMIT_FORBIDDEN")) {
      return fail(
        "FORBIDDEN",
        "Only the owner of this business can send it for review. Ask them to do it.",
      );
    }
    if (message.includes("BUSINESS_NOT_FOUND")) {
      return fail("NOT_FOUND", "That business could not be found.");
    }
    if (message.includes("SUBMIT_INVALID_STATE")) {
      return fail(
        "INVALID_STATE",
        "This business is not waiting to be sent for review. Refresh the page to see where it stands.",
      );
    }
    if (message.includes("ACTIVATION_NO_EARNING_RULE")) {
      return fail(
        "NO_EARNING_RULE",
        "Set how customers earn points first. Without it, receipts would be approved and award nothing.",
      );
    }
    console.error("[businesses/activation] submit for review failed", error);
    return fail("WRITE_FAILED", "That did not go through. Nothing was changed; try again.");
  }

  return { ok: true, verificationId: readVerificationId(data) };
}

/**
 * The round id out of the RPC's return value, or null when the shape is not
 * what this code expects.
 *
 * Null is a DISPLAY problem and never a failure: the transaction committed, so
 * the business is submitted whatever this returns. Reporting it as a failure
 * would invite a merchant to submit again and meet SUBMIT_INVALID_STATE.
 */
function readVerificationId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).verification_id;
  return typeof id === "string" ? id : null;
}
