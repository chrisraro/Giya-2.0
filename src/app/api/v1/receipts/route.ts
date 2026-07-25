import { canonicalizeReceiptImage } from "@/features/receipts/server/image";
import { processReceipt } from "@/features/receipts/server/process";
import {
  requireServiceRoleClient,
  submitReceipt,
  submitReceiptBodySchema,
} from "@/features/receipts/server/submit";
import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import { defineHandler } from "@/lib/api/handler";
import { checkRateLimit } from "@/lib/rate-limit";
import { redisKey } from "@/lib/redis";

// POST /api/v1/receipts
//
// Step 2 of doc 36 Stage 1: the uploaded object becomes a queued receipt.
// Everything substantive lives in src/features/receipts/server/submit.ts; this
// file is the doc 13 shell around it (envelope, Idempotency-Key, rate limits)
// plus the one thing the shared handler cannot express, the second rate-limit
// window.
//
// 202, not 201: the receipt row exists, but the answer the consumer actually
// wants (approved, review or rejected, and how many points) is decided
// asynchronously by the pipeline. Doc 36's Realtime contract has the client
// subscribe to the row on this response.

/** Doc 36 Stage 1 step 1: "rate limit 6/min, 60/day per consumer". */
const SUBMIT_PER_MINUTE = 6;
const SUBMIT_PER_MINUTE_WINDOW_SECONDS = 60;
const SUBMIT_PER_DAY = 60;
const SUBMIT_PER_DAY_WINDOW_SECONDS = 86_400;

/**
 * The daily half of the limit. `RateLimitConfig` in src/lib/api/handler.ts
 * expresses ONE window per route, and doc 36 specifies two, so the burst window
 * (6/min) is configured on the handler and the sustained window (60/day) is
 * checked here against the same `checkRateLimit` primitive.
 *
 * Consequences of that split, all deliberate:
 *
 *   - The daily counter is only reached by requests that already passed the
 *     per-minute check, which is the correct order: a caller being throttled
 *     for bursting should not also burn their daily quota.
 *   - It runs INSIDE the handler, therefore after the idempotency gate, so a
 *     replayed Idempotency-Key returns the cached 202 without consuming another
 *     day-slot. A retry of one submission is one submission.
 *   - The key is scoped to the day window explicitly rather than reusing the
 *     handler's `rl:receipts.submit:*` namespace, which the minute window owns.
 */
async function assertDailyQuota(userId: string): Promise<void> {
  const result = await checkRateLimit({
    key: redisKey("rl", "receipts.submit.day", `user:${userId}`),
    limit: SUBMIT_PER_DAY,
    windowSeconds: SUBMIT_PER_DAY_WINDOW_SECONDS,
  });

  if (result.ok) return;

  throw new ApiError(
    429,
    API_ERROR_CODES.RATE_LIMITED,
    "You have reached today's scan limit. Please try again tomorrow.",
    undefined,
    {
      // The real remaining TTL, not the nominal 24h, for the same reason the
      // shared handler does it: a client told to wait a day when eleven minutes
      // remain will simply stop scanning.
      "Retry-After": String(result.resetSeconds),
      "X-RateLimit-Limit": String(SUBMIT_PER_DAY),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.resetSeconds),
    },
  );
}

export const POST = defineHandler({
  route: "receipts.submit",
  requireSession: true,
  schema: submitReceiptBodySchema,
  // Doc 13 + doc 36: required. A receipt is money; a client that times out and
  // retries must not be able to file the same submission twice. (The database's
  // `receipts_sha_unique` would catch a byte-identical repeat as a 422, which
  // is a confusing answer to a retry the consumer never intended.)
  idempotent: true,
  rateLimit: { limit: SUBMIT_PER_MINUTE, windowSeconds: SUBMIT_PER_MINUTE_WINDOW_SECONDS },
  handler: async ({ user, body }) => {
    await assertDailyQuota(user.id);

    const result = await submitReceipt(
      { userId: user.id, body },
      {
        // Service role: `receipts` has no client insert policy at all
        // (0017_receipts.sql), by design.
        supabase: requireServiceRoleClient(),
        canonicalize: canonicalizeReceiptImage,
        processReceipt,
      },
    );

    return {
      data: { receipt_id: result.receiptId, status: result.status },
      status: 202,
    };
  },
});
