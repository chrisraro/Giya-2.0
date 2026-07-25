import "server-only";

import { expire, incr } from "@/lib/redis";

// Fixed-window rate limiter over Redis INCR + EXPIRE. The first increment
// of a window sets the TTL; every later increment in the same window rides
// that same TTL, so the window boundary never gets pushed out by traffic.
//
// Fail-OPEN, not fail-closed - and that is a deliberate contrast with
// src/features/rewards/server/token.ts, which fails CLOSED. The token path
// guards a security property (single-use redemption): an outage there must
// never be treated as "allowed", since that would let a code be replayed.
// This path only guards against abuse/load; a Redis blip failing the mint
// route entirely would take down a legitimate feature over what is, at
// worst, a temporary loss of throttling. So on any Redis error we log and
// let the request through, rather than 500/429-ing every caller until
// Redis recovers.
export interface CheckRateLimitParams {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSeconds: number;
}

export async function checkRateLimit({
  key,
  limit,
  windowSeconds,
}: CheckRateLimitParams): Promise<RateLimitResult> {
  try {
    const count = await incr(key);
    if (count === 1) {
      // Only the request that just created the window sets its TTL; later
      // increments must not extend it.
      await expire(key, windowSeconds);
    }

    return {
      ok: count <= limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: windowSeconds,
    };
  } catch (error) {
    // Fail open: see file-level comment. Log so a sustained Redis outage is
    // visible in server logs even though it no longer blocks traffic.
    console.error("[rate-limit] Redis error, failing open", error);
    return { ok: true, remaining: limit, resetSeconds: windowSeconds };
  }
}
