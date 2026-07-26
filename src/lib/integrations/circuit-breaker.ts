import "server-only";

import { del, get, incr, expireNx, redisKey, set, setNx } from "@/lib/redis";

// =============================================================================
// The circuit breaker every outbound integration call runs inside.
// =============================================================================
//
// docs/30-modules/42-integrations.md, "Integration resilience standards" #3:
// "Circuit breaker (Redis): `{env}:cb:{service}` - open after 5 consecutive
// failures in 60s, half-open probe after 30s. Open circuit -> queue jobs fail
// retryable (backoff does the waiting) and API surfaces return 503
// DEPENDENCY_UNAVAILABLE."
//
// Those three numbers are the contract and they are the defaults below. The
// key prefix comes from `redisKey`, which already namespaces by NODE_ENV, so
// `{env}:cb:{service}` falls out of using it.
//
// -----------------------------------------------------------------------------
// THE STATE MACHINE, AND WHY IT NEEDS FOUR KEYS RATHER THAN ONE
// -----------------------------------------------------------------------------
//
//   cb:{service}:open   present  -> OPEN. Reject immediately. TTL is the
//                                   half-open delay, so the state expires into
//                                   half-open with no scheduler and no
//                                   background task - which matters a lot in a
//                                   serverless runtime where there is nobody
//                                   to run a timer.
//   cb:{service}:probe  NX lock  -> the single half-open probe. Without it,
//                                   every concurrent caller at the moment the
//                                   open key expires would probe at once and
//                                   hammer a dependency that is very likely
//                                   still down. A "probe" is singular.
//   cb:{service}:half   present  -> we opened recently and have not seen a
//                                   success since. In this state ONE failure
//                                   re-opens. Without this key the failure
//                                   counter (reset on open) would demand five
//                                   fresh failures to re-open, so a dependency
//                                   that is still down would be hit five times
//                                   per recovery window forever.
//   cb:{service}:fails  counter  -> consecutive failures inside a 60s window.
//                                   TTL set with EXPIRE NX so later increments
//                                   do not keep pushing the window out (the
//                                   src/lib/rate-limit.ts pattern).
//
// -----------------------------------------------------------------------------
// THIS BREAKER FAILS OPEN. DELIBERATELY.
// -----------------------------------------------------------------------------
//
// If Redis itself is unreachable, the call is ALLOWED through. This codebase
// holds both stances on purpose and the contrast is the argument:
//
//   src/lib/api/handler.ts's idempotency gate and
//   src/features/rewards/server/token.ts fail CLOSED, because they guard
//   security properties - a replayed redemption is a double-spend, and an
//   outage is exactly when clients retry.
//
//   src/lib/rate-limit.ts fails OPEN, because it guards throughput only.
//
// A breaker is in the second family and further from the line than the rate
// limiter is. It exists to stop us hammering a dependency that is already
// down. Failing closed would mean a Redis blip takes out an integration that
// is working perfectly, which is the breaker manufacturing the outage it was
// installed to contain. So: log, and let the call through.

/** Doc 42's numbers. Overridable per service, but nothing overrides them yet. */
export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_FAILURE_WINDOW_SECONDS = 60;
export const DEFAULT_OPEN_SECONDS = 30;

/**
 * How long the "we opened recently" marker survives. Longer than the open
 * window, so a probe that fails re-opens on its first failure rather than
 * having to re-earn the threshold; short enough that a service which recovers
 * quietly (no traffic at all for five minutes) starts from a clean slate.
 */
const HALF_OPEN_MARKER_SECONDS = 300;

/**
 * How long one caller holds the right to be the half-open probe. Must exceed
 * the longest call it guards (10s for the Meta client) so a probe still in
 * flight is not joined by a second one, and must be short enough that a
 * crashed prober does not wedge recovery.
 */
const PROBE_LOCK_SECONDS = 15;

const LOG_PREFIX = "[integrations/circuit]";

export type CircuitState = "closed" | "open" | "half_open";

/**
 * Thrown INSTEAD of calling the dependency.
 *
 * Callers map this to their own vocabulary: an API route to 503
 * DEPENDENCY_UNAVAILABLE (doc 13), a queue worker to a retryable failure so
 * the backoff does the waiting (doc 42 #3). It is deliberately its own class
 * so neither has to sniff a message.
 */
export class CircuitOpenError extends Error {
  readonly service: string;

  constructor(service: string) {
    super(`The ${service} integration is temporarily unavailable.`);
    this.name = "CircuitOpenError";
    this.service = service;
  }
}

export interface CircuitBreakerOptions {
  /** The `{service}` segment of the key, e.g. "meta". */
  readonly service: string;
  readonly failureThreshold?: number;
  readonly failureWindowSeconds?: number;
  readonly openSeconds?: number;
  /**
   * Which thrown errors count against the breaker.
   *
   * Defaults to "all of them", but every real client should narrow it. A
   * breaker that counts our own bad requests is a breaker that one malformed
   * page id can trip for the whole tenant estate: a 400 from a provider
   * usually means WE sent something wrong, and retrying against a different
   * input would have worked fine. Timeouts, 5xx and transport failures are the
   * ones that say "this dependency is down", and those are the ones that
   * should open a circuit.
   */
  readonly isFailure?: (error: unknown) => boolean;
}

