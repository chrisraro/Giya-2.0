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
// What happens when Redis (or the env it needs) is down is a PER-CALL policy,
// `failMode`, because the right answer depends on what the limit protects:
//
//   - "open" (default): a pure abuse/load throttle. A Redis blip failing the
//     route entirely would take down a legitimate feature over what is, at
//     worst, a temporary loss of throttling, so we log and let the request
//     through rather than 5xx-ing every caller until Redis recovers.
//   - "closed": the limit IS the control - receipt-submission caps (money),
//     redemption-token minting, bearer-token brute-force bounds on ops routes.
//     Failing open there deletes the control during exactly the outage an
//     attacker would wait for. Callers get `{ ok: false, unavailable: true }`
//     and must map it to 503 DEPENDENCY_UNAVAILABLE, NOT 429: telling a user to
//     wait out a limit they never hit is a lie, and 503 is what doc 13 says
//     clients may retry. (src/features/rewards/server/token.ts already fails
//     closed for the same reason.)
export type RateLimitFailMode = "open" | "closed";

export interface CheckRateLimitParams {
  key: string;
  limit: number;
  windowSeconds: number;
  failMode?: RateLimitFailMode;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSeconds: number;
  // Set only when failMode "closed" rejected because the limiter itself was
  // unreachable, so callers can tell "outage" (503) from "over limit" (429).
  unavailable?: boolean;
}

export async function checkRateLimit({
  key,
  limit,
  windowSeconds,
  failMode = "open",
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
    // See the file-level comment for the policy. Log either way so a sustained
    // Redis outage is visible in server logs.
    if (failMode === "closed") {
      console.error("[rate-limit] Redis error, failing closed", error);
      return { ok: false, remaining: 0, resetSeconds: windowSeconds, unavailable: true };
    }
    console.error("[rate-limit] Redis error, failing open", error);
    return { ok: true, remaining: limit, resetSeconds: windowSeconds };
  }
}
