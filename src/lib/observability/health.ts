import "server-only";

import { env } from "@/lib/env";
import { isQueueConfigured } from "@/lib/queue/publish";

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
// WHY PLAIN fetch, NOT THE SUPABASE/REDIS CLIENTS THIS CODEBASE ALREADY HAS
// -----------------------------------------------------------------------------
// src/lib/supabase/server.ts needs a real Next.js request (it calls
// cookies()), which a health probe has no reason to carry. src/lib/redis.ts
// goes through getServerEnv(), which validates the ENTIRE server schema as a
// unit and throws naming every missing key - exactly the incident
// src/lib/supabase/service.ts's header documents ("took out all eight
// business portal routes at once"). A health check is the worst possible
// place to inherit that failure mode: an unrelated missing variable would
// make the LIVENESS endpoint itself throw, which is a strictly worse outcome
// than reporting one dependency "down" and the rest honestly. So this module
// reads `process.env` directly for Redis (mirroring
// src/lib/supabase/service.ts's own reasoning) and talks to Postgres over
// PostgREST with the ANON key from the client-safe `env` export - never the
// service-role key, which is optional and frequently absent (see service.ts)
// and which a public liveness probe has no business holding anyway.
//
// That independence is from the SERVER schema (`getServerEnv()`) only, and
// that qualifier matters: this module still imports `env` from
// src/lib/env.ts, which is the CLIENT-safe schema, evaluated eagerly at
// module scope and just as capable of throwing at import time if
// `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are missing. The
// reason that is not the same risk is scale, not kind: that schema has two
// REQUIRED fields, both of them fundamentals every page in this app already
// needs to render at all (src/lib/supabase/server.ts and client.ts both read
// them unconditionally), so there is no unrelated-optional-field blast
// radius the way `getServerEnv()`'s dozens of independent integration
// credentials create. A deployment where `env` throws cannot serve ANY
// route, health included, and no design choice in this file changes that.
//
// The queue check is a partial exception to "no existing client": it calls
// src/lib/queue/publish.ts's exported `isQueueConfigured()` rather than
// re-deriving "is QStash configured" from raw env vars - see checkQueue()'s
// own comment for why re-deriving it was wrong.
//
// -----------------------------------------------------------------------------
// THE LEAK CONTRACT
// -----------------------------------------------------------------------------
// `DependencyCheck` below has exactly two fields: `status` and `latencyMs`.
// That is not an accident of what happened to get written - it is the entire
// leak defense. No branch in this file ever puts a caught error, a URL, a
// header value or a response body fragment into the object this module
// returns; every failure - thrown, or a non-2xx HTTP response with its own
// body and headers - reduces to one of three enum values and nothing else.
// A future change that wants to add detail (a specific error code, a
// hostname) has to widen this type deliberately, which is the point: the
// leak tests in health.test.ts (including one that feeds a realistic
// PostgREST/Upstash error body and headers through a non-2xx response, not
// only a thrown error) fail loudly if it does.

/**
 * `"ok"` - the round trip completed with a successful (2xx) HTTP status AND
 * the response body was what a healthy dependency gives.
 * `"degraded"` - the round trip completed with a 2xx status, but the body
 * was not what a healthy dependency gives (unexpected shape/value). The
 * dependency is reachable and answering requests; something about ITS
 * answer is off.
 * `"down"` - the round trip did not produce a trustworthy 2xx answer at
 * all: refused, timed out, DNS failure, thrown for any other reason, OR the
 * dependency itself answered with a non-2xx status (auth failure, 5xx, rate
 * limited). A dependency that refuses or errors on every request cannot be
 * served through, which is the bar this endpoint reports against - so
 * "unauthorized" and "internal error" are "down", not "degraded".
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
 * - only `console.error`, which stays server-side. The non-2xx-HTTP-response
 * branches inside each probe below do not go through this catch at all (a
 * non-2xx response is not a thrown error), which is exactly why they get
 * their own leak-test coverage: nothing here protects them structurally,
 * only the discipline of never reading `response.text()`/`.json()` on that
 * branch.
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
 * dependency: doc 13's whole API surface reads through Postgres. A non-2xx
 * response (PostgREST down, the anon key revoked, a 5xx from a paused or
 * pooler-exhausted project) is "down", not "degraded" - see
 * `DependencyStatus`'s own doc comment. */
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
    // The status code alone decides down-vs-not; the body is only consulted
    // on the 2xx branch (below) to tell ok from degraded, and even then only
    // its SHAPE (array or not) is inspected - its contents never are.
    if (!response.ok) return "down";

    const body: unknown = await response.json().catch(() => null);
    return Array.isArray(body) ? "ok" : "degraded";
  });
}

