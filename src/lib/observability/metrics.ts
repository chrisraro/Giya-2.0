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
// FAILURE SHAPE, inherited from those same modules: `null` means "could not be
// read" and is never rendered as zero or as an empty report. An empty `jobs`
// table and an unreadable one must never look the same to an operator staring
// at a dashboard during an incident.
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

export type JobsDepthByStatus = Readonly<Record<JobStatus, number>>;

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
    readonly deadLetterCount: number;
  };
  readonly sweepJobHealth: readonly SweepJobHealthRow[];
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
 * One status's depth, via a HEAD count (`notifications/server/repo.ts`'s
 * `getMyUnreadNotificationCount` pattern): the count comes back in a response
 * header, no rows cross the wire, and it runs against `jobs_dead_idx` for
 * `status='dead'` (0029) and `jobs_queue_status_idx` for the rest.
 */
async function countJobsByStatus(deps: MetricsDeps, status: JobStatus): Promise<number | null> {
  const { count, error } = await deps.supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", status);

  if (error !== null) {
    console.error(`[observability/metrics] jobs count failed for status=${status}`, error);
    return null;
  }
  return count ?? 0;
}

async function loadJobsByStatus(deps: MetricsDeps): Promise<JobsDepthByStatus | null> {
  const counts = await Promise.all(JOB_STATUSES.map((status) => countJobsByStatus(deps, status)));
  // Any single failed count makes the WHOLE depth report unreadable - a depth
  // report with one status silently missing is a worse lie than no report,
  // because "queued: 3" next to a blank "dead" reads as "no dead jobs".
  if (counts.some((value) => value === null)) return null;

  const byStatus = {} as Record<JobStatus, number>;
  JOB_STATUSES.forEach((status, index) => {
    byStatus[status] = counts[index] as number;
  });
  return byStatus;
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
 * The whole `/api/internal/metrics` payload, or `null` when it could not be
 * read (no service-role key, or either underlying read failed). The route
 * maps `null` to 503 DEPENDENCY_UNAVAILABLE rather than rendering a partial
 * or zeroed report.
 */
export async function loadMetrics(
  deps: MetricsDeps | null = defaultMetricsDeps(),
): Promise<MetricsReport | null> {
  if (deps === null) return null;

  const [byStatus, sweepJobHealth] = await Promise.all([
    loadJobsByStatus(deps),
    loadSweepJobHealth(deps),
  ]);

  if (byStatus === null || sweepJobHealth === null) return null;

  return {
    jobs: { byStatus, deadLetterCount: byStatus.dead },
    sweepJobHealth,
  };
}
