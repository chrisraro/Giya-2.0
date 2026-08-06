import "server-only";

import { env } from "@/lib/env";

// =============================================================================
// getHealth(): the aggregate behind GET /api/v1/health.
// =============================================================================
//
// docs/50-ops/52-monitoring-observability.md names this route as the target of
// a multi-region synthetic uptime probe every minute, and t2-3-brief.md is
// this task's own spec: "Reports reachability of the dependencies the app
// cannot serve without: database, Redis, and (if configured) the queue."
//
// -----------------------------------------------------------------------------
// WHY PLAIN fetch, NOT THE SUPABASE/REDIS/QSTASH CLIENTS THIS CODEBASE ALREADY
// HAS
// -----------------------------------------------------------------------------
// src/lib/supabase/server.ts needs a real Next.js request (it calls
// cookies()), which a health probe has no reason to carry. src/lib/redis.ts
// and src/lib/queue/publish.ts both go through getServerEnv(), which validates
// the ENTIRE server schema as a unit and throws naming every missing key -
// exactly the incident src/lib/supabase/service.ts's header documents ("took
// out all eight business portal routes at once"). A health check is the worst
// possible place to inherit that failure mode: an unrelated missing variable
// would make the LIVENESS endpoint itself throw, which is a strictly worse
// outcome than reporting one dependency "down" and the rest honestly. So this
// module reads `process.env` directly for Redis and QStash (mirroring
// service.ts's own reasoning) and talks to Postgres over PostgREST with the
// ANON key from the client-safe `env` export - never the service-role key,
// which is optional and frequently absent (see service.ts) and which a public
// liveness probe has no business holding anyway.
//
// -----------------------------------------------------------------------------
// THE LEAK CONTRACT
// -----------------------------------------------------------------------------
// `DependencyCheck` below has exactly two fields: `status` and `latencyMs`.
// That is not an accident of what happened to get written - it is the entire
// leak defense. No branch in this file ever puts a caught error, a URL, a
// header value or a response body fragment into the object this module
// returns; every catch block below reduces its failure to one of three enum
// values and nothing else. A future change that wants to add detail (a
// specific error code, a hostname) has to widen this type deliberately, which
// is the point: the leak test in health.test.ts fails loudly if it does.

/**
 * `"ok"` - the dependency answered as expected.
 * `"degraded"` - the round trip completed (no network error, no timeout) but
 * the answer was not what a healthy dependency gives (a non-2xx status, an
 * unexpected body). The dependency is reachable, just not confirmed correct.
 * `"down"` - the round trip itself failed: refused, timed out, DNS failure,
 * or thrown for any other reason.
 */
export type DependencyStatus = "ok" | "degraded" | "down";

export interface DependencyCheck {
  readonly status: DependencyStatus;
  /** Coarse, integer milliseconds. Doc: "useful and non-sensitive." */
  readonly latencyMs: number;
}

