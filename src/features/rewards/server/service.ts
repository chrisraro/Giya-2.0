import { createClient } from "@/lib/supabase/server";

import { consumeRedemptionToken, RedemptionTokenError } from "./token";
import type { ActionResult } from "../types";

// Thin orchestration over the two SECURITY DEFINER RPCs
// (supabase/migrations/0013_reward_claim_rpcs.sql): call the RPC, translate
// its raised message into the { ok } | { ok: false, message, code? }
// contract actions.ts / the API routes hand back, and never let the raw
// Postgres error text reach a client (doc 33 "never expose internals").

// ---------------------------------------------------------------- claimReward

const GENERIC_CLAIM_ERROR = "Something went wrong. Please try again.";

// Keyed by the exact P0001 message strings claim_reward raises (plus the
// 42501 UNAUTHENTICATED case, which the service layer normalizes to the same
// "message" key before reaching here - see claimReward below). Consumer-
// facing copy per doc 33: friendly, never mentions rows, ids, or SQL.
const CLAIM_ERROR_COPY: Record<string, string> = {
  REWARD_UNAVAILABLE: "This reward is no longer available.",
  CUSTOMER_RECORD_MISSING: GENERIC_CLAIM_ERROR,
  CUSTOMER_BLACKLISTED: "This account cannot claim rewards from this business.",
  REWARD_LIMIT_REACHED: "You have already claimed this reward.",
  CAMPAIGN_LIMIT_REACHED: "You have already claimed this reward.",
  CAMPAIGN_BUDGET_EXHAUSTED: "This promo has reached its limit.",
  REWARD_OUT_OF_STOCK: "This reward just ran out.",
  POINTS_INSUFFICIENT: "You do not have enough points for this reward yet.",
  UNAUTHENTICATED: "Please sign in to claim rewards.",
};

/**
 * Maps a claim_reward RPC error message to a consumer-safe { code, message }
 * pair. `code` is the stable machine-readable string (the same one the RPC
 * raised, or "UNKNOWN"); `message` is always one of the friendly strings
 * above, never the raw Postgres text.
 */
export function mapClaimError(message: string): { code: string; message: string } {
  const copy = CLAIM_ERROR_COPY[message];
  if (copy !== undefined) return { code: message, message: copy };
  return { code: "UNKNOWN", message: GENERIC_CLAIM_ERROR };
}

export interface ClaimRewardData {
  claimId: string;
}

/**
 * Claims a reward for the signed-in consumer via the claim_reward RPC. All
 * of the eligibility/inventory/points guards live inside that RPC (single
 * atomic transaction under a row lock, doc 35 s6); this function only calls
 * it and maps the result. Session verification is the caller's job
 * (actions.ts) - this function assumes it is already running with an
 * authenticated Supabase client, though it still maps the RPC's own
 * UNAUTHENTICATED (42501) response defensively.
 */
export async function claimReward(rewardId: string): Promise<ActionResult<ClaimRewardData>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("claim_reward", { p_reward_id: rewardId });

  if (error || typeof data !== "string") {
    const mapped = mapClaimError(error?.message ?? "");
    return { ok: false, message: mapped.message, code: mapped.code };
  }

  return { ok: true, data: { claimId: data } };
}

// ---------------------------------------------------------- validateRedemption

const GENERIC_VALIDATE_ERROR = "Something went wrong. Please try again.";

// Staff-facing copy (the validate route is used by business staff at the
// counter, not the consumer) for every message validate_redemption raises,
// plus REDEMPTION_TOKEN_INVALID for a token that fails to consume before the
// RPC is ever called.
const VALIDATE_ERROR_COPY: Record<string, string> = {
  FORBIDDEN: "You do not have permission to validate for this business.",
  CLAIM_ALREADY_REDEEMED: "This reward was already redeemed.",
  CLAIM_ALREADY_CANCELLED: "This claim was cancelled by the customer.",
  CLAIM_INVALID_STATE: "This claim cannot be redeemed right now.",
  CLAIM_EXPIRED: "This claim has expired.",
  CUSTOMER_BLACKLISTED: "This account cannot redeem rewards at this business.",
  REDEMPTION_TOKEN_INVALID: "This code is no longer valid. Ask the customer to refresh it.",
  REDEMPTION_METHOD_INVALID: "Unsupported redemption method.",
  UNAUTHENTICATED: "Please sign in to validate redemptions.",
};

export function mapValidateError(message: string): { code: string; message: string } {
  const copy = VALIDATE_ERROR_COPY[message];
  if (copy !== undefined) return { code: message, message: copy };
  return { code: "UNKNOWN", message: GENERIC_VALIDATE_ERROR };
}

