import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import * as repo from "@/features/rewards/server/repo";
import { mintRedemptionToken } from "@/features/rewards/server/token";
import { createClient } from "@/lib/supabase/server";

// POST /api/v1/reward-claims/{claimId}/token
// Mints a short-lived, single-use redemption token for one of the caller's
// own claims (repo.getClaim is RLS-scoped, so ownership is enforced by the
// database, not by application code re-checking a consumer_id). Doc 13
// envelope: { data } | { error: { code, message, request_id } }, always
// with an X-Request-Id header.

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): NextResponse {
  const response = NextResponse.json(
    { error: { code, message, request_id: requestId } },
    { status },
  );
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ claimId: string }> },
): Promise<NextResponse> {
  const requestId = randomUUID();
  const { claimId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Please sign in to generate a redemption code.",
      requestId,
    );
  }

  // RLS (reward_claims_consumer_select / reward_claims_staff_select) is the
  // real authorization boundary: a claim outside the caller's scope simply
  // does not come back, and "not found" and "not yours" both resolve to the
  // same 404 (doc 13's rule: never distinguish the two).
  const claim = await repo.getClaim(claimId);
  if (!claim) {
    return errorResponse(404, "NOT_FOUND", "This claim was not found.", requestId);
  }

  if (claim.status !== "claimed") {
    return errorResponse(
      422,
      "CLAIM_INVALID_STATE",
      "This claim cannot be used to generate a redemption code right now.",
      requestId,
    );
  }

  if (new Date(claim.expiresAt) <= new Date()) {
    return errorResponse(422, "CLAIM_EXPIRED", "This claim has expired.", requestId);
  }

  let minted;
  try {
    minted = await mintRedemptionToken(claimId, claim.businessId);
  } catch {
    return errorResponse(
      500,
      "INTERNAL",
      "Something went wrong. Please try again.",
      requestId,
    );
  }

  // Response keys are camelCase here (not the snake_case doc 13 otherwise
  // recommends) per this endpoint's binding spec: { data: { token,
  // expiresAt } }.
  const response = NextResponse.json(
    { data: { token: minted.token, expiresAt: minted.expiresAt } },
    { status: 200 },
  );
  response.headers.set("X-Request-Id", requestId);
  return response;
}
