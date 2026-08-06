import { ApiError, API_ERROR_CODES } from "@/lib/api/errors";
import { defineHandler } from "@/lib/api/handler";
import { checkJobHealth } from "@/lib/alerts/job-health";
import type { JobHealthReport } from "@/lib/alerts/job-health";
import { secretEquals } from "@/lib/crypto/token-cipher";

// =============================================================================
// POST /api/jobs/ops.job_health_check - task 2.5's "a scheduled check", the
// piece a first cut of this task shipped without: checkJobHealth()
// (src/lib/alerts/job-health.ts) existed, was fully tested, and had ZERO
// callers anywhere in the app. Detection nobody invokes is not detection.
// =============================================================================
//
// -----------------------------------------------------------------------------
// WHY THIS LIVES UNDER src/app/api/jobs/, NOT src/app/api/internal/
// -----------------------------------------------------------------------------
// The task brief fences `src/app/api/internal/**` (task 2.3/2.8 own it, and
// extending it risks a merge conflict with work already landed there). This
// route is a sibling of `src/app/api/jobs/notify.email` and `.../ocr.process`
// in LOCATION only, not in shape: those two are QStash-signed WORKER routes
// that consume the `jobs` queue table via `src/lib/queue/claim.ts` (fenced
// off from this task by the same brief), and this route is neither. It takes
// no queue payload, claims no job row, and verifies no QStash signature -
// there is nothing to dequeue, because checkJobHealth() calls
// `sweep_job_health()` directly. What it copies is `/api/internal/metrics`'s
// SHAPE: a bearer-token-guarded operator diagnostic/action endpoint, 404 when
// the deployment has not turned it on, 401 on a bad bearer, rate-limited
// against bearer guessing.
//
// POST rather than GET, unlike metrics: this route has side effects (it may
// send an email and it always writes `job_alert_state`), and doc 13's own
// convention reserves GET for reads.
//
// -----------------------------------------------------------------------------
// WHY THE BEARER IS METRICS_TOKEN, NOT A NEW CREDENTIAL
// -----------------------------------------------------------------------------
// Both routes are the same trust boundary: "the operator who can trigger one
// internal diagnostic/action probe can trigger the other." Minting a second
// secret (JOB_HEALTH_CHECK_TOKEN or similar) would mean a second env.ts
// declaration, a second checklist row, and a second value for whoever wires
// the external scheduler to remember - for no security property this task
// needs. If that trust boundary ever needs to split, splitting the token is
// a one-line change here, not a schema migration.
//
// -----------------------------------------------------------------------------
// WHAT INVOKES THIS IN PRODUCTION
// -----------------------------------------------------------------------------
// Nothing in this repository does, and nothing should: doc 52 describes the
// metrics probe's own QStash schedule as external configuration (an Upstash
// dashboard/API call, not a code artifact - this codebase has no
// programmatic QStash-schedule management anywhere, confirmed by grep before
// writing this comment), and the same is true here. Wiring the actual
// recurring trigger is a one-command ops action once QStash credentials
// exist (`docs/50-ops/53-env-credentials-checklist.md`); this route is what
// that schedule calls.

export const dynamic = "force-dynamic";

/** Never cached - an operator action endpoint, not a public asset. */
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

/** Same floor as METRICS_TOKEN's own reader (src/app/api/internal/metrics/
 * route.ts) - a shared trust boundary reuses the shared strength rule too. */
const MIN_TOKEN_LENGTH = 16;

/** Reads `process.env.METRICS_TOKEN` directly, exactly like
 * src/app/api/internal/metrics/route.ts's own `readMetricsToken` and for
 * the identical reason stated there: going through getServerEnv() would let
 * an unrelated required variable's absence take this route down too. Not
 * imported from that file because it exports nothing - each route re-reads
 * the token locally by design (see that file's own comment on
 * METRICS_TOKEN in src/lib/env.ts). */
function readOpsToken(): string | undefined {
  const raw = process.env.METRICS_TOKEN;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length >= MIN_TOKEN_LENGTH ? trimmed : undefined;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Bounds brute-force guessing against the bearer token, same numbers as
 * the metrics probe: generous for one legitimate scheduled invocation,
 * tight against a guessing script. */
const RATE_LIMIT = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export const POST = defineHandler<
  JobHealthReport,
  undefined,
  Record<string, string>,
  Record<string, string>,
  false,
  string
>({
  route: "jobs-ops-job-health-check",
  rateLimit: {
    limit: RATE_LIMIT,
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    keyBy: "ip",
  },
  authorize: () => {
    const configuredToken = readOpsToken();
    // "not configured" and "too weak to trust" both collapse to 404, never
    // an open endpoint and never a 500 that would page an operator's
    // monitor over a deployment that simply has not turned this on yet -
    // same contract as /api/internal/metrics.
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
      console.warn(
        "[api/jobs/ops.job_health_check] rejected a request with a missing or invalid bearer token",
      );
      throw new ApiError(
        401,
        API_ERROR_CODES.UNAUTHENTICATED,
        "A valid operator bearer token is required.",
        undefined,
        NO_STORE_HEADERS,
      );
    }

    const report = await checkJobHealth();
    if (report === null) {
      // Only when the service-role client itself is unavailable - see
      // checkJobHealth()'s own contract. Every other failure mode (an RPC
      // erroring, an unexpected throw) degrades to a 200 with an empty
      // report rather than reaching here, by design (M4).
      throw new ApiError(
        503,
        API_ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        "The job health check could not run right now. Please retry shortly.",
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
