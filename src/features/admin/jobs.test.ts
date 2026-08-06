// @vitest-environment node
//
// `/admin/monitoring/queues`: the read (`loadQueueStatus`) and doc 39's
// replay procedure (`replayJob`), plus the QStash side-effect
// (`republishDeadJob`) replay best-effort triggers.
//
// THE CENTRAL PROPERTY UNDER TEST, stated once because every guard below
// serves it: a dead job that `replayJob` touches must come out the other
// side genuinely claimable by the REAL `claimJob` (`src/lib/queue/claim.ts`)
// - not merely "the code looks like it resets the right columns". The last
// describe block below proves this by running the actual `claimJob` against
// the same in-memory row `replayJob` wrote to, rather than asserting on the
// patch object and trusting it satisfies `claimJob`'s predicate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

const ENV = vi.hoisted(() => ({
  current: {
    QSTASH_URL: "https://qstash-us-east-1.upstash.io",
    QSTASH_TOKEN: "token-for-tests",
    QSTASH_CALLBACK_ORIGIN: "https://giya.example",
  } as Record<string, string | undefined>,
}));

vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => ENV.current,
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { claimJob } from "@/lib/queue/claim";
import type { Database } from "@/lib/supabase/types";

import { loadQueueStatus, replayJob, republishDeadJob } from "./jobs";
import type { AdminJobsDeps } from "./jobs";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const REASON = "fixed the upstream 500s; safe to retry now";

// ---------------------------------------------------------------------------
// A fake `jobs` row store with REAL predicate matching (same idea as
// `src/lib/queue/claim.test.ts`'s `makeFakeJobsTable`), plus canned tables
// for `platform_admins` and `audit_logs` (same idea as `consequences.test.ts`'s
// `FakeQuery`). Both are reused rather than reinvented because the properties
// they prove - real CAS matching, and "reads/writes recorded for assertion" -
// are exactly what this suite also needs.
// ---------------------------------------------------------------------------

interface JobFixture {
  id: string;
  queue: string;
  status: string;
  payload: unknown;
  business_id: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  finished_at: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  scheduled_at: string;
  qstash_message_id: string | null;
  created_at: string;
}

function job(overrides: Partial<JobFixture> = {}): JobFixture {
  return {
    id: JOB_ID,
    queue: "notify.email",
    status: "dead",
    payload: { notification_ids: ["n1"] },
    business_id: "biz-1",
    attempts: 5,
    max_attempts: 5,
    last_error: "resend 503 x5",
    finished_at: "2026-07-26T10:00:00.000Z",
    started_at: "2026-07-26T09:59:00.000Z",
    heartbeat_at: null,
    scheduled_at: "2026-07-26T09:00:00.000Z",
    qstash_message_id: "msg-old",
    created_at: "2026-07-26T08:00:00.000Z",
    ...overrides,
  };
}

interface WorldOptions {
  jobs?: JobFixture[];
  adminRole?: string | null;
  adminReadError?: { message: string } | null;
  jobReadError?: { message: string } | null;
  jobWriteError?: { message: string } | null;
  auditError?: { message: string } | null;
  /** Simulates another writer changing the row between the read and the CAS. */
  raceOnUpdate?: (row: JobFixture) => void;
  deadListError?: { message: string } | null;
  countError?: boolean;
  sweepRows?: unknown[];
  sweepError?: { message: string } | null;
}

interface Op {
  table: string;
  kind: "select" | "update" | "insert" | "rpc";
  filters: Array<{ column: string; value: unknown; method: "eq" | "in" }>;
  patch?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

function createWorld(options: WorldOptions = {}) {
  const store = new Map<string, JobFixture>((options.jobs ?? [job()]).map((row) => [row.id, row]));
  const ops: Op[] = [];
  const auditInserts: Array<Record<string, unknown>> = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];

  function matches(row: JobFixture, filters: Op["filters"]): boolean {
    return filters.every(({ column, value, method }) => {
      const actual = (row as unknown as Record<string, unknown>)[column];
      return method === "eq" ? actual === value : (value as unknown[]).includes(actual);
    });
  }

