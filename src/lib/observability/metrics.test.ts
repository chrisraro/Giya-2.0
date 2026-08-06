// @vitest-environment node
//
// loadMetrics(): the read behind GET /api/internal/metrics.
//
// Same three stubs every service-role suite in this codebase uses (see
// src/features/receipts/server/routing-stats.test.ts): the module is
// `server-only`, its default deps mint a real service-role client, and every
// test here injects its own fake instead.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { JOB_STATUSES, SWEEP_HEALTH_WINDOW_HOURS, loadMetrics } from "./metrics";
import type { MetricsDeps } from "./metrics";

interface CountOp {
  table: "jobs";
  status: string;
  countMode: string | undefined;
  head: boolean | undefined;
}

interface RpcOp {
  name: string;
  args: Record<string, unknown>;
}

interface FakeResponses {
  /** status -> count (or an error when that status is listed in countErrorStatuses) */
  counts?: Partial<Record<string, number>>;
  countErrorStatuses?: string[];
  sweepRows?: Array<{
    jobname: string;
    schedule: string;
    active: boolean;
    runs: number;
    failures: number;
    last_status: string | null;
    last_finished_at: string | null;
    last_error: string | null;
  }>;
  sweepError?: { message: string } | null;
}

function createDeps(responses: FakeResponses): {
  deps: MetricsDeps;
  countOps: CountOp[];
  rpcOps: RpcOp[];
} {
  const countOps: CountOp[] = [];
  const rpcOps: RpcOp[] = [];

  const supabase = {
    from: (table: string) => ({
      select: (_columns: string, options?: { count?: string; head?: boolean }) => ({
        eq: (_column: string, status: string) => {
          countOps.push({
            table: table as "jobs",
            status,
            countMode: options?.count,
            head: options?.head,
          });
          if (responses.countErrorStatuses?.includes(status)) {
            return Promise.resolve({ count: null, error: { message: "boom" } });
          }
          return Promise.resolve({ count: responses.counts?.[status] ?? 0, error: null });
        },
      }),
    }),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcOps.push({ name, args });
      return Promise.resolve({
        data: responses.sweepRows ?? [],
        error: responses.sweepError ?? null,
      });
    },
  } as unknown as SupabaseClient<Database>;

  return { deps: { supabase }, countOps, rpcOps };
}

