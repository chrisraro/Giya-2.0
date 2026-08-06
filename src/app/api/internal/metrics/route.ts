import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import { defineHandler } from "@/lib/api/handler";
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
//     NOT true here (see the rate-limit section below), and defineHandler's
//     envelope, error registry and request-id correlation are exactly what
//     this route wants regardless - doc 13's rule ("handlers never hand-roll
//     envelopes") is codebase-wide, not an /api/v1-only one.
//
// -----------------------------------------------------------------------------
// WHERE THE BEARER CHECK RUNS, AND WHY IT IS SPLIT ACROSS TWO PIPELINE STEPS
// -----------------------------------------------------------------------------
// Doc 13's pipeline order (src/lib/api/handler.ts) is authorize (step 4)
// BEFORE rate limit (step 5). Splitting the check this way is deliberate,
// not incidental:
//
//   * "is METRICS_TOKEN configured at all" runs in `authorize`. It answers
//     the same way for every caller regardless of what they sent - there is
//     nothing to brute-force or rate-limit about it, and it is the doc-13
//     shaped question `authorize` exists for ("can this caller reach this
//     resource at all").
//   * "does the PROVIDED bearer match it" runs in the `handler`, AFTER rate
//     limiting has already applied. Putting it in `authorize` instead (as an
//     earlier version of this route did) would mean every failed-bearer
//     attempt throws before the rate limiter ever runs, making the limiter
//     decorative against exactly the traffic it exists to bound - unlimited
//     bearer guessing. `authorize`'s return value (the configured token,
//     `TAuthContext`) is what lets the handler compare without a second env
//     read.
//
// The metrics payload this gates includes `last_error` - raw Postgres error
// text pulled straight from `cron.job_run_details` (see
// src/lib/observability/metrics.ts) - which is exactly why unlimited guessing
// against this token is worth bounding rather than dismissing as
// "impractical against a random 16+ character value".

export const dynamic = "force-dynamic";

/** Never cached - this is an operator diagnostic feed, not a public asset,
 * and applies to every response this route sends: the 404 (not configured),
 * the 401 (bad bearer), the 503 (metrics unavailable) and the 200. */
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

/**
 * Below this, a configured token is too weak to trust and is treated as
 * ABSENT (404, "not turned on") rather than as a working, guessable
 * credential. This is the length floor that would otherwise live in
 * src/lib/env.ts's schema, and does not: a schema-level `.min()` on
 * METRICS_TOKEN would make `getServerEnv()` throw for a truncated or
 * typo'd value, and `getServerEnv()` is called by unrelated code
 * (src/lib/redis.ts, src/lib/queue/publish.ts,
 * src/features/rewards/server/token.ts) that has nothing to do with
 * metrics - see that field's comment in src/lib/env.ts for the incident this
 * avoids. Mirrors src/lib/supabase/service.ts's own local length re-check on
 * SUPABASE_SERVICE_ROLE_KEY, applied here instead of there.
 */
const MIN_METRICS_TOKEN_LENGTH = 16;

/** "" and whitespace-only both read as unset, matching src/lib/env.ts's
 * emptyToUndefined and src/lib/supabase/service.ts's own direct-process.env
 * read. Read directly rather than through getServerEnv() - see that
 * function's own comment on METRICS_TOKEN in src/lib/env.ts for why: going
 * through getServerEnv() would let an unrelated missing required variable
 * (UPSTASH_REDIS_REST_URL, REDEMPTION_TOKEN_SECRET) take this probe down too,
 * and doc 52 has it invoked every minute. */
function readMetricsToken(): string | undefined {
  const raw = process.env.METRICS_TOKEN;
  if (raw === undefined) return undefined;
  return raw.trim().length >= MIN_METRICS_TOKEN_LENGTH ? raw : undefined;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Bounds brute-force guessing against the bearer token (see the pipeline
 * section above). Scoped by IP, matching doc 13's fallback for a caller with
 * no session - this route never has one. 20/minute is generous for the
 * legitimate caller (one QStash schedule invocation a minute, doc 52) and
 * tight against a guessing script.
 */
const METRICS_RATE_LIMIT = 20;
const METRICS_RATE_LIMIT_WINDOW_SECONDS = 60;

export const GET = defineHandler<
  MetricsReport,
  undefined,
  Record<string, string>,
  Record<string, string>,
  false,
  string
>({
  route: "internal-metrics",
  rateLimit: {
    limit: METRICS_RATE_LIMIT,
    windowSeconds: METRICS_RATE_LIMIT_WINDOW_SECONDS,
    keyBy: "ip",
  },
  authorize: () => {
    const configuredToken = readMetricsToken();
    // "not configured" and "too weak to trust" both collapse to the same
    // answer a consumer-facing route gives an unmapped path: 404. The brief
    // is explicit that this must never present as an open endpoint (no
    // token configured => accept anything) or as a 500 (an operator's
    // monitor would page on a deployment that simply has not turned this on
    // yet).
    if (configuredToken === undefined) {
      throw new ApiError(
        404,
        API_ERROR_CODES.NOT_FOUND,
        "This resource was not found.",
        undefined,
        NO_STORE_HEADERS,
      );
    }

    return configuredToken;
  },
  handler: async ({ request, auth: configuredToken }) => {
    const provided = readBearerToken(request);
    if (provided === null || !secretEquals(provided, configuredToken)) {
      // No token value on either side of this line, provided or configured
      // - only the fact that a mismatch happened. See verify.ts's rule 4 for
      // why the REASON stays out of the response; this is the same
      // discipline applied to what reaches the server log.
      console.warn("[api/internal-metrics] rejected a request with a missing or invalid bearer token");
      throw new ApiError(
        401,
        API_ERROR_CODES.UNAUTHENTICATED,
        "A valid operator bearer token is required.",
        undefined,
        NO_STORE_HEADERS,
      );
    }

    const report = await loadMetrics();
    if (report === null) {
      // Only when the service-role client itself is unavailable - see
      // loadMetrics()'s own contract. A partial read (one jobs status count
      // failing, or the sweep_job_health RPC failing) still returns 200 with
      // the fields that DID read populated and the rest `null`, rather than
      // discarding everything down to this 503.
      throw new ApiError(
        503,
        API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        "Metrics could not be read right now. Please retry shortly.",
        undefined,
        NO_STORE_HEADERS,
      );
    }

    return {
      data: report,
      headers: NO_STORE_HEADERS,
    };
  },
});