  const client = {
    from(table: string) {
      if (table === "jobs") {
        return {
          select(_columns: string, selectOpts?: { count?: string; head?: boolean }) {
            const filters: Op["filters"] = [];
            const isCount = selectOpts?.head === true;
            let single = false;
            let limitN: number | undefined;

            const chain = {
              eq(column: string, value: unknown) {
                filters.push({ column, value, method: "eq" as const });
                return chain;
              },
              in(column: string, value: unknown[]) {
                filters.push({ column, value, method: "in" as const });
                return chain;
              },
              order() {
                return chain;
              },
              limit(n: number) {
                limitN = n;
                return chain;
              },
              maybeSingle() {
                single = true;
                return resolve();
              },
              then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
                return resolve().then(onFulfilled, onRejected);
              },
            };

            function resolve() {
              ops.push({ table, kind: "select", filters: [...filters] });
              if (isCount) {
                if (options.countError === true) {
                  return Promise.resolve({ count: null, error: { message: "count failed" } });
                }
                const rows = [...store.values()].filter((row) => matches(row, filters));
                return Promise.resolve({ count: rows.length, error: null });
              }
              if (options.jobReadError && !single) {
                // deadList read
                return Promise.resolve({ data: null, error: options.jobReadError });
              }
              if (single && options.jobReadError) {
                return Promise.resolve({ data: null, error: options.jobReadError });
              }
              if (options.deadListError && !single) {
                return Promise.resolve({ data: null, error: options.deadListError });
              }
              let rows = [...store.values()].filter((row) => matches(row, filters));
              if (limitN !== undefined) rows = rows.slice(0, limitN);
              // Snapshots, not live references: a caller holding onto a read
              // result must not see it mutate out from under it when a later
              // write lands on the same store row (the revert test below
              // depends on this - it captures "before" from this read).
              const snapshot = rows.map((row) => ({ ...row }));
              if (single) {
                return Promise.resolve({ data: snapshot[0] ?? null, error: null });
              }
              return Promise.resolve({ data: snapshot, error: null });
            }

            return chain;
          },
          update(patch: Record<string, unknown>) {
            const filters: Op["filters"] = [];
            let single = false;
            const chain = {
              eq(column: string, value: unknown) {
                filters.push({ column, value, method: "eq" as const });
                return chain;
              },
              in(column: string, value: unknown[]) {
                filters.push({ column, value, method: "in" as const });
                return chain;
              },
              select() {
                return chain;
              },
              maybeSingle() {
                single = true;
                return resolve();
              },
              then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
                return resolve().then(onFulfilled, onRejected);
              },
            };

            function resolve() {
              // The race hook fires exactly here: after the caller decided
              // WHAT to write (based on its earlier read) but before this
              // write's own predicate is evaluated - the real interleaving
              // window a concurrent writer would land in.
              if (options.raceOnUpdate !== undefined) {
                const target = store.get((filters.find((f) => f.column === "id")?.value as string) ?? "");
                if (target !== undefined) options.raceOnUpdate(target);
              }

              const matchesRows = [...store.values()].filter((row) => matches(row, filters));
              ops.push({ table, kind: "update", filters: [...filters], patch: { ...patch } });

              if (options.jobWriteError !== undefined && options.jobWriteError !== null) {
                return Promise.resolve({ data: null, error: options.jobWriteError });
              }
              if (matchesRows.length === 0) {
                return Promise.resolve({ data: null, error: null });
              }
              for (const row of matchesRows) Object.assign(row, patch);
              if (single) return Promise.resolve({ data: { id: matchesRows[0]?.id }, error: null });
              return Promise.resolve({ error: null });
            }

            return chain;
          },
        };
      }

      if (table === "platform_admins") {
        return {
          select() {
            const filters: Op["filters"] = [];
            const chain = {
              eq(column: string, value: unknown) {
                filters.push({ column, value, method: "eq" as const });
                return chain;
              },
              maybeSingle() {
                ops.push({ table, kind: "select", filters: [...filters] });
                if (options.adminReadError !== undefined && options.adminReadError !== null) {
                  return Promise.resolve({ data: null, error: options.adminReadError });
                }
                const role = options.adminRole === undefined ? "admin" : options.adminRole;
                if (role === null) return Promise.resolve({ data: null, error: null });
                return Promise.resolve({ data: { role, is_active: true }, error: null });
              },
            };
            return chain;
          },
        };
      }

      if (table === "audit_logs") {
        return {
          insert(values: Record<string, unknown>) {
            ops.push({ table, kind: "insert", filters: [], values });
            auditInserts.push(values);
            return Promise.resolve({
              error: options.auditError === undefined ? null : options.auditError,
            });
          },
        };
      }