export interface ValidateRedemptionData {
  claimId: string;
  rewardName: string;
  consumerName: string | null;
  redeemedAt: string;
}

interface ValidateRedemptionRpcResult {
  claim_id: string;
  reward_name: string;
  consumer_name: string | null;
  redeemed_at: string;
}

function isValidateRedemptionRpcResult(value: unknown): value is ValidateRedemptionRpcResult {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.claim_id === "string" &&
    typeof v.reward_name === "string" &&
    (typeof v.consumer_name === "string" || v.consumer_name === null) &&
    typeof v.redeemed_at === "string"
  );
}

/**
 * Verifies a redemption token and validates the claim it names via the
 * validate_redemption RPC.
 *
 * ORDERING (deliberate): consumeRedemptionToken runs BEFORE the RPC. If the
 * RPC then fails (e.g. CLAIM_ALREADY_REDEEMED from a concurrent scan that
 * beat this one), the token has already been burned - that is CORRECT and
 * intended, not a bug. A single-use token that has been presented once must
 * never be usable again regardless of what happens next, so consuming it
 * first (rather than after a successful RPC call) is what makes it
 * genuinely single-use. The customer can simply refresh a new token/QR and
 * try again; a burned token is never the customer's problem to work around,
 * it is the anti-replay guarantee doing its job.
 */
export async function validateRedemption(
  token: string,
  method: "qr" | "manual_code" = "qr",
): Promise<ActionResult<ValidateRedemptionData>> {
  let payload;
  try {
    payload = await consumeRedemptionToken(token);
  } catch (err) {
    if (err instanceof RedemptionTokenError) {
      const mapped = mapValidateError("REDEMPTION_TOKEN_INVALID");
      return { ok: false, message: mapped.message, code: mapped.code };
    }
    throw err;
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("validate_redemption", {
    p_claim_id: payload.claimId,
    p_token_jti: payload.jti,
    p_method: method,
  });

  if (error || !isValidateRedemptionRpcResult(data)) {
    const mapped = mapValidateError(error?.message ?? "");
    return { ok: false, message: mapped.message, code: mapped.code };
  }

  return {
    ok: true,
    data: {
      claimId: data.claim_id,
      rewardName: data.reward_name,
      consumerName: data.consumer_name,
      redeemedAt: data.redeemed_at,
    },
  };
}

// ---------------------------------------------------------------- cancelClaim

const GENERIC_CANCEL_ERROR = "Something went wrong. Please try again.";

// Keyed by the exact P0001 message strings cancel_claim (0050) raises, plus
// the 42501 UNAUTHENTICATED case (actions.ts already answers this before the
// RPC is ever called; kept here defensively, matching claimReward's own
// posture). FORBIDDEN maps to the generic message rather than a specific
// one: it only ever fires for "not found" or "not your claim" (doc 13: the
// two cases share one message so probing ids is not an existence oracle),
// and a consumer-facing UI never lets a signed-in user reach this action for
// a claim that isn't in their own claims list to begin with.
const CANCEL_ERROR_COPY: Record<string, string> = {
  FORBIDDEN: GENERIC_CANCEL_ERROR,
  CLAIM_ALREADY_REDEEMED: "This reward was already redeemed, so it can no longer be cancelled.",
  CLAIM_ALREADY_CANCELLED: "This claim was already cancelled.",
  CLAIM_INVALID_STATE: "This claim can't be cancelled right now.",
  UNAUTHENTICATED: "Please sign in to manage your claims.",
};

/**
 * Maps a cancel_claim RPC error message to a consumer-safe { code, message }
 * pair, mirroring mapClaimError's shape exactly.
 */
export function mapCancelError(message: string): { code: string; message: string } {
  const copy = CANCEL_ERROR_COPY[message];
  if (copy !== undefined) return { code: message, message: copy };
  return { code: "UNKNOWN", message: GENERIC_CANCEL_ERROR };
}

export interface CancelClaimData {
  claimId: string;
}

/**
 * Cancels the signed-in consumer's own unredeemed claim via the cancel_claim
 * RPC (0050, SECURITY DEFINER). Every guard - ownership, claim status, the
 * race against a concurrent staff redemption - and the ledger reversal
 * (identical shape to expire_claims's single-claim reversal, via the shared
 * private.reverse_claim_ledger helper) live inside that RPC; this function
 * only calls it and maps the result. Session verification is the caller's
 * job (actions.ts), matching claimReward's own division of labor.
 */
export async function cancelClaim(claimId: string): Promise<ActionResult<CancelClaimData>> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_claim", { p_claim_id: claimId });

  if (error) {
    const mapped = mapCancelError(error.message ?? "");
    return { ok: false, message: mapped.message, code: mapped.code };
  }

  return { ok: true, data: { claimId } };
}
