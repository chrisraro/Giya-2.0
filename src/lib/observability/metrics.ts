import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database } from "@/lib/supabase/types";

// =============================================================================
// loadMetrics(): the read behind GET /api/internal/metrics.
// =============================================================================
//
// t2-3-brief.md: "public.sweep_job_health(p_hours integer) ALREADY EXISTS
// (migration 0028) ... Nothing in the app calls it. That is your primary
// metrics source and the reason this task is cheap." This module is that
// first caller, plus the `jobs` depth-by-status count the brief also asks
// for. No migration, no new SQL - everything here reads what 0028 and 0029
// already shipped.
//
// -----------------------------------------------------------------------------
// SERVICE ROLE, SAME FENCE AS EVERY SIBLING MODULE
// -----------------------------------------------------------------------------
// 0029's header is explicit: `jobs` has RLS enabled with ZERO policies and its
// privileges are revoked from anon/authenticated, so a service-role client is
// the only way to read it at all - and `sweep_job_health` (0028) is granted to
// service_role alone for the same reason. This module follows the exact deps
// shape src/features/receipts/server/routing-stats.ts and
// src/features/admin/queue.ts use: a `deps` parameter that defaults to a real
// service-role client, injectable in tests, null when the key is absent.
//
// FAILURE SHAPE. `loadMetrics()` itself returns `null` only when the
// service-role client is unavailable at all (no key configured) - the route
// maps that to 503. Below that top level, EVERY field degrades
// independently: a status count that fails to read, or the sweep_job_health
// RPC failing, reports `null` for exactly that field rather than discarding
// the rest of the report. This is deliberate and the opposite of "all or
// nothing" - see loadJobsByStatus()'s own comment for the incident this
// avoids: a table-scan timeout on `succeeded` (the one status with no
// retention sweep and no reason to be fast) must never take the `dead` count
// down with it, because the DLQ number is exactly what an operator needs
// when the platform is already under enough load for a count to time out.
//
// -----------------------------------------------------------------------------
// WHY THIS IS SAFE TO SHOW `last_error` VERBATIM (unlike src/lib/observability/
// health.ts, which shows nothing but an enum)
// -----------------------------------------------------------------------------
// 0029's header calls `jobs.last_error` "OPERATOR VOCABULARY, never
// consumer-facing" - it withholds it from every client role, not from every
// audience. This route is bearer-token gated and unreachable without
// METRICS_TOKEN (see src/app/api/internal/metrics/route.ts), so its one
// audience IS the operator the column was written for. Passing it through is
// what makes the DLQ view of the on-call runbook (docs/50-ops/52-monitoring-
// observability.md's queue-dead-letter runbook) possible at all.

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * `number` when the count read succeeded, `null` when it did not - NEVER
 * rendered as 0, matching every sibling module's "null means unreadable"
 * convention. See the module header on why this is per-status rather than
 * all-or-nothing.
 */
export type JobsDepthByStatus = Readonly<Record<JobStatus, number | null>>;

export interface SweepJobHealthRow {
  readonly jobname: string;
  readonly schedule: string;
  readonly active: boolean;
  readonly runs: number;
  readonly failures: number;
  readonly lastStatus: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastError: string | null;
}

export interface MetricsReport {
  readonly jobs: {
    readonly byStatus: JobsDepthByStatus;
    /** Mirrors `byStatus.dead` - `null` exactly when that one count failed. */
    readonly deadLetterCount: number | null;
  };
  /** `null` when the `sweep_job_health` RPC itself failed to read - the jobs
   * fields above are independent of this and still populate normally. */
  readonly sweepJobHealth: readonly SweepJobHealthRow[] | null;
}

/**
 * `sweep_job_health`'s own `p_hours default 24`. Named explicitly rather than
 * relying on the function's default so this module's contract does not
 * silently change if 0028's default ever does, and because doc 28's own
 * comment frames 24h as "the window" for run history rather than an arbitrary
 * choice.
 */
export const SWEEP_HEALTH_WINDOW_HOURS = 24;

export interface MetricsDeps {
  /** MUST be the service-role client. See the header. */
  readonly supabase: SupabaseClient<Database>;
}

/** Null when the service-role key is absent, matching every sibling module. */
export function defaultMetricsDeps(): MetricsDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) return null;
  return { supabase };
}