      throw new Error(`unexpected table in test double: ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      if (options.sweepError !== undefined && options.sweepError !== null) {
        return Promise.resolve({ data: null, error: options.sweepError });
      }
      return Promise.resolve({ data: options.sweepRows ?? [], error: null });
    },
  };

  const republish = vi.fn(async () => true);

  const deps: AdminJobsDeps = {
    supabase: client as unknown as SupabaseClient<Database>,
    now: () => NOW,
    republish,
  };

  return {
    deps,
    store,
    ops,
    rpcs,
    auditInserts,
    republish,
    updatesTo: (table: string) => ops.filter((op) => op.table === table && op.kind === "update"),
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  ENV.current = {
    QSTASH_URL: "https://qstash-us-east-1.upstash.io",
    QSTASH_TOKEN: "token-for-tests",
    QSTASH_CALLBACK_ORIGIN: "https://giya.example",
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// loadQueueStatus / loadDeadJobs
// ===========================================================================

describe("loadQueueStatus", () => {
  it("reports every slice as unavailable when there is no service-role client", async () => {
    const result = await loadQueueStatus(null);
    expect(result).toEqual({ byStatus: null, sweepHealth: null, deadJobs: null });
  });

  // Mutant: report `deadJobs: []` instead of the read's own empty result, or
  // conflate "empty" with "unavailable" the way `getMyBalances` and the
  // metrics loader did before (the brief names both incidents). Distinct
  // fixtures for "nothing dead" and "could not read" prove the two cannot
  // collapse into the same value.
  it("distinguishes a genuinely dead-empty queue from a failed dead-letter read", async () => {
    const empty = createWorld({ jobs: [] });
    const emptyResult = await loadQueueStatus(empty.deps);
    expect(emptyResult.deadJobs).toEqual([]);

    const broken = createWorld({ jobs: [], deadListError: { message: "connection reset" } });
    const brokenResult = await loadQueueStatus(broken.deps);
    expect(brokenResult.deadJobs).toBeNull();
  });

  // Mutant: drop the `.eq("status", "dead")` filter on the dead-letter read.
  // A succeeded/queued row would then leak into the DLQ view, which is
  // exactly the false alarm (or false all-clear, in reverse) this list must
  // never produce.
  it("lists only status='dead' rows, not every job", async () => {
    const world = createWorld({
      jobs: [job({ id: "dead-1", status: "dead" }), job({ id: "alive-1", status: "queued" })],
    });
    const result = await loadQueueStatus(world.deps);
    expect(result.deadJobs).not.toBeNull();
    expect(result.deadJobs?.map((row) => row.jobId)).toEqual(["dead-1"]);
  });

  // Mutant: pass through the raw payload, or drop `describePayloadIdentity`
  // entirely. The dead-letter row must carry a rendered identity, not the
  // job_id-polluted raw payload object.
  it("renders each dead row's payload through describePayloadIdentity", async () => {
    const world = createWorld({
      jobs: [job({ id: "dead-1", status: "dead", payload: { receipt_id: "receipt-9", job_id: "dead-1" } })],
    });
    const result = await loadQueueStatus(world.deps);
    expect(result.deadJobs?.[0]?.payloadIdentity).toBe("receipt_id=receipt-9");
  });

  // Mutant: forget to compose `loadMetrics`'s byStatus/sweepHealth into the
  // returned view (e.g. hardcode nulls). Proves the counts genuinely come
  // from the composed read, not a stub.
  it("composes jobs-by-status counts and sweep health from loadMetrics", async () => {
    const world = createWorld({
      jobs: [job({ id: "dead-1", status: "dead" }), job({ id: "queued-1", status: "queued" })],
      sweepRows: [
        {
          jobname: "campaigns-sweep",
          schedule: "*/5 * * * *",
          active: true,
          runs: 10,
          failures: 0,
          last_status: "succeeded",
          last_finished_at: "2026-07-26T11:55:00.000Z",
          last_error: null,
        },
      ],
    });
    const result = await loadQueueStatus(world.deps);
    expect(result.byStatus?.dead).toBe(1);
    expect(result.byStatus?.queued).toBe(1);
    expect(result.sweepHealth).toHaveLength(1);
    expect(result.sweepHealth?.[0]?.jobname).toBe("campaigns-sweep");
  });

  it("reports a status count failure as null for that status without losing the others", async () => {
    const world = createWorld({ jobs: [job({ status: "dead" })], countError: true });
    const result = await loadQueueStatus(world.deps);
    expect(result.byStatus?.dead).toBeNull();
    // deadJobs is a SEPARATE read from the count, so it still succeeds.
    expect(result.deadJobs).not.toBeNull();
  });
});

// ===========================================================================
// replayJob
// ===========================================================================

describe("replayJob: the mandatory reason", () => {
  it("refuses a blank reason before touching the database", async () => {
    const world = createWorld();
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: "   ", requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("REASON_REQUIRED");
    expect(world.ops).toHaveLength(0);
  });

  it("refuses a reason too short to be evidence of anything", async () => {
    const world = createWorld();
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: "fixed", requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("REASON_REQUIRED");
  });
});

describe("replayJob: the actor check", () => {
  // Mutant: skip the table-truth read and trust the caller's role. Proves a
  // caller with no active `platform_admins` row is refused - this is the
  // "assert the refusal" test the brief asks for at the data layer (the
  // server-action layer has its own, separate refusal for no session at
  // all).
  it("refuses a caller with no active platform_admins row", async () => {
    const world = createWorld({ adminRole: null });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
    expect(world.updatesTo("jobs")).toHaveLength(0);
  });

  // Mutant: check only "does a platform_admins row exist" and drop the
  // `canActOnLadder` role predicate. Doc 31 §5 scopes this screen to
  // admin/super_admin, NOT support (§4.3: "support ... never mutates").
  it("refuses a support-role admin, who is read-only everywhere", async () => {
    const world = createWorld({ adminRole: "support" });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
    expect(world.updatesTo("jobs")).toHaveLength(0);
  });

  it("allows an active super_admin", async () => {
    const world = createWorld({ adminRole: "super_admin" });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(true);
  });

  it("reports a database fault verifying the actor as FORBIDDEN, not a crash", async () => {
    const world = createWorld({ adminReadError: { message: "connection reset" } });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("FORBIDDEN");
  });
});

describe("replayJob: the subject and its state", () => {
  it("reports a job that does not exist as NOT_FOUND", async () => {
    const world = createWorld({ jobs: [] });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("NOT_FOUND");
  });

  // Mutant: drop the `job.status !== "dead"` check. A queued/running job
  // replayed would have its attempts silently reset to 0, discarding real
  // in-flight progress and history.
  it.each(["queued", "running", "succeeded", "failed"])(
    "refuses a job that is not dead (status=%s)",
    async (status) => {
      const world = createWorld({ jobs: [job({ status })] });
      const outcome = await replayJob(
        { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
        world.deps,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe("INVALID_STATE");
      expect(world.updatesTo("jobs")).toHaveLength(0);
    },
  );
});

describe("replayJob: the reset itself", () => {
  // Mutant: leave `attempts` at its exhausted value instead of resetting to
  // 0 (or, in the other direction, silently raise `max_attempts`). Doc 39's
  // "Replay procedure" says explicitly: reset attempts=0, status='queued',
  // last_error=null - this is the audited, third answer to "what happens at
  // the cap" (see the module header), and this test proves the reset lands.
  it("resets attempts to 0 even when the job died at its own attempt cap", async () => {
    const world = createWorld({ jobs: [job({ attempts: 5, max_attempts: 5 })] });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome).toMatchObject({ ok: true, detail: { status: "queued", attempts: 0 } });
    const row = world.store.get(JOB_ID);
    expect(row?.attempts).toBe(0);
    expect(row?.status).toBe("queued");
    expect(row?.max_attempts).toBe(5); // untouched - not a raised cap
    expect(row?.last_error).toBeNull();
    expect(row?.finished_at).toBeNull();
    expect(row?.started_at).toBeNull();
  });

  // Mutant: write `attempts: 0` without also clearing `started_at`. 0029's
  // `jobs_started_at_attempts` check requires `(attempts = 0) = (started_at
  // is null)` - a real Postgres write with attempts=0 and a non-null
  // started_at would be REJECTED by the database, not silently accepted.
  it("clears started_at alongside the attempts reset, satisfying jobs_started_at_attempts", async () => {
    const world = createWorld({ jobs: [job({ started_at: "2026-07-26T09:59:00.000Z" })] });
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);
    const row = world.store.get(JOB_ID);
    expect(row?.attempts).toBe(0);
    expect(row?.started_at).toBeNull();
  });

  it("writes exactly one audit row, with the admin verb, actor and reason", async () => {
    const world = createWorld({ adminRole: "admin" });
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "req-1" }, world.deps);

    expect(world.auditInserts).toHaveLength(1);
    expect(world.auditInserts[0]).toMatchObject({
      actor_id: ADMIN_ID,
      actor_kind: "admin",
      actor_role: "admin",
      action: "job.replayed",
      entity_type: "job",
      entity_id: JOB_ID,
      reason: REASON,
      request_id: "req-1",
    });
  });

  // Mutant: put the CURRENT (post-reset) attempts/status into `before`
  // instead of what the row was before the write. The audit row exists so an
  // investigator can see what was true before an admin acted; a `before`
  // that already matches `after` erases that.
  it("records the job's exhausted attempt count in the audit row's before, not the reset value", async () => {
    const world = createWorld({ jobs: [job({ attempts: 5, max_attempts: 5, status: "dead" })] });
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);

    const row = world.auditInserts[0] as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(row.before).toMatchObject({ status: "dead", attempts: 5 });
    expect(row.after).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("carries the job's business_id onto the audit row, for the tenant-scoped audit read", async () => {
    const world = createWorld({ jobs: [job({ business_id: "biz-42" })] });
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);
    expect(world.auditInserts[0]).toMatchObject({ business_id: "biz-42" });
  });
});

