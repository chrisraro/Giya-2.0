// @vitest-environment node
//
// `/admin/monitoring/queues`: the read (`loadQueueStatus`) and doc 39's
// replay procedure (`replayJob`), plus the QStash side-effect
// (`republishDeadJob`) replay depends on.
//
// THE CENTRAL PROPERTY UNDER TEST, stated once because every guard below
// serves it: a dead job that `replayJob` touches must come out the other
// side genuinely claimable by the REAL `claimJob` (`src/lib/queue/claim.ts`)
// - not merely "the code looks like it resets the right columns". The
// claimability describe block proves this by running the actual `claimJob`
// against the same in-memory row `replayJob` wrote to, rather than asserting
// on the patch object and trusting it satisfies `claimJob`'s predicate.
//
// SECOND PROPERTY, added on review: a replay is not successful until it is
// DELIVERABLE. This build has no reconciler (see `jobs.ts`'s module header),
// so an undelivered `queued` row is invisible forever, not merely delayed -
// worse than the dead-lettered state it replaced. Every "delivery failed"
// test below asserts the row is back to `dead`, not left stranded `queued`.

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
  /** Applies ONLY to the first `jobs` UPDATE (the CAS reset) - not to the
   * revert, the message-id write-back, or a later audit-failure revert -
   * mirroring `consequences.test.ts`'s "the first update is the state
   * change; a second one is the revert" convention. */
  casWriteError?: { message: string; code?: string } | null;
  /** Applies to the message-id write-back specifically (best effort). */
  messageIdWriteError?: { message: string } | null;
  auditError?: { message: string } | null;
  /** Simulates another writer changing the row between the read and the CAS. */
  raceOnUpdate?: (row: JobFixture) => void;
  deadListError?: { message: string } | null;
  countError?: boolean;
  sweepRows?: unknown[];
  sweepError?: { message: string } | null;
  /** audit_logs `entity_id` rows returned for the replay-count read (I6). */
  replayAuditRows?: Array<{ entity_id: string | null; action?: string }>;
  replayCountReadError?: { message: string } | null;
}

interface Op {
  table: string;
  kind: "select" | "update" | "insert" | "rpc";
  filters: Array<{ column: string; value: unknown; method: "eq" | "in" }>;
  patch?: Record<string, unknown>;
  values?: Record<string, unknown>;
  order?: { column: string; ascending: boolean } | undefined;
}

