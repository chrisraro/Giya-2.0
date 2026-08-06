import {
  ACCOUNT_SUSPENDED,
  BUSINESS_SUSPENDED,
  readBusinessSuspension,
  readConsumerSuspension,
} from "@/lib/auth/suspension";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

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
 * it and maps the result.
 *
 * `userId` is REQUIRED, not re-derived. It used to call
 * `supabase.auth.getUser()` itself to learn who was claiming, and a review
 * caught why that was wrong: `getUser()` is a GoTrue network call, distinct
 * from the local JWT verification PostgREST does when the RPC itself reads
 * `auth.uid()`. On a transient `getUser()` failure this function saw
 * `user: null`, the suspension check below was SKIPPED entirely (wrapped in
 * `if (user)`), and the RPC call beneath it still succeeded off the same
 * cookie's locally-verified JWT - a suspended consumer's claim would go
 * through exactly when the network hiccuped. Taking `userId` as a parameter
 * (the caller, actions.ts, already resolved it via its OWN `getUser()` call
 * before ever reaching here - see the `NOT_SIGNED_IN` check) removes the
 * conditional entirely: the suspension check below is unconditional, so it
 * cannot silently no-op.
 *
 * SUSPENSION GATE (doc 30 section 2.8): claim_reward's own SQL guards
 * `business_customers.segment = 'blacklisted'`, a DIFFERENT, per-tenant
 * mechanism from `profiles.is_suspended` (platform-wide). Nothing inside the
 * RPC reads the suspension column, so this is the layer that closes that
 * gap - checked here, the ONE call site for this RPC (rewards/actions.ts is
 * the only caller), rather than in actions.ts, so any future caller of this
 * service function inherits the refusal for free rather than having to
 * remember to re-add it. Fails CLOSED: a suspension read this function
 * cannot trust refuses the claim rather than risk letting a suspended
 * consumer spend points, matching this codebase's own convention for a
 * money-adjacent advisory read (receipts/server/award.ts's
 * `campaignPointsAwarded`/`campaignCustomerEarnCount`, admin/consequences.ts's
 * `assertCanAct`).
 */
export async function claimReward(
  rewardId: string,
  userId: string,
): Promise<ActionResult<ClaimRewardData>> {
  const supabase = await createClient();

  const suspension = await readConsumerSuspension(supabase, userId);
  if (suspension === "suspended") {
    return {
      ok: false,
      message: "Your account is suspended. Contact us if you think this is a mistake.",
      code: ACCOUNT_SUSPENDED,
    };
  }
  if (suspension === "unknown") {
    return { ok: false, message: GENERIC_CLAIM_ERROR, code: "DEPENDENCY_UNAVAILABLE" };
  }

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

  // SUSPENSION GATE (doc 30 section 2.8), BOTH sides of the redemption.
  //
  // validate_redemption's own SQL guards the CLAIM's
  // `business_customers.segment = 'blacklisted'` (a different, per-customer
  // mechanism); nothing inside the RPC reads `businesses.status` or
  // `profiles.is_suspended`. Two separate refusals belong here, not one:
  //
  //   * BUSINESS_SUSPENDED - a suspended merchant's staff must not be able to
  //     process a redemption at all.
  //   * ACCOUNT_SUSPENDED  - the CLAIMING CONSUMER'S own suspension. Points
  //     already moved at claim time (0013: "NO ledger entry here"), so this
  //     is not about stopping a second spend - it is about the merchandise:
  //     redemption is the irreversible step where points convert into
  //     inventory or service handed to that specific person, and doc 37's
  //     usual reason to reach this ladder step is that the points behind the
  //     claim were fraudulently earned in the first place. Without this
  //     check, a consumer could pre-claim rewards, get suspended, and keep
  //     minting fresh tokens (or simply hand off an existing one) to walk out
  //     with goods for every held claim - the token route itself is ALSO
  //     gated (see reward-claims/[claimId]/token/route.ts) so new tokens
  //     cannot be minted post-suspension, but a token minted just before
  //     suspension is still live for its 5-minute TTL, which is what this
  //     check closes.
  //
  // Read via the SERVICE ROLE client, not the caller's session-scoped one:
  // `profiles_owner_select` RLS is self-select only, so a staff member's own
  // session can never see whether the CUSTOMER's account is suspended - that
  // fact is simply invisible to them, by design, for every other profile
  // field too. The claim's own `business_id`/`consumer_id` are read fresh
  // here (rather than trusted from the token payload) so this is the
  // authoritative pair the redemption is actually about.
  //
  // Fails CLOSED throughout: a claim read this function cannot trust, or a
  // suspension status it cannot trust, refuses the redemption rather than
  // risk letting one through - same posture as claimReward's own gate.
  const serviceClient = createServiceRoleClient();
  if (serviceClient === null) {
    console.error(
      "[rewards/service] SUPABASE_SERVICE_ROLE_KEY is not configured; cannot verify suspension state for a redemption",
    );
    return { ok: false, message: GENERIC_VALIDATE_ERROR, code: "DEPENDENCY_UNAVAILABLE" };
  }

  const { data: claimRow, error: claimError } = await serviceClient
    .from("reward_claims")
    .select("business_id, consumer_id")
    .eq("id", payload.claimId)
    .maybeSingle<{ business_id: string; consumer_id: string }>();

  if (claimError !== null) {
    console.error("[rewards/service] could not read the claim for suspension checks", claimError);
    return { ok: false, message: GENERIC_VALIDATE_ERROR, code: "DEPENDENCY_UNAVAILABLE" };
  }

  // A genuinely unknown claim id is not this gate's problem to report - the
  // RPC below already answers FORBIDDEN for that case (doc 13: never
  // distinguish absent from outside-caller-scope), so skip straight to it
  // rather than invent a second "not found" shape.
  if (claimRow !== null) {
    const [businessSuspension, consumerSuspension] = await Promise.all([
      readBusinessSuspension(serviceClient, claimRow.business_id),
      readConsumerSuspension(serviceClient, claimRow.consumer_id),
    ]);

    if (businessSuspension === "suspended") {
      return {
        ok: false,
        message: "Redemptions are paused for this business account.",
        code: BUSINESS_SUSPENDED,
      };
    }
    if (consumerSuspension === "suspended") {
      return {
        ok: false,
        message: "This customer's account is suspended and cannot redeem rewards.",
        code: ACCOUNT_SUSPENDED,
      };
    }
    if (businessSuspension === "unknown" || consumerSuspension === "unknown") {
      return { ok: false, message: GENERIC_VALIDATE_ERROR, code: "DEPENDENCY_UNAVAILABLE" };
    }
  }

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
