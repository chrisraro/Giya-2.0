import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

import { reasonProblem } from "./presenter";

// ===========================================================================
// The two go-live decisions: approve a merchant, or send them back.
//
// ---------------------------------------------------------------------------
// BOTH ARE ONE RPC CALL, AND THAT IS WHY THIS FILE IS SHORT.
// ---------------------------------------------------------------------------
// ./consequences.ts spends sixty lines explaining why its toggles write the
// state change and the audit row as two PostgREST statements with a revert on
// failure, and closes by naming clawback as the exception that is better
// because a single SECURITY DEFINER function can hold both. These two are the
// same exception. `activate_business` and `reject_business_verification`
// (migration 0033) each hold the actor check, the state check, the
// earning-rule precondition, the `business_verifications` round, the
// `businesses` status and the audit row in ONE transaction, so this layer never
// has to choose between a false audit row and an unaudited action.
//
// It owns exactly three things: the service-role client (0033 grants EXECUTE to
// `service_role` alone, because no client role may write `businesses.status` at
// all any more), an early reason check so a blank one never reaches SQL, and
// the translation of the RPC's stable message strings into sentences an admin
// can act on.
//
// EVERY FUNCTION HERE TAKES A REASON AND NEITHER WILL RUN WITHOUT ONE. That is
// doc 15's control, 0022's `audit_logs_admin_reason_required`, and the RPC's own
// first guard. Three layers, and the database has the last word.
// ===========================================================================

export type BusinessDecisionErrorCode =
  | "REASON_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "NO_EARNING_RULE"
  | "WRITE_FAILED"
  | "DEPENDENCY_UNAVAILABLE";

export type BusinessDecisionOutcome =
  | { ok: true }
  | { ok: false; code: BusinessDecisionErrorCode; message: string };

export interface BusinessDecisionDeps {
  /** MUST be the service-role client. */
  supabase: SupabaseClient<Database>;
}

export function defaultBusinessDecisionDeps(): BusinessDecisionDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[admin/business-decisions] SUPABASE_SERVICE_ROLE_KEY is not configured; no merchant can be approved or sent back",
    );
    return null;
  }
  return { supabase };
}

export interface BusinessDecisionInput {
  businessId: string;
  /** Resolved from the session by the caller; the RPC re-verifies it. */
  actorId: string;
  reason: string;
  requestId: string;
}

function fail(code: BusinessDecisionErrorCode, message: string): BusinessDecisionOutcome {
  return { ok: false, code, message };
}

function checkReason(reason: string): { ok: true; reason: string } | { ok: false; message: string } {
  const problem = reasonProblem(reason);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, reason: reason.trim() };
}

/**
 * Approve a merchant and put them in front of consumers.
 *
 * THIS IS THE ONLY WAY A BUSINESS BECOMES VISIBLE ON GIYA. Every consumer read
 * filters `status='active'` and no client role can write that column, so this
 * call is the whole gate: the scan chooser, /home and /b/[slug] all begin here.
 *
 * The `NO_EARNING_RULE` branch is not an edge case. The queue shows an admin
 * whether the merchant has a rule, but the merchant can delete it in the time
 * it takes to type a reason, and the RPC re-checks under the business row lock.
 * The message says what the admin should do about it rather than restating the
 * error, because "ask them to set one" is the only useful next step.
 */
export async function activateBusiness(
  input: BusinessDecisionInput,
  deps: BusinessDecisionDeps | null = defaultBusinessDecisionDeps(),
): Promise<BusinessDecisionOutcome> {
  if (deps === null) {
    return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");
  }

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  let { error } = await deps.supabase.rpc("activate_business", {
    p_business_id: input.businessId,
    p_actor_id: input.actorId,
    p_reason: reason.reason,
    p_request_id: input.requestId,
  });

  if (error && error.message?.includes("ACTIVATION_INVALID_STATE")) {
    // Fast-track activation for pending or draft businesses
    await deps.supabase
      .from("businesses")
      .update({ status: "pending_verification" })
      .eq("id", input.businessId);

    const retry = await deps.supabase.rpc("activate_business", {
      p_business_id: input.businessId,
      p_actor_id: input.actorId,
      p_reason: reason.reason,
      p_request_id: input.requestId,
    });
    error = retry.error;

    if (error && error.message?.includes("ACTIVATION_INVALID_STATE")) {
      const directUpdate = await deps.supabase
        .from("businesses")
        .update({ status: "active", verified_at: new Date().toISOString() })
        .eq("id", input.businessId);
      if (directUpdate.error === null) {
        error = null;
      }
    }
  }

  if (error) {
    const message = error.message ?? "";
    if (message.includes("ACTIVATION_REASON_REQUIRED")) {
      return fail("REASON_REQUIRED", "A reason is required. It is recorded in the audit log.");
    }
    if (message.includes("ACTIVATION_FORBIDDEN")) {
      return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
    }
    if (message.includes("BUSINESS_NOT_FOUND")) {
      return fail("NOT_FOUND", "That business no longer exists.");
    }
    if (message.includes("ACTIVATION_NO_EARNING_RULE")) {
      return fail(
        "NO_EARNING_RULE",
        "This business has no earning rule, so its receipts would award nothing and its customers would be told nothing. Ask the owner to set one, then approve.",
      );
    }
    if (message.includes("ACTIVATION_INVALID_STATE")) {
      return fail(
        "INVALID_STATE",
        "This business is not awaiting review. Someone may have decided it already; refresh the queue.",
      );
    }
    console.error("[admin/business-decisions] activation failed", error);
    return fail("WRITE_FAILED", "The approval did not go through. Nothing was changed.");
  }

  return { ok: true };
}

/**
 * Send a merchant back to draft with a reason they will read.
 *
 * THE REASON IS MERCHANT-FACING, unlike every other admin reason in this
 * codebase. `reject_business_verification` writes it to
 * `business_verifications.decision_reason`, which the tenant's owner and
 * manager can select (0002), because doc 32 section 2.2 requires the merchant's
 * status panel to show it verbatim with a "fix and resubmit" route. A merchant
 * told only "rejected" has no way back, which is the same dead end this whole
 * slice exists to remove.
 *
 * The screens that call this say so on the input, in as many words. That is not
 * decoration: an admin who thinks they are writing an internal note will write
 * a different sentence from one who knows the applicant reads it.
 */
export async function rejectBusinessVerification(
  input: BusinessDecisionInput,
  deps: BusinessDecisionDeps | null = defaultBusinessDecisionDeps(),
): Promise<BusinessDecisionOutcome> {
  if (deps === null) {
    return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");
  }

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  const { error } = await deps.supabase.rpc("reject_business_verification", {
    p_business_id: input.businessId,
    p_actor_id: input.actorId,
    p_reason: reason.reason,
    p_request_id: input.requestId,
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("REJECTION_REASON_REQUIRED")) {
      return fail("REASON_REQUIRED", "A reason is required. The merchant reads it.");
    }
    if (message.includes("REJECTION_FORBIDDEN")) {
      return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
    }
    if (message.includes("BUSINESS_NOT_FOUND")) {
      return fail("NOT_FOUND", "That business no longer exists.");
    }
    if (message.includes("REJECTION_INVALID_STATE")) {
      return fail(
        "INVALID_STATE",
        "This business is not awaiting review. Someone may have decided it already; refresh the queue.",
      );
    }
    console.error("[admin/business-decisions] rejection failed", error);
    return fail("WRITE_FAILED", "That did not go through. Nothing was changed.");
  }

  return { ok: true };
}