function createWorld(options: WorldOptions = {}) {
  const store = new Map<string, JobFixture>((options.jobs ?? [job()]).map((row) => [row.id, row]));
  const ops: Op[] = [];
  const auditInserts: Array<Record<string, unknown>> = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  let jobsUpdateCount = 0;

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
            let orderInfo: Op["order"];

            const chain = {
              eq(column: string, value: unknown) {
                filters.push({ column, value, method: "eq" as const });
                return chain;
              },
              in(column: string, value: unknown[]) {
                filters.push({ column, value, method: "in" as const });
                return chain;
              },
              order(column: string, opts?: { ascending?: boolean }) {
                orderInfo = { column, ascending: opts?.ascending ?? true };
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
              ops.push({ table, kind: "select", filters: [...filters], order: orderInfo });
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
              // write lands on the same store row (the revert tests depend
              // on this - they capture "before" from this read).
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

              jobsUpdateCount += 1;
              const isFirstUpdate = jobsUpdateCount === 1;
              // Heuristic: the message-id write-back is the only update that
              // touches ONLY `qstash_message_id`.
              const isMessageIdWrite =
                Object.keys(patch).length === 1 && Object.hasOwn(patch, "qstash_message_id");

              const matchesRows = [...store.values()].filter((row) => matches(row, filters));
              ops.push({ table, kind: "update", filters: [...filters], patch: { ...patch } });

              if (isFirstUpdate && options.casWriteError !== undefined && options.casWriteError !== null) {
                return Promise.resolve({ data: null, error: options.casWriteError });
              }
              if (
                isMessageIdWrite &&
                options.messageIdWriteError !== undefined &&
                options.messageIdWriteError !== null
              ) {
                return Promise.resolve({ data: null, error: options.messageIdWriteError });
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
          select() {
            const filters: Op["filters"] = [];
            const chain = {
              eq(column: string, value: unknown) {
                filters.push({ column, value, method: "eq" as const });
                return chain;
              },
              in(column: string, value: unknown[]) {
                filters.push({ column, value, method: "in" as const });
                return chain;
              },
              limit() {
                return chain;
              },
              then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
                ops.push({ table, kind: "select", filters: [...filters] });
                if (
                  options.replayCountReadError !== undefined &&
                  options.replayCountReadError !== null
                ) {
                  return Promise.resolve({ data: null, error: options.replayCountReadError }).then(
                    onFulfilled,
                    onRejected,
                  );
                }
                // Real filtering, not a canned passthrough: the `.eq("action",
                // ...)` predicate is exactly what I6's "only job.replayed
                // counts" test depends on.
                const actionFilter = filters.find((f) => f.column === "action")?.value;
                const entityIdFilter = filters.find((f) => f.column === "entity_id");
                const rows = (options.replayAuditRows ?? []).filter((row) => {
                  if (actionFilter !== undefined && row.action !== actionFilter) return false;
                  if (entityIdFilter !== undefined) {
                    const allowed = entityIdFilter.value as unknown[];
                    if (!allowed.includes(row.entity_id)) return false;
                  }
                  return true;
                });
                return Promise.resolve({ data: rows, error: null }).then(
                  onFulfilled,
                  onRejected,
                );
              },
            };
            return chain;
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

  const republish = vi.fn<AdminJobsDeps["republish"]>(async () => "msg-new-1");

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

  // I5. Mutant: order newest-first (or drop the explicit `ascending: true`).
  // On a platform with more than `DEAD_JOBS_LIMIT` dead jobs, newest-first
  // truncates away exactly the ones that have been dead the longest.
  it("orders the dead-letter list oldest first", async () => {
    const world = createWorld({ jobs: [job()] });
    await loadQueueStatus(world.deps);
    const deadListRead = world.ops.find(
      (op) => op.table === "jobs" && op.kind === "select" && op.order !== undefined,
    );
    expect(deadListRead?.order).toEqual({ column: "finished_at", ascending: true });
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

  // Mutant: let one status's count failure blank out the whole `byStatus`
  // object (e.g. `return null` on any per-status error) instead of leaving
  // the other four counts intact.
  it("reports a status count failure as null for that status without losing the others", async () => {
    const world = createWorld({ jobs: [job({ status: "dead" })], countError: true });
    const result = await loadQueueStatus(world.deps);
    expect(result.byStatus?.dead).toBeNull();
    // deadJobs is a SEPARATE read from the count, so it still succeeds.
    expect(result.deadJobs).not.toBeNull();
  });

  // I6. Mutant: default every job's replay count to 0 instead of counting
  // `audit_logs` rows, or count ALL actions instead of only
  // `job.replayed` (which would conflate a delivered replay with a merely
  // attempted one, `job.replay_failed`).
  describe("replay counts (I6)", () => {
    it("counts only job.replayed rows for each dead job, ignoring job.replay_failed", async () => {
      const world = createWorld({
        jobs: [job({ id: "dead-1", status: "dead" })],
        replayAuditRows: [
          { entity_id: "dead-1", action: "job.replayed" },
          { entity_id: "dead-1", action: "job.replayed" },
          { entity_id: "dead-1", action: "job.replay_failed" },
        ],
      });
      const result = await loadQueueStatus(world.deps);
      expect(result.deadJobs?.[0]?.replayCount).toBe(2);
    });

    it("reports 0, not null, for a job that has never been replayed", async () => {
      const world = createWorld({ jobs: [job({ id: "dead-1" })], replayAuditRows: [] });
      const result = await loadQueueStatus(world.deps);
      expect(result.deadJobs?.[0]?.replayCount).toBe(0);
    });

    // Mutant: default a failed audit-history read to `0` instead of `null`.
    // "Never replayed" and "could not find out" are different facts, same
    // rule as every other null-vs-empty distinction in this module.
    it("reports null, not 0, when the replay-history read itself fails", async () => {
      const world = createWorld({
        jobs: [job({ id: "dead-1" })],
        replayCountReadError: { message: "connection reset" },
      });
      const result = await loadQueueStatus(world.deps);
      expect(result.deadJobs?.[0]?.replayCount).toBeNull();
    });
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

  // Mutant: use a laxer length check than `reasonProblem`'s own
  // `MIN_REASON_LENGTH` (e.g. accept any non-empty string).
  it("refuses a reason too short to be evidence of anything", async () => {
    const world = createWorld();
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: "fixed", requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("REASON_REQUIRED");
    expect(world.ops).toHaveLength(0);
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

  // Mutant: refuse every role, including the ones that ARE allowed (e.g. an
  // inverted `canActOnLadder` check, or one that always returns false).
  it("allows an active super_admin", async () => {
    const world = createWorld({ adminRole: "super_admin" });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(true);
  });

  // Mutant: let the actor-verification error propagate as a thrown exception
  // or a different code (e.g. WRITE_FAILED) instead of the fail-closed
  // FORBIDDEN `assertCanReplay` returns on a read error.
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
  // Mutant: report a different code (e.g. INVALID_STATE, or ok:true on a
  // null row) when the job id does not resolve to any row.
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

  // Mutant: write `job.replayed` under a DIFFERENT `actor_kind` (e.g.
  // "system" or "user"), which would let a replay through with a blank
  // reason - `audit_logs_admin_reason_required` (0022) only fires for
  // `actor_kind='admin'`.
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

  // Mutant: drop `business_id` from the audit insert (or hardcode null).
  // `audit_biz_idx` and the tenant-owner audit read both key on this column.
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
    const world = createWorld({ casWriteError: { message: "deadlock detected" } });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("WRITE_FAILED");
    expect(world.auditInserts).toHaveLength(0);
  });

  // I4. Mutant: report every write error, including a unique-violation, as
  // the generic WRITE_FAILED ("try again"). A dedupe collision is NOT
  // transient - retrying this exact replay collides again every time,
  // because a live job already owns the row's dedupe key.
  it("reports DEDUPE_CONFLICT, not WRITE_FAILED, when the reset collides with jobs_dedupe_idx", async () => {
    const world = createWorld({ casWriteError: { message: "duplicate key value", code: "23505" } });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("DEDUPE_CONFLICT");
      expect(outcome.message).toMatch(/already in flight/i);
    }
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
  });
});

describe("replayJob: re-publishing to QStash (I2, I3)", () => {
  it("re-publishes the SAME job_id to its own queue, with the job's payload and business", async () => {
    const world = createWorld({
      jobs: [job({ queue: "ocr.process", payload: { receipt_id: "receipt-1" }, business_id: "biz-9" })],
    });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(world.republish).toHaveBeenCalledWith(
      "ocr.process",
      JOB_ID,
      { receipt_id: "receipt-1" },
      "biz-9",
    );
    expect(outcome).toMatchObject({ ok: true, detail: { messageId: "msg-new-1" } });
  });

  // I2. Mutant: never write `qstash_message_id` back after a successful
  // republish (the original bug: the reviewer's finding). 0029 documents
  // `qstash_message_id is null` as meaning "not published" and load-bearing
  // for a future reconciler's scan predicate - leaving it null after a real
  // publish asserts a falsehood about the row.
  it("records the new qstash_message_id after a successful redelivery", async () => {
    const world = createWorld();
    world.republish.mockResolvedValueOnce("msg-abc-123");
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);
    expect(world.store.get(JOB_ID)?.qstash_message_id).toBe("msg-abc-123");
  });

  // Best effort: losing this write costs DLQ correlation on a FUTURE dead
  // letter, nothing about the delivery that already happened - it must not
  // fail the replay itself.
  it("still reports success when recording the message id fails", async () => {
    const world = createWorld({ messageIdWriteError: { message: "timeout" } });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(true);
  });

  // I3. Mutant: leave the row `queued` when `republish` returns null (or
  // report `ok: true` regardless of delivery). This build has no
  // reconciler, so an undelivered `queued` row is invisible forever - the
  // row must revert to `dead` and the caller must be told delivery failed.
  it("reverts the reset and reports REPUBLISH_FAILED when delivery cannot be confirmed", async () => {
    const world = createWorld({
      jobs: [job({ attempts: 3, max_attempts: 5, last_error: "resend 503", status: "dead" })],
    });
    world.republish.mockResolvedValueOnce(null);

    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("REPUBLISH_FAILED");

    const row = world.store.get(JOB_ID);
    expect(row?.status).toBe("dead");
    expect(row?.attempts).toBe(3);
    expect(row?.max_attempts).toBe(5);
    // The DLQ row now explains itself, rather than restoring the stale error
    // from whatever killed it the first time.
    expect(row?.last_error).toMatch(/could not be redelivered/i);
  });

  // Mutant: record the failed attempt under the SAME verb as a real replay
  // (`job.replayed`), which would let I6's replay-count chip claim a
  // delivery that never happened.
  it("audits a failed delivery attempt under a distinct verb, job.replay_failed", async () => {
    const world = createWorld();
    world.republish.mockResolvedValueOnce(null);
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);

    expect(world.auditInserts).toHaveLength(1);
    expect(world.auditInserts[0]).toMatchObject({
      action: "job.replay_failed",
      entity_type: "job",
      entity_id: JOB_ID,
      reason: REASON,
    });
  });

  // Mutant: attempt the publish call anyway for a queue with no worker in
  // this build's registry (would throw indexing `QUEUE_REGISTRY[queue]`),
  // or silently report success without ever having tried.
  it("treats an unregistered queue as undeliverable: reverts to dead, never calls republish", async () => {
    const world = createWorld({ jobs: [job({ queue: "fraud.ring_sweep" })] });
    const outcome = await replayJob(
      { jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" },
      world.deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("REPUBLISH_FAILED");
    expect(world.republish).not.toHaveBeenCalled();
    expect(world.store.get(JOB_ID)?.status).toBe("dead");
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

  // A replay that FAILED to deliver must NOT be claimable either - the row
  // reverted to `dead`, and `claimJob`'s own first branch reports that as
  // `done` (doc 39: "already succeeded or already dead"), never `claimed`.
  it("a job whose replay could not be delivered is not claimable - it is still dead", async () => {
    const world = createWorld({ jobs: [job({ attempts: 5, max_attempts: 5 })] });
    world.republish.mockResolvedValueOnce(null);
    await replayJob({ jobId: JOB_ID, actorId: ADMIN_ID, reason: REASON, requestId: "r1" }, world.deps);

    const claim = await claimJob({
      supabase: world.deps.supabase,
      jobId: JOB_ID,
      queue: "notify.email",
      now: () => NOW,
    });
    expect(claim).toEqual({ status: "done", jobStatus: "dead" });
  });
});

// ===========================================================================
// republishDeadJob: the QStash side-effect itself
// ===========================================================================

describe("republishDeadJob", () => {
  it("returns null and does not call fetch when QStash is not configured", async () => {
    ENV.current = { QSTASH_URL: undefined, QSTASH_TOKEN: undefined, QSTASH_CALLBACK_ORIGIN: undefined };
    const fetchImpl = vi.fn();
    const messageId = await republishDeadJob(
      "notify.email",
      JOB_ID,
      { notification_ids: ["n1"] },
      "biz-1",
      fetchImpl as unknown as typeof fetch,
    );
    expect(messageId).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Mutant: publish to a fabricated URL, or drop `job_id` from the body. This
  // is doc 39's own instruction ("re-publish to QStash with the SAME
  // job_id") and it is the one fact a replayed message must carry for the
  // worker's claim to find the right row.
  it("posts to this queue's own destination with the same job_id in the body, and returns the message id", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      new Response(JSON.stringify({ messageId: "msg-new" }), { status: 200 }),
    );
    const messageId = await republishDeadJob(
      "notify.email",
      JOB_ID,
      { notification_ids: ["n1"] },
      "biz-1",
      fetchImpl,
    );
    expect(messageId).toBe("msg-new");
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

  // The body deliberately parses as a VALID success shape (a real QStash 5xx
  // would never do this, but the fixture has to isolate `!response.ok` from
  // the schema-validation branch below it - a non-JSON error body would
  // return null via the JSON-parse failure regardless of whether the status
  // check ran at all, which would make this test pass even with the status
  // check deleted).
  it("returns null when QStash refuses the publish, even if the body looks like a success", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ messageId: "should-not-count" }), { status: 500 }),
    );
    const messageId = await republishDeadJob(
      "notify.email",
      JOB_ID,
      {},
      null,
      fetchImpl as unknown as typeof fetch,
    );
    expect(messageId).toBeNull();
  });

  // I2. Mutant: read `response.ok` alone as success (the reviewer's own
  // example - an HTML error page served with a 200 must not be read as a
  // delivered message).
  it("returns null when a 200 response is not even valid JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html><body>upstream error</body></html>", { status: 200 }),
    );
    const messageId = await republishDeadJob(
      "notify.email",
      JOB_ID,
      {},
      null,
      fetchImpl as unknown as typeof fetch,
    );
    expect(messageId).toBeNull();
  });

  // Isolates the SCHEMA check from the JSON-parse check above it: valid JSON,
  // wrong shape (no `messageId` anywhere) - the review's own example ("an
  // HTML error page served with a 200") generalizes to any 200 whose body is
  // not actually a delivery confirmation, JSON or not.
  it("returns null when a 200 response is valid JSON but does not match QStash's publish shape", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "internal error", code: 500 }), { status: 200 }),
    );
    const messageId = await republishDeadJob(
      "notify.email",
      JOB_ID,
      {},
      null,
      fetchImpl as unknown as typeof fetch,
    );
    expect(messageId).toBeNull();
  });

  it("returns null rather than throwing when the network call itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      republishDeadJob("notify.email", JOB_ID, {}, null, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeNull();
  });
});
