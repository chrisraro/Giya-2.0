// @vitest-environment node
//
// The claim IS the idempotency gate for duplicate delivery, so this suite is
// about exactly one question: which deliveries get to do the work, and which
// are told to go away.
//
// QStash delivers at least once by design, so a second delivery of the same
// message is normal traffic rather than an anomaly. Every branch below decides
// what a worker does with one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { claimJob, finishJob } from "./claim";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;

interface Stored {
  id: string;
  queue: string;
  status: string;
  payload: unknown;
  business_id: string | null;
  attempts: number;
  max_attempts: number;
  started_at: string | null;
  heartbeat_at: string | null;
}

function job(overrides: Partial<Stored> = {}): Stored {
  return {
    id: "job-1",
    queue: "notify.email",
    status: "queued",
    payload: { notification_ids: ["n1"] },
    business_id: "biz-1",
    attempts: 0,
    max_attempts: 5,
    started_at: null,
    heartbeat_at: null,
    ...overrides,
  };
}

interface DoubleOptions {
  readonly row?: Stored | null;
  readonly readError?: { message: string } | null;
  /** Simulates losing the compare-and-swap: the guarded UPDATE matches nothing. */
  readonly claimLost?: boolean;
  readonly claimError?: { message: string } | null;
}

function supabaseDouble(options: DoubleOptions = {}) {
  const updates: { patch: Record<string, unknown>; filters: Record<string, unknown> }[] = [];

  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              options.readError
                ? { data: null, error: options.readError }
                : { data: options.row === undefined ? job() : options.row, error: null },
          }),
        }),
        update(patch: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            in(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            select: () => ({
              maybeSingle: async () => {
                updates.push({ patch, filters });
                if (options.claimError) return { data: null, error: options.claimError };
                return { data: options.claimLost === true ? null : { id: "job-1" }, error: null };
              },
            }),
            then(resolve: (value: { error: null }) => unknown) {
              updates.push({ patch, filters });
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient<Database>;

  return { client, updates };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claimJob", () => {
  it("claims a queued job and increments its attempt count", async () => {
    const { client, updates } = supabaseDouble();
    const result = await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now });

    expect(result.status).toBe("claimed");
    if (result.status === "claimed") {
      expect(result.job.attempts).toBe(1);
      expect(result.job.businessId).toBe("biz-1");
    }
    expect(updates[0]?.patch).toMatchObject({
      status: "running",
      attempts: 1,
      started_at: NOW.toISOString(),
    });
  });

  // THE COMPARE-AND-SWAP. `attempts` is both the value written and the guard,
  // which is what makes two racing invocations resolve to exactly one winner.
  // PostgREST cannot express `attempts = attempts + 1`, so without this the
  // claim would not be atomic at all.
  it("guards the claim on the attempt count it observed", async () => {
    const { client, updates } = supabaseDouble({ row: job({ attempts: 2, started_at: "2026-07-26T11:00:00.000Z", status: "failed" }) });
    await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now });
    expect(updates[0]?.filters).toMatchObject({ id: "job-1", attempts: 2 });
    expect(updates[0]?.patch).toMatchObject({ attempts: 3 });
  });

  it("reports the loser of a race as held rather than claiming twice", async () => {
    const { client } = supabaseDouble({ claimLost: true });
    const result = await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now });
    expect(result.status).toBe("held");
  });

  // Doc 39: a retryable failure writes status='failed' and returns a 5xx, and
  // the claim predicate is `status in ('queued','failed')` precisely so the
  // next delivery picks it up.
  it("claims a failed job so a retry can run", async () => {
    const { client } = supabaseDouble({
      row: job({ status: "failed", attempts: 1, started_at: "2026-07-26T11:00:00.000Z" }),
    });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now })).status,
    ).toBe("claimed");
  });

  // Doc 39: "0 rows and status='succeeded' -> return 200 (duplicate delivery;
  // idempotent no-op)".
  it("reports an already-succeeded job as done", async () => {
    const { client, updates } = supabaseDouble({ row: job({ status: "succeeded", attempts: 1, started_at: "x" }) });
    const result = await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now });
    expect(result).toEqual({ status: "done", jobStatus: "succeeded" });
    // and nothing was written, which is what makes it a no-op rather than a
    // second run that happened to do nothing.
    expect(updates).toHaveLength(0);
  });

  it("reports a dead job as done", async () => {
    const { client } = supabaseDouble({ row: job({ status: "dead", attempts: 5, started_at: "x" }) });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now })).status,
    ).toBe("done");
  });

  // Doc 39: "0 rows and status='running' with a live heartbeat -> 200
  // (concurrent duplicate; the other invocation owns it)".
  it("leaves a running job alone while its heartbeat is fresh", async () => {
    const { client, updates } = supabaseDouble({
      row: job({
        status: "running",
        attempts: 1,
        started_at: new Date(NOW.getTime() - 10_000).toISOString(),
        heartbeat_at: new Date(NOW.getTime() - 5_000).toISOString(),
      }),
    });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now })).status,
    ).toBe("held");
    expect(updates).toHaveLength(0);
  });

  // Doc 39: "0 rows and status='running' with expired heartbeat -> reclaim".
  // The window is twice the queue's own maxDuration, so a reclaim only happens
  // after the platform has provably killed the original invocation.
  it("reclaims a running job that has gone quiet past twice its budget", async () => {
    const { client } = supabaseDouble({
      row: job({
        status: "running",
        attempts: 1,
        started_at: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
        heartbeat_at: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      }),
    });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now })).status,
    ).toBe("claimed");
  });

  it("does not reclaim just before the window closes", async () => {
    const { client } = supabaseDouble({
      row: job({
        status: "running",
        attempts: 1,
        // 119s against a 60s budget doubled.
        heartbeat_at: new Date(NOW.getTime() - 119_000).toISOString(),
        started_at: new Date(NOW.getTime() - 119_000).toISOString(),
      }),
    });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now })).status,
    ).toBe("held");
  });

  // t2-6 follow-up: a LIVE heartbeat (one that has actually advanced past the
  // claim-time value claimJob wrote into both columns) must be judged against
  // its own short window, not the queue's `2 * maxDuration` budget. Judging a
  // live heartbeat against `maxDuration` would let ocr.process (120s budget,
  // and a worker that heartbeats every 20s until Vercel kills it at 120s)
  // push its own reclaim out to 360s - and every QStash redelivery in that
  // gap would land on "held" and be permanently consumed for nothing, since a
  // dead worker's row never gets less dead by waiting.
  it("reclaims a job whose LIVE heartbeat has gone stale, using the heartbeat window rather than 2x maxDuration", async () => {
    const { client } = supabaseDouble({
      row: job({
        queue: "ocr.process",
        status: "running",
        attempts: 1,
        // Claimed long ago - well inside ocr.process's 240s (2x120s) budget,
        // which is exactly the point: the OLD rule would still call this
        // "held" for another three minutes.
        started_at: new Date(NOW.getTime() - 200_000).toISOString(),
        // ...but the heartbeat itself has gone quiet for 61s, past the 60s
        // heartbeat window (3x the 20s refresh interval).
        heartbeat_at: new Date(NOW.getTime() - 61_000).toISOString(),
      }),
    });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "ocr.process", now })).status,
    ).toBe("claimed");
  });

  it("leaves a LIVE heartbeat alone while it is within the heartbeat window", async () => {
    const { client } = supabaseDouble({
      row: job({
        queue: "ocr.process",
        status: "running",
        attempts: 1,
        started_at: new Date(NOW.getTime() - 200_000).toISOString(),
        heartbeat_at: new Date(NOW.getTime() - 59_000).toISOString(),
      }),
    });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "ocr.process", now })).status,
    ).toBe("held");
  });

  // The other arm: a worker that died before its first refresh ever landed
  // (heartbeat_at still equal to started_at, exactly what claimJob's CAS
  // writes at claim time) has no LIVE heartbeat to judge - it falls back to
  // the same `2 * maxDuration` budget queues with no heartbeat wiring at all
  // (notify.email) already rely on above.
  it("falls back to 2x maxDuration when no live heartbeat has landed yet", async () => {
    const { client } = supabaseDouble({
      row: job({
        queue: "ocr.process",
        status: "running",
        attempts: 1,
        // Past the 60s heartbeat window, but well inside 240s (2x120s) - and
        // heartbeat_at === started_at, so there is no live heartbeat yet.
        started_at: new Date(NOW.getTime() - 200_000).toISOString(),
        heartbeat_at: new Date(NOW.getTime() - 200_000).toISOString(),
      }),
    });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "ocr.process", now })).status,
    ).toBe("held");
  });

  it("treats a running job with no progress marker at all as stale", async () => {
    const { client } = supabaseDouble({
      row: job({ status: "running", attempts: 1, started_at: null, heartbeat_at: null }),
    });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now })).status,
    ).toBe("claimed");
  });

  // Doc 39: "attempts >= max_attempts after increment -> mark dead, return 200".
  // Checked BEFORE the claim so an exhausted job is never marked running on its
  // way to dead.
  it("marks an exhausted job dead instead of claiming it", async () => {
    const { client, updates } = supabaseDouble({
      row: job({ status: "failed", attempts: 5, max_attempts: 5, started_at: "x" }),
    });
    const result = await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now });
    expect(result.status).toBe("exhausted");
    expect(updates[0]?.patch).toMatchObject({ status: "dead", finished_at: NOW.toISOString() });
    expect(String(updates[0]?.patch.last_error)).toContain("exhausted");
  });

  it("reports a job that does not exist as missing", async () => {
    const { client } = supabaseDouble({ row: null });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now })).status,
    ).toBe("missing");
  });

  // Cannot happen through verify.ts, which pins the destination path. Asserted
  // anyway, because the cost of being wrong is running one queue's payload
  // through another queue's worker.
  it("refuses to run a job that belongs to another queue", async () => {
    const { client, updates } = supabaseDouble({ row: job({ queue: "ocr.process" }) });
    expect(
      (await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now })).status,
    ).toBe("missing");
    expect(updates).toHaveLength(0);
  });

  // The one retryable branch before the work starts: the claim did not
  // conclude, so nothing is known and nothing was done.
  it("reports a database fault as an error so the route can ask for a retry", async () => {
    const { client } = supabaseDouble({ readError: { message: "connection reset" } });
    const result = await claimJob({ supabase: client, jobId: "job-1", queue: "notify.email", now });
    expect(result).toEqual({ status: "error", reason: "connection reset" });
  });

  it("never throws", async () => {
    const broken = {
      from() {
        throw new Error("driver exploded");
      },
    } as unknown as SupabaseClient<Database>;
    await expect(
      claimJob({ supabase: broken, jobId: "job-1", queue: "notify.email", now }),
    ).resolves.toEqual({ status: "error", reason: "unexpected failure" });
  });
});

