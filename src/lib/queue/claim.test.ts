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
    await finishJob(client, "job-1", { kind: "succeeded" }, NOW);
    expect(updates[0]?.patch).toEqual({
      status: "succeeded",
      last_error: null,
      finished_at: NOW.toISOString(),
    });
  });

  // 0029's `jobs_terminal_finished_at` says a non-terminal row has not
  // finished, and a failed job has not: QStash is about to deliver it again.
  // Writing a finished_at here would violate the constraint and lose the row.
  it("leaves a failed job without a finish time, because it is between attempts", async () => {
    const { client, updates } = supabaseDouble();
    await finishJob(client, "job-1", { kind: "failed", error: "resend 503" }, NOW);
    expect(updates[0]?.patch).toEqual({
      status: "failed",
      last_error: "resend 503",
      finished_at: null,
    });
  });

  it("stamps a dead job, which is the DLQ view's row", async () => {
    const { client, updates } = supabaseDouble();
    await finishJob(client, "job-1", { kind: "dead", error: "payload failed schema validation" }, NOW);
    expect(updates[0]?.patch).toMatchObject({ status: "dead", finished_at: NOW.toISOString() });
  });

  // The work has already happened, so a failure to write the outcome must not
  // change what the route tells QStash.
  it("never throws", async () => {
    const broken = {
      from() {
        throw new Error("driver exploded");
      },
    } as unknown as SupabaseClient<Database>;
    await expect(finishJob(broken, "job-1", { kind: "succeeded" }, NOW)).resolves.toBeUndefined();
  });
});