interface ResolvedKeys {
  readonly open: string;
  readonly probe: string;
  readonly half: string;
  readonly fails: string;
}

function keysFor(service: string): ResolvedKeys {
  return {
    open: redisKey("cb", service, "open"),
    probe: redisKey("cb", service, "probe"),
    half: redisKey("cb", service, "half"),
    fails: redisKey("cb", service, "fails"),
  };
}

/**
 * The breaker's current state, for diagnostics and for surfaces that want to
 * say "reconnect is unavailable right now" before offering a button.
 *
 * Reports "closed" when Redis is unreachable, matching the fail-open stance:
 * a state read that cannot be performed must not present itself as an outage.
 */
export async function circuitState(service: string): Promise<CircuitState> {
  const keys = keysFor(service);
  try {
    if ((await get(keys.open)) !== null) return "open";
    if ((await get(keys.half)) !== null) return "half_open";
    return "closed";
  } catch (error) {
    console.error(`${LOG_PREFIX} could not read state for ${service}`, error);
    return "closed";
  }
}

async function openCircuit(keys: ResolvedKeys, service: string, openSeconds: number): Promise<void> {
  await set(keys.open, String(Date.now()), openSeconds);
  await set(keys.half, "1", HALF_OPEN_MARKER_SECONDS);
  // The counter is reset because the half marker now carries the "we are in
  // trouble" state; leaving it would make the next window start part-used.
  await del(keys.fails);
  console.warn(`${LOG_PREFIX} opened for ${service} (${openSeconds}s)`);
}

async function recordFailure(
  keys: ResolvedKeys,
  service: string,
  threshold: number,
  windowSeconds: number,
  openSeconds: number,
): Promise<void> {
  // In the half-open state a single failure re-opens: the probe was the
  // question "is it back", and this is the answer.
  if ((await get(keys.half)) !== null) {
    await openCircuit(keys, service, openSeconds);
    return;
  }

  const count = await incr(keys.fails);
  // EXPIRE NX rather than EXPIRE: later increments must not keep pushing the
  // window out, and this repairs a key that somehow lost its TTL.
  await expireNx(keys.fails, windowSeconds);

  if (count >= threshold) {
    await openCircuit(keys, service, openSeconds);
  }
}

async function recordSuccess(keys: ResolvedKeys): Promise<void> {
  // "Consecutive" is the word doc 42 uses, so one success clears the count.
  await del(keys.fails);
  await del(keys.half);
  await del(keys.probe);
}

/**
 * Run `call` under the breaker for `service`.
 *
 * Throws `CircuitOpenError` WITHOUT invoking `call` when the circuit is open,
 * or when it is half-open and another caller already holds the probe. Anything
 * `call` throws is re-thrown unchanged after being recorded - the breaker
 * never swallows, converts or wraps a real failure, because the caller's own
 * error taxonomy is what the rest of the system branches on.
 */
export async function withCircuitBreaker<T>(
  options: CircuitBreakerOptions,
  call: () => Promise<T>,
): Promise<T> {
  const {
    service,
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    failureWindowSeconds = DEFAULT_FAILURE_WINDOW_SECONDS,
    openSeconds = DEFAULT_OPEN_SECONDS,
    isFailure = () => true,
  } = options;

  const keys = keysFor(service);

  let admitted: "closed" | "probe";
  try {
    if ((await get(keys.open)) !== null) {
      throw new CircuitOpenError(service);
    }

    if ((await get(keys.half)) !== null) {
      // Half-open: exactly one caller gets through. Everyone else is refused
      // as though the circuit were still open, which it effectively is until
      // the probe reports back.
      const acquired = await setNx(keys.probe, String(Date.now()), PROBE_LOCK_SECONDS);
      if (!acquired) {
        throw new CircuitOpenError(service);
      }
      admitted = "probe";
    } else {
      admitted = "closed";
    }
  } catch (error) {
    if (error instanceof CircuitOpenError) throw error;
    // Fail OPEN. See the header: a Redis blip must not take down an
    // integration that is working.
    console.error(`${LOG_PREFIX} state unavailable for ${service}; allowing the call`, error);
    admitted = "closed";
  }

  try {
    const result = await call();
    // Bookkeeping must never turn a SUCCESSFUL call into a failure, so a
    // Redis error here is logged and dropped. The worst case is a stale
    // counter, which the 60s TTL clears on its own.
    await recordSuccess(keys).catch((redisError: unknown) => {
      console.error(`${LOG_PREFIX} could not record success for ${service}`, redisError);
    });
    return result;
  } catch (error) {
    if (isFailure(error)) {
      await recordFailure(keys, service, failureThreshold, failureWindowSeconds, openSeconds).catch(
        (redisError: unknown) => {
          console.error(`${LOG_PREFIX} could not record failure for ${service}`, redisError);
        },
      );
    } else if (admitted === "probe") {
      // The probe did not learn anything about the dependency's health (this
      // was our own bad request), so release the lock and let the next caller
      // ask the real question rather than sitting out the lock's TTL.
      await del(keys.probe).catch(() => 0);
    }
    throw error;
  }
}