describe("finishJob", () => {
  it("stamps a succeeded job with a finish time and clears the error", async () => {
    const { client, updates } = supabaseDouble();
    const result = await finishJob(client, "job-1", 1, { kind: "succeeded" }, NOW);
    expect(updates[0]?.patch).toEqual({
      status: "succeeded",
      last_error: null,
      finished_at: NOW.toISOString(),
    });
    expect(result).toEqual({ kind: "recorded" });
  });

  // 0029's `jobs_terminal_finished_at` says a non-terminal row has not
  // finished, and a failed job has not: QStash is about to deliver it again.
  // Writing a finished_at here would violate the constraint and lose the row.
  it("leaves a failed job without a finish time, because it is between attempts", async () => {
    const { client, updates } = supabaseDouble();
    await finishJob(client, "job-1", 1, { kind: "failed", error: "resend 503" }, NOW);
    expect(updates[0]?.patch).toEqual({
      status: "failed",
      last_error: "resend 503",
      finished_at: null,
    });
  });

  it("stamps a dead job, which is the DLQ view's row", async () => {
    const { client, updates } = supabaseDouble();
    await finishJob(client, "job-1", 1, { kind: "dead", error: "payload failed schema validation" }, NOW);
    expect(updates[0]?.patch).toMatchObject({ status: "dead", finished_at: NOW.toISOString() });
  });

  // The lease guard: the write is filtered on the SAME ownership tuple
  // heartbeat.ts's refresh() guards its own write on - `id` + the `attempts`
  // this invocation claimed + `status = 'running'` - not `id` alone.
  it("guards the write on this invocation's (id, attempts, status='running') lease", async () => {
    const { client, updates } = supabaseDouble();
    await finishJob(client, "job-1", 3, { kind: "succeeded" }, NOW);
    expect(updates[0]?.filters).toMatchObject({ id: "job-1", attempts: 3, status: "running" });
  });

  // t2-8: a worker whose lease has moved on (another invocation reclaimed the
  // row) must not be able to write a terminal status over the reclaiming
  // worker's row. The guarded UPDATE matches zero rows, which this reports as
  // a distinct, non-retryable outcome rather than an error.
  it("reports a lease-lost outcome instead of writing when the guarded update matches nothing", async () => {
    const { client, updates } = supabaseDouble({ claimLost: true });
    const result = await finishJob(client, "job-1", 1, { kind: "succeeded" }, NOW);
    expect(result).toEqual({ kind: "lease-lost" });
    // The attempt was made (and therefore logged/observable) - it just did
    // not match any row.
    expect(updates).toHaveLength(1);
  });

  // The schema-validation-failure branches in both worker routes mark a job
  // dead from an unparsed payload BEFORE `claimJob` ever runs, so there is no
  // claim and no `attempts` value to guard on. `attempts: null` is the
  // explicit escape hatch for exactly that caller, preserving the pre-t2-8
  // behaviour of filtering on `id` alone.
  it("filters on id alone when no claim was ever established (attempts: null)", async () => {
    const { client, updates } = supabaseDouble();
    const result = await finishJob(client, "job-1", null, { kind: "dead", error: "bad payload" }, NOW);
    expect(updates[0]?.filters).toEqual({ id: "job-1" });
    expect(result).toEqual({ kind: "recorded" });
  });

  // The work has already happened, so a failure to write the outcome must not
  // change what the route tells QStash.
  it("never throws", async () => {
    const broken = {
      from() {
        throw new Error("driver exploded");
      },
    } as unknown as SupabaseClient<Database>;
    await expect(finishJob(broken, "job-1", 1, { kind: "succeeded" }, NOW)).resolves.toEqual({
      kind: "error",
      reason: "unexpected failure",
    });
  });
});