/** Redis reachability, over Upstash's REST API (same wire format as
 * src/lib/redis.ts's sendCommand). A hard dependency: doc 13's idempotency
 * gate and rate limiter both live here. Reports "down" rather than throwing
 * or omitting the dependency when unconfigured, because Redis is not
 * optional for this deployment the way the queue is - see checkQueue. A
 * non-2xx response (bad/revoked token, Upstash outage) is "down". */
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
    if (!response.ok) return "down";

    const body = (await response.json().catch(() => null)) as { result?: unknown } | null;
    return body?.result === "PONG" ? "ok" : "degraded";
  });
}

/**
 * Queue (QStash) reachability, or `null` when this deployment has no QStash
 * configuration at all.
 *
 * "Configured" is answered by `isQueueConfigured()`
 * (src/lib/queue/publish.ts), the SAME predicate `enqueue()` itself uses to
 * decide whether a publish will be attempted - deliberately not re-derived
 * from `QSTASH_URL`/`QSTASH_TOKEN` alone, which an earlier version of this
 * file did. That version could disagree with the queue about its own
 * readiness: `isQueueConfigured()` also requires `QSTASH_CALLBACK_ORIGIN`,
 * and publish.ts's own comment on `readConfig()` explains why - without a
 * publicly reachable callback origin, `enqueue()` writes the `jobs` row and
 * silently SKIPS publishing every time. A deployment in that state has a
 * queue that does not deliver anything, and this health check must call
 * that "not configured" (and omit it, matching "(if configured) the queue"),
 * not probe QStash's API directly and report "ok" while every real enqueue
 * quietly does nothing.
 *
 * `null` is deliberate and distinct from "down": a dependency this
 * deployment was never given cannot be reported unreachable.
 * `getHealth()` below omits it from the response entirely rather than
 * reporting a synthetic status for it.
 */
export async function checkQueue(
  overrides: Partial<HealthCheckDeps> = {},
): Promise<DependencyCheck | null> {
  if (!isQueueConfigured()) {
    return null;
  }

  const deps = resolveDeps(overrides);
  // isQueueConfigured() just confirmed QSTASH_URL, QSTASH_TOKEN and
  // QSTASH_CALLBACK_ORIGIN are all present (it reads them via
  // getServerEnv()). Only the first two have a value this probe needs; they
  // are re-read directly off process.env rather than through getServerEnv()
  // for the same reason every other check in this file does - see the
  // module header. The two reads are expected to agree with what
  // isQueueConfigured() just saw (same process.env, same instant), so the
  // fallback below is defensive rather than a real branch this deployment
  // can reach.
  const url = readEnvValue("QSTASH_URL");
  const token = readEnvValue("QSTASH_TOKEN");
  if (url === undefined || token === undefined) {
    return { status: "down", latencyMs: 0 };
  }

  return timedProbe(deps, "queue", async (signal) => {
    // GET /v2/queues: a read-only, side-effect-free QStash endpoint, used
    // purely to confirm the base URL and token are live - never to publish.
    const response = await deps.fetchImpl(`${stripTrailingSlashes(url)}/v2/queues`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    return response.ok ? "ok" : "down";
  });
}

/**
 * The full liveness/readiness report: one check per hard dependency, and the
 * queue only when configured. `httpStatus` is 503 the moment any HARD
 * dependency (database, Redis, or a CONFIGURED queue) is down - "degraded"
 * never flips it, because a degraded dependency answered with a healthy HTTP
 * status, just not the exact body a fully-healthy one gives, and 503 is
 * reserved for "cannot serve without it" per the brief.
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