describe("replayJob: races and failures", () => {
  // Mutant: drop the `.eq("status", "dead")` guard on the update itself
  // (i.e. write unconditionally once the earlier read said "dead"). Without
  // it, a second admin's concurrent replay (or, if it ever became possible,
  // a worker claim) landing between the read and the write would be silently
  // overwritten instead of losing the race visibly.
  it("loses cleanly when the row's status moves between the read and the write", async () => {
    const world = createWorld({
      jobs: [job()],
      raceOnUpdate: (row) => {
        row.status = "queued"; // someone else already replayed it
      },
    });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("INVALID_STATE");
    // No audit row for a replay that did not actually happen.
    expect(world.auditInserts).toHaveLength(0);
  });

  it("reports WRITE_FAILED and writes no audit row when the update itself errors", async () => {
    const world = createWorld({ jobWriteError: { message: "deadlock detected" } });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("WRITE_FAILED");
    expect(world.auditInserts).toHaveLength(0);
  });

  // Mutant: report AUDIT_WRITE_FAILED without reverting the row, or revert
  // only some of the reset columns. An unaudited admin action is exactly
  // what doc 15 forbids; the row must go back to what it was, byte for byte.
  it("reverts the reset when the audit write fails, and reports AUDIT_WRITE_FAILED", async () => {
    const original = job({ attempts: 3, max_attempts: 5, last_error: "resend 503", status: "dead" });
    const world = createWorld({ jobs: [original], auditError: { message: "insert failed" } });

    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("AUDIT_WRITE_FAILED");

    const row = world.store.get(JOB_ID);
    expect(row).toMatchObject({
      status: "dead",
      attempts: 3,
      max_attempts: 5,
      last_error: "resend 503",
    });
    // Two writes recorded: the reset, then the revert.
    expect(world.updatesTo("jobs")).toHaveLength(2);
  });
});

