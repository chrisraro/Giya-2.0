import { defineHandler } from "@/lib/api/handler";
import { dependencyUnavailable, notFound, unauthenticated } from "@/lib/api/errors";
import { secretEquals } from "@/lib/crypto/token-cipher";
import { loadMetrics } from "@/lib/observability/metrics";
import type { MetricsReport } from "@/lib/observability/metrics";

// GET /api/internal/metrics - operator-only. docs/50-ops/52-monitoring-
// observability.md: "an internal endpoint /api/internal/metrics (service-
// token-guarded, not under /api/v1)"; a QStash schedule invokes it every
// minute. t2-3-brief.md is the exact gate contract this route implements:
//
//   "Bearer-guarded by a new optional env var (METRICS_TOKEN); when the var
//   is ABSENT the route returns 404, not 500 and not an open endpoint."
//
// -----------------------------------------------------------------------------
// WHY THIS ROUTE STILL USES defineHandler, EVEN THOUGH IT IS "NOT UNDER
// /api/v1" AND HAS NO SESSION
// -----------------------------------------------------------------------------
// src/app/api/jobs/ocr.process/route.ts documents three reasons a route
// should bypass defineHandler, and it is worth checking this one against all
// three rather than copying that precedent by reflex:
//
//   * "runs work before we would get control" - defineHandler's first act is
//     `supabase.auth.getUser()`. With no session cookie on this request (a
//     bearer-token service caller never sends one) and no custom
//     Authorization header reaching Supabase's OWN auth client, gotrue-js
//     short-circuits to `{ data: { user: null } }` locally, with no network
//     call at all - see `_getUser()` in @supabase/auth-js: it returns early
//     on `AuthSessionMissingError` before ever calling `_request`. So unlike
//     the QStash worker route (which is on the money-earning path and cannot
//     afford ANY unauthenticated round trip), there is no round trip to
//     avoid here in the first place.
//   * "the wrong contract... a NAMED REASON... must never reach this caller"
//     - true for QStash's signature verification, where four rejection
//     reasons would let a prober fingerprint our webhook config. A bearer
//     mismatch has exactly one honest shape (401 UNAUTHENTICATED) and
//     revealing that shape to an operator's monitoring config is not a
//     capability leak the way naming a signature-verification failure mode
//     would be.
//   * "session/rate-limit/idempotency machinery has nothing to apply to" -
//     also true here (no rateLimit/idempotent configured below), but
//     defineHandler's envelope, error registry and request-id correlation
//     are exactly what this route wants, and doc 13's rule ("handlers never
//     hand-roll envelopes") is a codebase-wide one, not an /api/v1-only one.
//
// So the bearer check runs in `authorize`, which is the one seam defineHandler
// offers before the handler body and the one place both the 404 and 401
// branches can throw a real ApiError.

export const dynamic = "force-dynamic";

/** "" and whitespace-only both read as unset, matching src/lib/env.ts's
 * emptyToUndefined and src/lib/supabase/service.ts's own direct-process.env
 * read. Read directly rather than through getServerEnv() - see that
 * function's own comment on METRICS_TOKEN in src/lib/env.ts for why: going
 * through getServerEnv() would let an unrelated missing required variable
 * (UPSTASH_REDIS_REST_URL, REDEMPTION_TOKEN_SECRET) take this probe down too,
 * and doc 52 has it invoked every minute. */
function readMetricsToken(): string | undefined {
  const raw = process.env.METRICS_TOKEN;
  return raw === undefined || raw.trim().length === 0 ? undefined : raw;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export const GET = defineHandler<MetricsReport>({
  route: "internal-metrics",
  authorize: ({ request }) => {
    const configuredToken = readMetricsToken();
    // "not configured" and "misconfigured" collapse to the same answer a
    // consumer-facing route gives an unmapped path: 404. The brief is
    // explicit that this must never present as an open endpoint (no token
    // configured => accept anything) or as a 500 (an operator's monitor
    // would page on a deployment that simply has not turned this on yet).
    if (configuredToken === undefined) {
      throw notFound();
    }

    const provided = readBearerToken(request);
    if (provided === null || !secretEquals(provided, configuredToken)) {
      throw unauthenticated("A valid operator bearer token is required.");
    }

    return undefined;
  },
  handler: async () => {
    const report = await loadMetrics();
    if (report === null) {
      // Never a partial or zeroed report - see loadMetrics()'s own contract.
      throw dependencyUnavailable("Metrics could not be read right now. Please retry shortly.");
    }

    return {
      data: report,
      headers: { "Cache-Control": "private, no-store" },
    };
  },
});
