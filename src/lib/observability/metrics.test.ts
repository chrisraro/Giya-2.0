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
}

interface RpcOp {
  name: string;
  args: Record<string, unknown>;
}

interface FakeResponses {
  /** status -> count (or an error when omitted from this map and errorStatuses includes it) */
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
      select: () => ({
        eq: (_column: string, status: string) => {
          countOps.push({ table: table as "jobs", status });
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

  it("counts jobs by every one of doc 39's five statuses", async () => {
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
  });

  it("reports the dead-letter count as the same number as the dead status tally", async () => {
    const { deps } = createDeps({ counts: { dead: 7 } });

    const result = await loadMetrics(deps);

    expect(result?.jobs.deadLetterCount).toBe(7);
    expect(result?.jobs.deadLetterCount).toBe(result?.jobs.byStatus.dead);
  });

  it("returns null, not a partial report, when any status count fails to read", async () => {
    const { deps } = createDeps({ countErrorStatuses: ["dead"] });

    const result = await loadMetrics(deps);

    expect(result).toBeNull();
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

  it("returns null when the sweep_job_health read fails", async () => {
    const { deps } = createDeps({ sweepError: { message: "function does not exist" } });

    const result = await loadMetrics(deps);

    expect(result).toBeNull();
  });
});
