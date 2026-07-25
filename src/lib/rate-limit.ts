import "server-only";

import { expireNx, incr, ttl } from "@/lib/redis";

// Fixed-window rate limiter over Redis INCR + a self-healing EXPIRE ... NX.
// EXPIRE ... NX only sets a TTL when the key currently has none, so it is
// called on every request rather than gated behind "count === 1": the old
// gate meant that if a process died or Redis blipped between an earlier
// INCR and its EXPIRE, the key was left counting up with NO TTL forever -
// count === 1 never recurs, so EXPIRE would never be retried, and that
// (user, claim) pair would get 429'd on every future call permanently.
// Calling EXPIRE ... NX unconditionally means the very next request after
// such a gap repairs the missing TTL itself, at the cost of one extra
// idempotent Redis command per call.
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

    // Self-healing: see file-level comment. Idempotent on every request,
    // not just the first increment of a window.
    await expireNx(key, windowSeconds);

    // Read back the real remaining TTL so Retry-After is honest instead of
    // always reporting the full window. -1 (no TTL - should be unreachable
    // right after expireNx above, but never trusted blindly) and -2 (key
    // expired out from under us between the calls above) both fall back to
    // the full window rather than leaking a nonsensical Retry-After value.
    const remainingTtl = await ttl(key);
    const resetSeconds = remainingTtl > 0 ? remainingTtl : windowSeconds;

    return {
      ok: count <= limit,
      remaining: Math.max(0, limit - count),
      resetSeconds,
    };
  } catch (error) {
    // Fail open: see file-level comment. Log so a sustained Redis outage is
    // visible in server logs even though it no longer blocks traffic.
    console.error("[rate-limit] Redis error, failing open", error);
    return { ok: true, remaining: limit, resetSeconds: windowSeconds };
  }
}