export interface HealthCheckDeps {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

export interface HealthResult {
  readonly httpStatus: 200 | 503;
  readonly dependencies: Readonly<Record<string, DependencyCheck>>;
}

/** Doc 52's probe budget is <500ms for the whole internal metrics probe; this
 * is a public liveness check hit from multiple regions, so it gets a little
 * more room before declaring a dependency unreachable rather than merely
 * slow, but still short enough that a hung probe never becomes a hung route. */
const DEFAULT_TIMEOUT_MS = 3_000;

/** `ref_cities` (migration 0002): the smallest table with an unconditional
 * `for select to anon, authenticated using (true)` policy in the schema. The
 * point of this query is round-trip reachability, not its result, so the
 * smallest publicly-readable table is the right one to spend it on. */
const DB_PING_PATH = "/rest/v1/ref_cities?select=id&limit=1";

function resolveDeps(overrides: Partial<HealthCheckDeps> = {}): HealthCheckDeps {
  return {
    fetchImpl: overrides.fetchImpl ?? fetch,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** "" and whitespace-only both read as unset, matching env.ts's
 * emptyToUndefined - a platform dashboard's "set but blank" must not be
 * mistaken for "configured". */
function readEnvValue(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim().length === 0 ? undefined : raw;
}

/**
 * Runs `probe`, converting ANY thrown value (network error, timeout, a
 * malformed response the probe itself throws on) into `"down"` and the
 * elapsed time into `latencyMs`. This is the one place a caught error's
 * `message` could leak into the result, so it never touches the return value
 * - only `console.error`, which stays server-side.
 */
async function timedProbe(
  deps: HealthCheckDeps,
  label: string,
  probe: (signal: AbortSignal) => Promise<DependencyStatus>,
): Promise<DependencyCheck> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  try {
    const status = await probe(controller.signal);
    return { status, latencyMs: Date.now() - start };
  } catch (error) {
    console.error(`[observability/health] ${label} check failed`, error);
    return { status: "down", latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

/** Database reachability, over PostgREST with the anon key. A hard
 * dependency: doc 13's whole API surface reads through Postgres. */
export async function checkDatabase(
  overrides: Partial<HealthCheckDeps> = {},
): Promise<DependencyCheck> {
  const deps = resolveDeps(overrides);
  return timedProbe(deps, "database", async (signal) => {
    const url = `${stripTrailingSlashes(env.NEXT_PUBLIC_SUPABASE_URL)}${DB_PING_PATH}`;
    const response = await deps.fetchImpl(url, {
      method: "GET",
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
      signal,
    });
    return response.ok ? "ok" : "degraded";
  });
}

/** Redis reachability, over Upstash's REST API (same wire format as
 * src/lib/redis.ts's sendCommand). A hard dependency: doc 13's idempotency
 * gate and rate limiter both live here. Reports "down" rather than throwing
 * or omitting the dependency when unconfigured, because Redis is not
 * optional for this deployment the way the queue is - see checkQueue. */
export async function checkRedis(
  overrides: Partial<HealthCheckDeps> = {},
): Promise<DependencyCheck> {
  const deps = resolveDeps(overrides);
  return timedProbe(deps, "redis", async (signal) => {
    const url = readEnvValue("UPSTASH_REDIS_REST_URL");
    const token = readEnvValue("UPSTASH_REDIS_REST_TOKEN");
    if (url === undefined || token === undefined) {
      return "down";
    }

    const response = await deps.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["PING"]),
      signal,
    });
    if (!response.ok) return "degraded";

    const body = (await response.json().catch(() => null)) as { result?: unknown } | null;
    return body?.result === "PONG" ? "ok" : "degraded";
  });
}

/**
 * Queue (QStash) reachability, or `null` when this deployment has no QStash
 * configuration at all.
 *
 * `null` is deliberate and distinct from "down": src/lib/queue/publish.ts's
 * `readConfig()` treats an unconfigured queue as a first-class state (doc 39:
 * credentials "landed at the end of the build like every other one"), and a
 * dependency this deployment was never given cannot be reported unreachable.
 * `getHealth()` below omits it from the response entirely rather than
 * reporting a synthetic status for it, matching the brief's "(if configured)
 * the queue".
 */
export async function checkQueue(
  overrides: Partial<HealthCheckDeps> = {},
): Promise<DependencyCheck | null> {
  const deps = resolveDeps(overrides);
  const url = readEnvValue("QSTASH_URL");
  const token = readEnvValue("QSTASH_TOKEN");
  if (url === undefined || token === undefined) {
    return null;
  }

  return timedProbe(deps, "queue", async (signal) => {
    // GET /v2/queues: a read-only, side-effect-free QStash endpoint, used
    // purely to confirm the base URL and token are live - never to publish.
    const response = await deps.fetchImpl(`${stripTrailingSlashes(url)}/v2/queues`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    return response.ok ? "ok" : "degraded";
  });
}

/**
 * The full liveness/readiness report: one check per hard dependency, and the
 * queue only when configured. `httpStatus` is 503 the moment any HARD
 * dependency (database, Redis, or a CONFIGURED queue) is down - "degraded"
 * never flips it, because a degraded dependency answered, just not exactly
 * as expected, and 503 is reserved for "cannot serve without it" per the
 * brief.
 */
export async function getHealth(overrides: Partial<HealthCheckDeps> = {}): Promise<HealthResult> {
  const deps = resolveDeps(overrides);

  const [database, redis, queue] = await Promise.all([
    checkDatabase(deps),
    checkRedis(deps),
    checkQueue(deps),
  ]);

  const dependencies: Record<string, DependencyCheck> = { database, redis };
  if (queue !== null) {
    dependencies.queue = queue;
  }

  const hardDown =
    database.status === "down" || redis.status === "down" || queue?.status === "down";

  return { httpStatus: hardDown ? 503 : 200, dependencies };
}