describe("replayJob: re-publishing to QStash", () => {
  it("re-publishes the SAME job_id to its own queue, with the job's payload and business", async () => {
    const world = createWorld({
      jobs: [job({ queue: "ocr.process", payload: { receipt_id: "receipt-1" }, business_id: "biz-9" })],
    });
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);
    expect(world.republish).toHaveBeenCalledWith(
      "ocr.process",
      JOB_ID,
      { receipt_id: "receipt-1" },
      "biz-9",
    );
  });

  // Mutant: propagate a republish failure into the function's own result
  // (e.g. return AUDIT_WRITE_FAILED-shaped failure, or `ok: false`). Doc 39's
  // "Postgres is the truth" applies to a replay exactly as it does to a
  // fresh enqueue - the row and the audit row are already durably committed
  // by the time this runs, so a QStash outage must not un-replay the job.
  it("still reports success when the best-effort republish fails", async () => {
    const world = createWorld();
    world.republish.mockResolvedValueOnce(false);
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome).toMatchObject({ ok: true, detail: { republished: false } });
    // The row itself is still reset - not rolled back over a delivery failure.
    expect(world.store.get(JOB_ID)?.status).toBe("queued");
  });

  it("skips the publish attempt for a queue this build has no worker for, without failing the replay", async () => {
    const world = createWorld({ jobs: [job({ queue: "fraud.ring_sweep" })] });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome).toMatchObject({ ok: true, detail: { republished: false } });
    expect(world.republish).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// The central integration proof: replay, then the REAL claimJob.
// ===========================================================================

describe("replayJob leaves the row claimable by the normal worker path", () => {
  it("lets the real claimJob claim a replayed job, at attempts=1", async () => {
    const world = createWorld({ jobs: [job({ queue: "notify.email", attempts: 5, max_attempts: 5 })] });

    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(true);

    const claim = await claimJob({
      supabase: world.deps.supabase,
      jobId: JOB_ID,
      queue: "notify.email",
      now: () => NOW,
    });

    expect(claim.status).toBe("claimed");
    if (claim.status === "claimed") {
      expect(claim.job.attempts).toBe(1);
    }
  });

  // Mutant: this is the test that would catch "replay resets attempts but
  // forgets to reset status", or the reverse - either half missing leaves
  // `claimJob`'s FIRST branch (`status === 'dead' -> done`) still matching,
  // so the job would report "done" forever and never actually be claimed.
  it("does not leave a replayed job reporting done, the way an un-reset dead row would", async () => {
    const world = createWorld({ jobs: [job()] });
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);

    const claim = await claimJob({
      supabase: world.deps.supabase,
      jobId: JOB_ID,
      queue: "notify.email",
      now: () => NOW,
    });
    expect(claim.status).not.toBe("done");
  });

  // The property doc 39 calls out explicitly: a job replayed AT its own
  // attempt cap must not be marked "exhausted" on its very next claim. If
  // attempts were left at 5 (of 5) instead of reset to 0, claimJob's own
  // exhaustion check (`attempts + 1 > max_attempts`) would immediately mark
  // it dead again - replay would be a no-op that LOOKS like it worked.
  it("does not immediately re-exhaust a job that died at max_attempts", async () => {
    const world = createWorld({ jobs: [job({ attempts: 5, max_attempts: 5 })] });
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);

    const claim = await claimJob({
      supabase: world.deps.supabase,
      jobId: JOB_ID,
      queue: "notify.email",
      now: () => NOW,
    });
    expect(claim.status).toBe("claimed");
  });
});