/**
 * `count: "exact"` runs a real `COUNT(*)` under the read's `WHERE`; `count:
 * "estimated"` uses Postgres's planner statistics instead (PostgREST: exact
 * for low numbers, `EXPLAIN`-derived for high ones) - fast regardless of
 * table size, at the cost of precision.
 *
 * `jobs` has NO retention sweep yet (0029's own comment says so), and this
 * probe runs on doc 52's per-minute schedule with a <500ms budget for the
 * WHOLE metrics probe. `jobs_queue_status_idx` is `(queue, status,
 * scheduled_at)` - leading column `queue`, not `status` - so a bare `WHERE
 * status = ...` with no queue predicate cannot range-scan it; only
 * `status='dead'` gets index help at all, from the dedicated partial index
 * `jobs_dead_idx (queue, finished_at desc) where status = 'dead'`. An exact
 * count without index support is still fine for `queued`/`running`/`failed`:
 * those three are the ones doc 39's own alerting keys on staying SMALL in a
 * healthy system (an hourly sweep clears `queued`/`running` quickly; `failed`
 * is "a job between attempts", not a resting state) - a sequential scan over
 * a small set is cheap regardless of missing index support, and precision
 * matters for exactly the numbers an alert fires on. `succeeded` is the one
 * status with NO reason to stay small (every job that ever finished cleanly,
 * forever) and no operational decision needs its EXACT count, so it is the
 * one counted `"estimated"`.
 */
const COUNT_MODE_BY_STATUS: Readonly<Record<JobStatus, "exact" | "estimated">> = {
  queued: "exact",
  running: "exact",
  succeeded: "estimated",
  failed: "exact",
  dead: "exact",
};

/**
 * One status's depth, via a HEAD count (`notifications/server/repo.ts`'s
 * `getMyUnreadNotificationCount` pattern): the count comes back in a response
 * header, no rows cross the wire.
 */
async function countJobsByStatus(deps: MetricsDeps, status: JobStatus): Promise<number | null> {
  const { count, error } = await deps.supabase
    .from("jobs")
    .select("id", { count: COUNT_MODE_BY_STATUS[status], head: true })
    .eq("status", status);

  if (error !== null) {
    console.error(`[observability/metrics] jobs count failed for status=${status}`, error);
    return null;
  }
  return count ?? 0;
}

/**
 * Every status's depth, each one independently `null` on its own failure.
 * NEVER discards a working count because a sibling status failed - see the
 * module header. `Promise.all` here is safe for that property because
 * `countJobsByStatus` never rejects; it already reduces its own failure to
 * `null` before this resolves.
 */
async function loadJobsByStatus(deps: MetricsDeps): Promise<JobsDepthByStatus> {
  const entries = await Promise.all(
    JOB_STATUSES.map(async (status) => [status, await countJobsByStatus(deps, status)] as const),
  );
  return Object.fromEntries(entries) as JobsDepthByStatus;
}

async function loadSweepJobHealth(deps: MetricsDeps): Promise<SweepJobHealthRow[] | null> {
  const { data, error } = await deps.supabase.rpc("sweep_job_health", {
    p_hours: SWEEP_HEALTH_WINDOW_HOURS,
  });

  if (error !== null) {
    console.error("[observability/metrics] sweep_job_health read failed", error);
    return null;
  }

  return (data ?? []).map((row) => ({
    jobname: row.jobname,
    schedule: row.schedule,
    active: row.active,
    runs: Number(row.runs),
    failures: Number(row.failures),
    lastStatus: row.last_status,
    lastFinishedAt: row.last_finished_at,
    lastError: row.last_error,
  }));
}

/**
 * The whole `/api/internal/metrics` payload, or `null` only when it could
 * not be attempted at all (no service-role key configured). The route maps
 * THAT `null` to 503 DEPENDENCY_UNAVAILABLE. Below this level nothing is
 * all-or-nothing: `jobs.byStatus` reports per-status, and `sweepJobHealth`
 * reports its own success independently of the jobs counts - see the module
 * header.
 */
export async function loadMetrics(
  deps: MetricsDeps | null = defaultMetricsDeps(),
): Promise<MetricsReport | null> {
  if (deps === null) return null;

  const [byStatus, sweepJobHealth] = await Promise.all([
    loadJobsByStatus(deps),
    loadSweepJobHealth(deps),
  ]);

  return {
    jobs: { byStatus, deadLetterCount: byStatus.dead },
    sweepJobHealth,
  };
}