// =============================================================================
// THE CENTRAL TEST: the false-reclaim interleaving, against the REAL claimJob
// and finishJob together.
// =============================================================================
//
// t2-8's brief, reproduced exactly: an `ocr.process` worker (A) whose last
// successful heartbeat refresh landed at t=40 is queried again at t=101.
// `maxDuration` is 120s, so A is still running - but its heartbeat has been
// quiet for 61s, past `HEARTBEAT_STALE_MS` (60s), so a second worker (B)
// reclaims the row. A does not know this; it keeps running and calls
// `finishJob` late, at t=115. Before this task, that write filtered on `id`
// alone and would have overwritten B's live claim. After it, the write must
// carry no effect at all: B's row survives untouched, and only B's own
// `finishJob` call may retire it.
describe("finishJob honours the lease claimJob granted (the false-reclaim interleaving)", () => {
  interface FakeRow {
    id: string;
    queue: string;
    status: string;
    payload: unknown;
    business_id: string | null;
    attempts: number;
    max_attempts: number;
    started_at: string | null;
    heartbeat_at: string | null;
    finished_at: string | null;
    last_error: string | null;
  }

  const BASE_MS = new Date("2026-07-26T00:00:00.000Z").getTime();
  const at = (seconds: number) => new Date(BASE_MS + seconds * 1_000);

  /** A minimal fake `jobs` table with REAL predicate matching, so claimJob's
   * CAS and finishJob's lease guard are proven against actual filter
   * evaluation rather than a canned response. */
  function makeFakeJobsTable(initial: FakeRow) {
    let row: FakeRow = { ...initial };

    function chain(mode: "select" | "update", patch: Partial<FakeRow> | null) {
      const filters: { column: string; value: unknown; op: "eq" | "in" }[] = [];

      function matches(): boolean {
        return filters.every(({ column, value, op }) => {
          const actual = (row as unknown as Record<string, unknown>)[column];
          return op === "eq" ? actual === value : (value as unknown[]).includes(actual);
        });
      }

      async function resolveSingle(): Promise<{ data: unknown; error: null }> {
        if (!matches()) return { data: null, error: null };
        if (mode === "update" && patch !== null) {
          row = { ...row, ...patch };
        }
        return { data: mode === "select" ? { ...row } : { id: row.id }, error: null };
      }

      const c: Record<string, unknown> = {
        eq(column: string, value: unknown) {
          filters.push({ column, value, op: "eq" });
          return c;
        },
        in(column: string, value: unknown[]) {
          filters.push({ column, value, op: "in" });
          return c;
        },
        select: () => ({ maybeSingle: () => resolveSingle() }),
        maybeSingle: () => resolveSingle(),
        then(onFulfilled: (value: { error: null }) => unknown) {
          return resolveSingle()
            .then(() => ({ error: null }) as const)
            .then(onFulfilled);
        },
      };
      return c;
    }

    const client = {
      from() {
        return {
          select: () => chain("select", null),
          update: (patch: Record<string, unknown>) => chain("update", patch),
        };
      },
    } as unknown as SupabaseClient<Database>;

    return {
      client,
      getRow: () => ({ ...row }),
      /** Test-only escape hatch to fast-forward a fact this suite is given
       * ("last successful refresh landed at t=40") without re-implementing
       * heartbeat.ts's own refresh predicate here too. */
      setRow: (patch: Partial<FakeRow>) => {
        row = { ...row, ...patch };
      },
    };
  }

  function freshRow(): FakeRow {
    return {
      id: "job-1",
      queue: "ocr.process",
      status: "queued",
      payload: { receipt_id: "receipt-1" },
      business_id: "biz-1",
      attempts: 0,
      max_attempts: 3,
      started_at: null,
      heartbeat_at: null,
      finished_at: null,
      last_error: null,
    };
  }

  it("does not let a displaced worker's late finish overwrite the reclaiming worker's row", async () => {
    const { client, getRow, setRow } = makeFakeJobsTable(freshRow());

    // t=0: worker A claims the job.
    const claimA = await claimJob({
      supabase: client,
      jobId: "job-1",
      queue: "ocr.process",
      now: () => at(0),
    });
    expect(claimA.status).toBe("claimed");
    if (claimA.status !== "claimed") throw new Error("unreachable");
    expect(claimA.job.attempts).toBe(1);

    // t=40: A's last successful heartbeat refresh lands, then A goes quiet
    // (event-loop starvation, a dead process, three failed UPDATEs - the
    // brief is explicit that the cause does not matter).
    setRow({ heartbeat_at: at(40).toISOString() });

    // t=101: a redelivery is queried. isStale sees a LIVE heartbeat 61s
    // stale (past the 60s HEARTBEAT_STALE_MS window) even though A's
    // maxDuration budget (120s) has not elapsed - so worker B reclaims.
    const claimB = await claimJob({
      supabase: client,
      jobId: "job-1",
      queue: "ocr.process",
      now: () => at(101),
    });
    expect(claimB.status).toBe("claimed");
    if (claimB.status !== "claimed") throw new Error("unreachable");
    expect(claimB.job.attempts).toBe(2);

    // t=115: A, unaware it was reclaimed, finishes and calls finishJob with
    // the attempts value ITS claim won (1) - stale now that B's claim bumped
    // the row to 2.
    const lateFinish = await finishJob(
      client,
      "job-1",
      claimA.job.attempts,
      { kind: "succeeded" },
      at(115),
    );

    expect(lateFinish).toEqual({ kind: "lease-lost" });
    // B's row is untouched: still running, still B's attempts, not finished.
    expect(getRow()).toMatchObject({
      status: "running",
      attempts: 2,
      finished_at: null,
    });

    // Only B's own finishJob call may retire the row.
    const bFinish = await finishJob(
      client,
      "job-1",
      claimB.job.attempts,
      { kind: "succeeded" },
      at(120),
    );
    expect(bFinish).toEqual({ kind: "recorded" });
    expect(getRow()).toMatchObject({
      status: "succeeded",
      attempts: 2,
      finished_at: at(120).toISOString(),
    });
  });

  it("does not resurrect a job that already reached a terminal state", async () => {
    const { client, getRow } = makeFakeJobsTable({
      ...freshRow(),
      status: "dead",
      attempts: 3,
      started_at: at(0).toISOString(),
      heartbeat_at: at(0).toISOString(),
      finished_at: at(10).toISOString(),
      last_error: "attempt budget of 3 exhausted",
    });

    // Same (id, attempts) the job was last claimed under, but the row moved
    // to a terminal status - `status = 'running'` is required in the guard
    // precisely so this case cannot match.
    const result = await finishJob(client, "job-1", 3, { kind: "succeeded" }, at(20));

    expect(result).toEqual({ kind: "lease-lost" });
    expect(getRow()).toMatchObject({ status: "dead", finished_at: at(10).toISOString() });
  });

  // notify.email never heartbeats, so its reclaim can only ever happen at
  // `2 * maxDuration`, past the point Vercel itself kills the invocation - a
  // reclaim there structurally cannot race a live worker. The guard should
  // therefore be a no-op on this path in practice: a normal, un-raced finish
  // still succeeds.
  it("is a no-op for notify.email's normal (un-raced) path", async () => {
    const { client, getRow } = makeFakeJobsTable({
      ...freshRow(),
      queue: "notify.email",
      status: "queued",
      max_attempts: 5,
    });

    const claim = await claimJob({
      supabase: client,
      jobId: "job-1",
      queue: "notify.email",
      now: () => at(0),
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("unreachable");

    const result = await finishJob(client, "job-1", claim.job.attempts, { kind: "succeeded" }, at(5));
    expect(result).toEqual({ kind: "recorded" });
    expect(getRow()).toMatchObject({ status: "succeeded", finished_at: at(5).toISOString() });
  });
});
