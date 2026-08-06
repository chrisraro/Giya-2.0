// @vitest-environment node
//
// Doc 39: "Heartbeat (long jobs only) ... refreshed every 20s." A claimed job
// that runs longer than a minute needs `jobs.heartbeat_at` moving forward
// while its handler is still alive, or `claim.ts`'s `isStale` cannot tell a
// worker 90 healthy seconds into an OCR call from one that died at second 3.
//
// Every test here uses `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`
// - nothing sleeps for real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { HEARTBEAT_INTERVAL_MS, startHeartbeat } from "./heartbeat";

interface UpdateCall {
  readonly patch: Record<string, unknown>;
  readonly filters: Record<string, unknown>;
}

interface DoubleResult {
  readonly data: { id: string } | null;
  readonly error: { message: string } | null;
}

interface DoubleOptions {
  /** One result per call to the update chain; the last entry repeats after
   * the list is exhausted. */
  readonly results?: readonly DoubleResult[];
  /** If set, the update chain rejects instead of resolving. */
  readonly throws?: unknown;
}

function supabaseDouble(options: DoubleOptions = {}) {
  const calls: UpdateCall[] = [];
  const results = options.results ?? [{ data: { id: JOB_ID }, error: null }];
  let callIndex = 0;

  const client = {
    from() {
      return {
        update(patch: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            select: () => ({
              maybeSingle: async () => {
                calls.push({ patch, filters });
                if (options.throws !== undefined) {
                  throw options.throws;
                }
                const result = results[Math.min(callIndex, results.length - 1)];
                callIndex += 1;
                return result;
              },
            }),
          };
          return chain;
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient<Database>, calls };
}

const JOB_ID = "0198f0a1-0000-7000-8000-000000000001";
const ATTEMPTS = 1;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startHeartbeat", () => {
  it("refreshes heartbeat_at on the interval, matching the claim's ownership predicate", async () => {
    const { client, calls } = supabaseDouble();
    const fixedNow = new Date("2026-08-06T00:00:20.000Z");
    const heartbeat = startHeartbeat({
      supabase: client,
      jobId: JOB_ID,
      attempts: ATTEMPTS,
      now: () => fixedNow,
    });

    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.patch).toEqual({ heartbeat_at: fixedNow.toISOString() });
    expect(calls[0]?.filters).toEqual({ id: JOB_ID, attempts: ATTEMPTS, status: "running" });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls).toHaveLength(2);

    heartbeat.stop();
  });

  it("stops refreshing once stop() is called after success", async () => {
    const { client, calls } = supabaseDouble();
    const heartbeat = startHeartbeat({ supabase: client, jobId: JOB_ID, attempts: ATTEMPTS });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls).toHaveLength(1);

    heartbeat.stop();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(calls).toHaveLength(1);
  });

  it("stops refreshing once stop() is called from a finally after the handler throws", async () => {
    const { client, calls } = supabaseDouble();
    const heartbeat = startHeartbeat({ supabase: client, jobId: JOB_ID, attempts: ATTEMPTS });

    async function handler(): Promise<void> {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
      throw new Error("handler blew up");
    }

    await expect(
      (async () => {
        try {
          await handler();
        } finally {
          heartbeat.stop();
        }
      })(),
    ).rejects.toThrow("handler blew up");

    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
    expect(calls).toHaveLength(1);
  });

  it("does not fire at all once stopped before the first interval elapses", async () => {
    const { client, calls } = supabaseDouble();
    const heartbeat = startHeartbeat({ supabase: client, jobId: JOB_ID, attempts: ATTEMPTS });

    heartbeat.stop();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    expect(calls).toHaveLength(0);
  });

  it("stop() is idempotent", () => {
    const { client } = supabaseDouble();
    const heartbeat = startHeartbeat({ supabase: client, jobId: JOB_ID, attempts: ATTEMPTS });
    heartbeat.stop();
    expect(() => heartbeat.stop()).not.toThrow();
  });

  it("stops itself silently once ownership is lost to a legitimate reclaim", async () => {
    const { client, calls } = supabaseDouble({
      results: [
        { data: { id: JOB_ID }, error: null },
        { data: null, error: null }, // 0 rows: attempts no longer matches this invocation
        { data: { id: JOB_ID }, error: null },
      ],
    });
    const heartbeat = startHeartbeat({ supabase: client, jobId: JOB_ID, attempts: ATTEMPTS });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); // 1st tick: still owned
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); // 2nd tick: lease lost
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3); // no further attempts
    expect(calls).toHaveLength(2);

    heartbeat.stop();
  });

  it("logs and keeps ticking when a refresh returns a database error", async () => {
    const { client, calls } = supabaseDouble({
      results: [{ data: null, error: { message: "connection reset" } }],
    });
    const heartbeat = startHeartbeat({ supabase: client, jobId: JOB_ID, attempts: ATTEMPTS });

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();

    // A refresh ERROR is not a lost lease - it keeps trying on the next tick.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls).toHaveLength(2);

    heartbeat.stop();
  });

  it("does not throw and keeps ticking when the update call rejects unexpectedly", async () => {
    const { client, calls } = supabaseDouble({ throws: new Error("network down") });
    const heartbeat = startHeartbeat({ supabase: client, jobId: JOB_ID, attempts: ATTEMPTS });

    // The point of this test: advancing past the rejecting tick must not
    // itself throw or leave an unhandled rejection.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(calls).toHaveLength(2);

    heartbeat.stop();
  });
});