describe("loadMetrics", () => {
  it("returns null when the service-role client is unavailable (no crash, no silent empty report)", async () => {
    const result = await loadMetrics(null);
    expect(result).toBeNull();
  });

  it("counts jobs by every one of doc 39's five statuses, as a HEAD count", async () => {
    const { deps, countOps } = createDeps({
      counts: { queued: 3, running: 1, succeeded: 100, failed: 2, dead: 0 },
    });

    const result = await loadMetrics(deps);

    expect(result?.jobs.byStatus).toEqual({
      queued: 3,
      running: 1,
      succeeded: 100,
      failed: 2,
      dead: 0,
    });
    expect(countOps.map((op) => op.status).sort()).toEqual([...JOB_STATUSES].sort());
    expect(countOps.every((op) => op.head === true)).toBe(true);
  });

  // I5: `jobs` has no retention sweep, so an EXACT count over the one status
  // with no reason to stay small (`succeeded` - every job that ever finished
  // cleanly, forever) is a full-table-scan cost that grows without bound.
  // The other four are expected to stay small in a healthy system (that is
  // what makes them worth alerting on precisely), so they stay exact.
  it("counts the ever-growing succeeded bucket as estimated, and the small/actionable ones exact", async () => {
    const { deps, countOps } = createDeps({});

    await loadMetrics(deps);

    const modeByStatus = Object.fromEntries(countOps.map((op) => [op.status, op.countMode]));
    expect(modeByStatus.succeeded).toBe("estimated");
    expect(modeByStatus.queued).toBe("exact");
    expect(modeByStatus.running).toBe("exact");
    expect(modeByStatus.failed).toBe("exact");
    expect(modeByStatus.dead).toBe("exact");
  });

  it("reports the dead-letter count as the same number as the dead status tally", async () => {
    const { deps } = createDeps({ counts: { dead: 7 } });

    const result = await loadMetrics(deps);

    expect(result?.jobs.deadLetterCount).toBe(7);
    expect(result?.jobs.deadLetterCount).toBe(result?.jobs.byStatus.dead);
  });

  // I5: the old behaviour discarded the ENTIRE jobs report - including a
  // successfully-read `dead` count - the moment any ONE status failed. That
  // is backwards: a failure under load (the likeliest time for a count to
  // time out) must not also delete the one number (dead-letter depth) an
  // operator needs most at exactly that moment.
  it("reports a failed status count as null WITHOUT discarding the other, successfully-read counts", async () => {
    const { deps } = createDeps({
      counts: { queued: 3, running: 1, failed: 2, dead: 9 },
      countErrorStatuses: ["succeeded"],
    });

    const result = await loadMetrics(deps);

    expect(result).not.toBeNull();
    expect(result?.jobs.byStatus).toEqual({
      queued: 3,
      running: 1,
      succeeded: null,
      failed: 2,
      dead: 9,
    });
    // The DLQ number survives the unrelated failure - the whole point.
    expect(result?.jobs.deadLetterCount).toBe(9);
  });

  it("reports the dead-letter count as null when specifically the dead count fails, without touching the others", async () => {
    const { deps } = createDeps({
      counts: { queued: 3, running: 1, succeeded: 100, failed: 2 },
      countErrorStatuses: ["dead"],
    });

    const result = await loadMetrics(deps);

    expect(result?.jobs.byStatus.dead).toBeNull();
    expect(result?.jobs.deadLetterCount).toBeNull();
    expect(result?.jobs.byStatus.queued).toBe(3);
    expect(result?.jobs.byStatus.succeeded).toBe(100);
  });

  it("calls sweep_job_health with the documented window", async () => {
    const { deps, rpcOps } = createDeps({});

    await loadMetrics(deps);

    expect(rpcOps).toHaveLength(1);
    expect(rpcOps[0]?.name).toBe("sweep_job_health");
    expect(rpcOps[0]?.args.p_hours).toBe(SWEEP_HEALTH_WINDOW_HOURS);
    expect(SWEEP_HEALTH_WINDOW_HOURS).toBe(24);
  });

  it("passes the sweep_job_health rows through: per-job last run, last status, failure count in window", async () => {
    const { deps } = createDeps({
      sweepRows: [
        {
          jobname: "claims-expiry-sweep",
          schedule: "7 * * * *",
          active: true,
          runs: 24,
          failures: 2,
          last_status: "succeeded",
          last_finished_at: "2026-08-06T03:07:01.000Z",
          last_error: null,
        },
        {
          jobname: "stuck-receipts-sweep",
          schedule: "50 * * * *",
          active: true,
          runs: 24,
          failures: 24,
          last_status: "failed",
          last_finished_at: "2026-08-06T02:50:05.000Z",
          last_error: "connection to server was lost",
        },
      ],
    });

    const result = await loadMetrics(deps);

    expect(result?.sweepJobHealth).toEqual([
      {
        jobname: "claims-expiry-sweep",
        schedule: "7 * * * *",
        active: true,
        runs: 24,
        failures: 2,
        lastStatus: "succeeded",
        lastFinishedAt: "2026-08-06T03:07:01.000Z",
        lastError: null,
      },
      {
        jobname: "stuck-receipts-sweep",
        schedule: "50 * * * *",
        active: true,
        runs: 24,
        failures: 24,
        lastStatus: "failed",
        lastFinishedAt: "2026-08-06T02:50:05.000Z",
        lastError: "connection to server was lost",
      },
    ]);
  });

  // I5: a sweep_job_health failure and a jobs-count failure are independent
  // data sources hitting independent tables/functions; one failing must not
  // blank out the other.
  it("reports sweepJobHealth as null when its RPC fails, WITHOUT discarding the jobs counts", async () => {
    const { deps } = createDeps({
      counts: { queued: 3, running: 1, succeeded: 100, failed: 2, dead: 1 },
      sweepError: { message: "function does not exist" },
    });

    const result = await loadMetrics(deps);

    expect(result).not.toBeNull();
    expect(result?.sweepJobHealth).toBeNull();
    expect(result?.jobs.byStatus).toEqual({
      queued: 3,
      running: 1,
      succeeded: 100,
      failed: 2,
      dead: 1,
    });
  });
});
