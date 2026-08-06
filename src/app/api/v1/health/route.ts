import { defineHandler } from "@/lib/api/handler";
import { getHealth } from "@/lib/observability/health";
import type { DependencyCheck } from "@/lib/observability/health";

// GET /api/v1/health - public liveness/readiness. t2-3-brief.md:
//
//   "Reports reachability of the dependencies the app cannot serve without:
//   database, Redis, and (if configured) the queue. Returns 200 when
//   healthy, 503 when a hard dependency is down."
//
// docs/50-ops/52-monitoring-observability.md names this exact path as the
// target of a multi-region synthetic uptime probe every minute, so it stays
// under /api/v1 (unlike /api/internal/metrics) and goes through
// `defineHandler` like every other route there - doc 13: "handlers never
// hand-roll envelopes." No session is required and none is checked: this is
// the one /api/v1 route an anonymous uptime monitor is meant to reach.
//
// The dependency checks themselves live in src/lib/observability/health.ts,
// which is the module doing the actual work (and carrying the leak-contract
// tests, including one that drives the check through the REAL route -
// route.leak.test.ts beside this file). This file is only the HTTP shape
// around it.
//
// -----------------------------------------------------------------------------
// A DELIBERATE, NAMED DEVIATION FROM DOC 13'S ENVELOPE
// -----------------------------------------------------------------------------
// Doc 13 models exactly two response shapes: a success (`{ data, meta }`,
// always 2xx-ish by convention) and an error (`{ error: { code, message,
// ... } }`, always non-2xx). This route needs a THIRD thing doc 13 does not
// name: a fully-formed, non-error BODY describing every dependency, at a
// NON-2xx status. That is not the same deviation `receipts` route's 202
// makes (202 Accepted is itself a success status, so that route stays
// entirely inside doc 13's success shape) - 503 here is doc 13's own
// registered code for "client may retry", squarely on the error side of the
// split. Putting this payload through the error envelope instead would lose
// the per-dependency detail the brief asks for: `error.details` is doc 13's
// itemised `{field, issue}` shape for validation problems, not a free-form
// status map, and an unhealthy dependency is not a mistake the CALLER made
// for `error.code`/`message` to describe. So this route answers with the
// SUCCESS envelope's `data` field carrying the full report, at whatever
// status `getHealth()` decided (200 or 503) via `HandlerResult.status` - an
// unusual use of that field, written down here rather than left for someone
// to reverse-engineer.

export const dynamic = "force-dynamic";

interface HealthPayload {
  readonly status: "ok" | "down";
  readonly dependencies: Readonly<Record<string, DependencyCheck>>;
}

/**
 * Generous relative to doc 52's "≥2 regions every minute" monitor traffic,
 * and scoped by IP (there is no session): this route is PUBLIC, uncached by
 * design, and fans out to two-to-three metered third-party APIs (Supabase
 * PostgREST, Upstash Redis, and QStash when configured) on every hit, so
 * leaving it unbounded is a cost-amplification vector with no ceiling. The
 * limiter itself fails OPEN on a Redis outage (src/lib/rate-limit.ts) so a
 * Redis blip can never be the reason this endpoint stops answering.
 */
const HEALTH_RATE_LIMIT = 30;
const HEALTH_RATE_LIMIT_WINDOW_SECONDS = 60;

export const GET = defineHandler<HealthPayload>({
  route: "health",
  rateLimit: {
    limit: HEALTH_RATE_LIMIT,
    windowSeconds: HEALTH_RATE_LIMIT_WINDOW_SECONDS,
    keyBy: "ip",
  },
  handler: async () => {
    const result = await getHealth();

    return {
      data: {
        status: result.httpStatus === 200 ? "ok" : "down",
        dependencies: result.dependencies,
      },
      status: result.httpStatus,
      // A liveness probe answering from a CDN or browser cache is a liveness
      // probe lying about the present. Doc 52's monitor hits this every
      // minute from >=2 regions specifically because it wants THIS second's
      // answer. Applies on both the 200 and 503 branches above, since both
      // return through this same object.
      headers: { "Cache-Control": "no-store" },
    };
  },
});
