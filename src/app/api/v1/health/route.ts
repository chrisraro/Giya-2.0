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
// tests) - this file is only the HTTP shape around it: pick the status code
// doc 13 uses for a success payload with a non-2xx status (the same
// `HandlerResult.status` field src/app/api/v1/receipts/route.ts uses for its
// 202), and make sure the response is never cached anywhere between here and
// the monitor.

export const dynamic = "force-dynamic";

interface HealthPayload {
  readonly status: "ok" | "down";
  readonly dependencies: Readonly<Record<string, DependencyCheck>>;
}

export const GET = defineHandler<HealthPayload>({
  route: "health",
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
      // answer.
      headers: { "Cache-Control": "no-store" },
    };
  },
});
