import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { assertClaimOwner } from "@/features/rewards/server/claim-ownership";
import * as repo from "@/features/rewards/server/repo";
import { mintRedemptionToken } from "@/features/rewards/server/token";
import { createClient } from "@/lib/supabase/server";

// POST /api/v1/reward-claims/{claimId}/token
// Mints a short-lived, single-use redemption token for the CALLER'S OWN
// claim only (doc 35 s12: consumer / claim owner). repo.getClaim is RLS-
// scoped, but RLS on reward_claims is a UNION of two policies - the
// consumer's own claims OR any staff member of the owning business (see
// supabase/migrations/0012_campaigns.sql and
// src/features/rewards/server/claim-ownership.ts) - so RLS alone does NOT
// enforce ownership here. Without the explicit check below, any staff
// member of the business could mint a redemption token for a customer's
// claim and self-redeem it. Doc 13 envelope: { data } | { error: { code,
// message, request_id } }, always with an X-Request-Id header.

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

  let claim;
  try {
    claim = await repo.getClaim(claimId);
  } catch {
    return errorResponse(
      500,
      "INTERNAL",
      "Something went wrong. Please try again.",
      requestId,
    );
  }

  // "Not found" and "not yours" (whether the claim genuinely doesn't exist,
  // or RLS's staff-select union let a non-owning staff member's read
  // through) both resolve to the same generic 404 - doc 13's rule: never
  // distinguish absent from outside-caller-scope.
  if (!claim || !assertClaimOwner(claim, user.id)) {
    return errorResponse(404, "NOT_FOUND", "This claim was not found.", requestId);
  }

  if (claim.status === "redeemed") {
    return errorResponse(
      409,
      "CLAIM_ALREADY_REDEEMED",
      "This reward was already redeemed.",
      requestId,
    );
  }

  if (claim.status === "expired") {
    return errorResponse(422, "CLAIM_EXPIRED", "This claim has expired.", requestId);
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

  // snake_case JSON keys per doc 13 ("Timestamps ISO-8601 UTC ...
  // snake_case JSON keys"). Internal TS/DTO naming (minted.expiresAt) stays
  // camelCase; only the HTTP body is snake_case.
  const response = NextResponse.json(
    { data: { token: minted.token, expires_at: minted.expiresAt } },
    { status: 200 },
  );
  response.headers.set("X-Request-Id", requestId);
  return response;
}