// ===========================================================================
// republishDeadJob: the QStash side-effect itself
// ===========================================================================

describe("republishDeadJob", () => {
  it("does not call fetch when QStash is not configured", async () => {
    ENV.current = { QSTASH_URL: undefined, QSTASH_TOKEN: undefined, QSTASH_CALLBACK_ORIGIN: undefined };
    const fetchImpl = vi.fn();
    const ok = await republishDeadJob("notify.email", JOB_ID, { notification_ids: ["n1"] }, "biz-1", fetchImpl as unknown as typeof fetch);
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Mutant: publish to a fabricated URL, or drop `job_id` from the body. This
  // is doc 39's own instruction ("re-publish to QStash with the SAME
  // job_id") and it is the one fact a replayed message must carry for the
  // worker's claim to find the right row.
  it("posts to this queue's own destination with the same job_id in the body", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(JSON.stringify({ messageId: "msg-new" }), { status: 200 }),
    );
    const ok = await republishDeadJob(
      "notify.email",
      JOB_ID,
      { notification_ids: ["n1"] },
      "biz-1",
      fetchImpl,
    );
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = vi.mocked(fetchImpl).mock.calls[0];
    if (call === undefined) throw new Error("fetchImpl was not called");
    const [url, init] = call;
    if (init === undefined) throw new Error("fetchImpl was called with no init");
    expect(url).toContain("/v2/publish/");
    expect(url).toContain("/api/jobs/notify.email");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ job_id: JOB_ID, notification_ids: ["n1"] });
  });

  it("reports false when QStash refuses the publish", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const ok = await republishDeadJob(
      "notify.email",
      JOB_ID,
      {},
      null,
      fetchImpl as unknown as typeof fetch,
    );
    expect(ok).toBe(false);
  });

  it("reports false rather than throwing when the network call itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      republishDeadJob("notify.email", JOB_ID, {}, null, fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(false);
  });
});
