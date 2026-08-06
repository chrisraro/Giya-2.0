import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { validateRedemptionBodySchema } from "@/features/rewards/schemas";
import * as service from "@/features/rewards/server/service";
import { createClient } from "@/lib/supabase/server";

// POST /api/v1/redemptions/validate
// Staff-facing: consumes a customer's one-time redemption token and marks
// the claim it names as redeemed via the validate_redemption RPC. Doc 13
// envelope: { data } | { error: { code, message, request_id } }, always
// with an X-Request-Id header. The success payload passes the RPC's own
// (snake_case) field names through, per this endpoint's binding spec.

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

// Maps service.mapValidateError's codes to HTTP status per doc 13's error
// code registry (401 UNAUTHENTICATED, 403 FORBIDDEN, 409 CONFLICT for state
// conflicts, 422 for domain-validation-shaped codes). Codes not in this map
// (an "UNKNOWN" mapped error, or a genuinely unexpected one) fall through to
// 500 INTERNAL below.
const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CUSTOMER_BLACKLISTED: 403,
  // Doc 30 section 2.8's registered code for a suspended tenant
  // (src/lib/auth/suspension.ts's businessSuspension gate in
  // rewards/server/service.ts's validateRedemption).
  BUSINESS_SUSPENDED: 403,
  CLAIM_ALREADY_REDEEMED: 409,
  CLAIM_INVALID_STATE: 409,
  CLAIM_EXPIRED: 422,
  REDEMPTION_TOKEN_INVALID: 422,
  REDEMPTION_METHOD_INVALID: 422,
  DEPENDENCY_UNAVAILABLE: 503,
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse(
      401,
      "UNAUTHENTICATED",
      "Please sign in to validate redemptions.",
      requestId,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(422, "VALIDATION_FAILED", "Request body must be valid JSON.", requestId);
  }

  const parsed = validateRedemptionBodySchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      422,
      "VALIDATION_FAILED",
      parsed.error.issues[0]?.message ?? "Invalid input.",
      requestId,
    );
  }

  const result = await service.validateRedemption(parsed.data.token, parsed.data.method ?? "qr");

  if (!result.ok) {
    const code = result.code ?? "INTERNAL";
    const status = STATUS_BY_CODE[code] ?? 500;
    return errorResponse(status, code, result.message, requestId);
  }

  if (!result.data) {
    return errorResponse(
      500,
      "INTERNAL",
      "Something went wrong. Please try again.",
      requestId,
    );
  }

  const response = NextResponse.json(
    {
      data: {
        claim_id: result.data.claimId,
        reward_name: result.data.rewardName,
        consumer_name: result.data.consumerName,
        redeemed_at: result.data.redeemedAt,
      },
    },
    { status: 200 },
  );
  response.headers.set("X-Request-Id", requestId);
  return response;
}
