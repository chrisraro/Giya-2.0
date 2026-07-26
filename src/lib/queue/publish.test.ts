// @vitest-environment node
//
// Two properties, and everything here serves one of them.
//
//   1. THE ORDER. The job row is written before the message is published, so a
//      QStash outage leaves durable, recoverable state rather than lost work.
//   2. THE SWALLOW. `enqueue` never throws, whatever happens, because every
//      caller has already committed the thing it is scheduling work about.
//
// The Supabase client is a hand-built double rather than a mock library: the
// PostgREST builder is a chain of thenable methods, and asserting against a
// recorded call list is both clearer and less likely to pass for the wrong
// reason than matcher gymnastics.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { enqueue } from "./publish";

const ENV = {
  QSTASH_URL: "https://qstash-us-east-1.upstash.io",
  QSTASH_TOKEN: "token-for-tests",
  QSTASH_CALLBACK_ORIGIN: "https://giya.example",
};

vi.mock("@/lib/env", () => ({
  env: {},
  getServerEnv: () => ({
    QSTASH_URL: "https://qstash-us-east-1.upstash.io",
    QSTASH_TOKEN: "token-for-tests",
    QSTASH_CALLBACK_ORIGIN: "https://giya.example",
  }),
}));

interface InsertCall {
  readonly table: string;
  readonly row: Record<string, unknown>;
}

interface UpdateCall {
  readonly table: string;
  readonly patch: Record<string, unknown>;
}

interface DoubleOptions {
  readonly insertError?: { code: string; message: string } | null;
  readonly existingJobId?: string | null;
  readonly insertThrows?: boolean;
}

function supabaseDouble(options: DoubleOptions = {}) {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];

  const client = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          if (options.insertThrows === true) {
            throw new Error("driver exploded");
          }
          return {
            select: () => ({
              single: async () =>
                options.insertError
                  ? { data: null, error: options.insertError }
                  : { data: { id: "job-1" }, error: null },
            }),
          };
        },
        select() {
          // The dedupe read-back.
          const chain = {
            eq: () => chain,
            in: () => chain,
            maybeSingle: async () => ({
              data:
                options.existingJobId === undefined || options.existingJobId === null
                  ? null
                  : { id: options.existingJobId },
              error: null,
            }),
          };
          return chain;
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, patch });
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  } as unknown as SupabaseClient<Database>;

  return { client, inserts, updates };
}

function fetchOk(messageId = "msg_0001"): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ messageId }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enqueue writes the row before it publishes", () => {
  it("inserts a queued job carrying the queue's own attempt budget", async () => {
    const { client, inserts } = supabaseDouble();
    const result = await enqueue({
      queue: "notify.email",
      payload: { notification_ids: ["n1"] },
      businessId: "biz-1",
      dedupeKey: "n1",
      supabase: client,
      fetchImpl: fetchOk(),
    });

    expect(result).toEqual({
      status: "enqueued",
      jobId: "job-1",
      published: true,
      messageId: "msg_0001",
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.row).toMatchObject({
      queue: "notify.email",
      status: "queued",
      business_id: "biz-1",
      dedupe_key: "n1",
      // Doc 39's default of 5 total attempts for this queue.
      max_attempts: 5,
    });
  });

  // The job id is the ROW's own primary key, so storing it in the payload as
  // well would let the two disagree. It belongs only in the published body,
  // where the worker needs it to claim the row.
  it("keeps job_id out of the stored payload and puts it in the published body", async () => {
    const { client, inserts } = supabaseDouble();
    const doFetch = fetchOk();
    await enqueue({
      queue: "notify.email",
      payload: { notification_ids: ["n1"] },
      supabase: client,
      fetchImpl: doFetch,
    });

    expect(inserts[0]?.row.payload).toEqual({ notification_ids: ["n1"] });

    const [, init] = vi.mocked(doFetch).mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      job_id: "job-1",
      notification_ids: ["n1"],
    });
  });

  // THE PROPERTY THIS MODULE EXISTS FOR. A publish that fails is not an enqueue
  // that failed: the row is there, it is queued, and doc 39's reconciler
  // re-publishes exactly this shape.
  it("still reports success when QStash cannot be reached", async () => {
    const { client, inserts, updates } = supabaseDouble();
    const result = await enqueue({
      queue: "notify.email",
      payload: {},
      supabase: client,
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    expect(result).toEqual({
      status: "enqueued",
      jobId: "job-1",
      published: false,
      messageId: null,
    });
    expect(inserts).toHaveLength(1);
    // No message id was recorded, which is the predicate the reconciler scans
    // for. Recording one would hide the job from the only thing that can save it.
    expect(updates).toHaveLength(0);
  });

  it("reports the row as unpublished when QStash refuses the message", async () => {
    const { client } = supabaseDouble();
    const result = await enqueue({
      queue: "notify.email",
      payload: {},
      supabase: client,
      fetchImpl: vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ status: "enqueued", published: false });
  });

  it("treats an unreadable QStash body as unpublished rather than published", async () => {
    const { client } = supabaseDouble();
    const result = await enqueue({
      queue: "notify.email",
      payload: {},
      supabase: client,
      fetchImpl: vi.fn(async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ published: false });
  });

  it("records the message id so the DLQ can be correlated", async () => {
    const { client, updates } = supabaseDouble();
    await enqueue({
      queue: "notify.email",
      payload: {},
      supabase: client,
      fetchImpl: fetchOk("msg_abc"),
    });
    expect(updates).toEqual([{ table: "jobs", patch: { qstash_message_id: "msg_abc" } }]);
  });
});

describe("enqueue publishes the way doc 39 specifies", () => {
  it("publishes to the regional base against the callback destination", async () => {
    const { client } = supabaseDouble();
    const doFetch = fetchOk();
    await enqueue({
      queue: "notify.email",
      payload: {},
      supabase: client,
      fetchImpl: doFetch,
    });

    const [url] = vi.mocked(doFetch).mock.calls[0] ?? [];
    expect(url).toBe(
      `${ENV.QSTASH_URL}/v2/publish/${ENV.QSTASH_CALLBACK_ORIGIN}/api/jobs/notify.email`,
    );
  });

  // Doc 39: "retries on publish = jobs.max_attempts - 1". Off by one in either
  // direction and jobs.max_attempts stops meaning what the DLQ view says.
  it("asks for one fewer retry than the row budgets attempts", async () => {
    const { client } = supabaseDouble();
    const doFetch = fetchOk();
    await enqueue({ queue: "notify.email", payload: {}, supabase: client, fetchImpl: doFetch });

    const [, init] = vi.mocked(doFetch).mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    expect(headers["Upstash-Retries"]).toBe("4");
  });

  it("sends the per-tenant flow-control key so one business cannot starve another", async () => {
    const { client } = supabaseDouble();
    const doFetch = fetchOk();
    await enqueue({
      queue: "notify.email",
      payload: {},
      businessId: "biz-9",
      supabase: client,
      fetchImpl: doFetch,
    });

    const [, init] = vi.mocked(doFetch).mock.calls[0] ?? [];
    const headers = init?.headers as Record<string, string>;
    // A dot, not doc 39's colon: QStash refuses a colon outright. See
    // queues.ts's flowControlKey.
    expect(headers["Upstash-Flow-Control-Key"]).toBe("email.biz-9");
    expect(headers["Upstash-Flow-Control-Value"]).toBe("rate=10");
  });

  it("omits the delay header when there is no delay", async () => {
    const { client } = supabaseDouble();
    const doFetch = fetchOk();
    await enqueue({ queue: "notify.email", payload: {}, supabase: client, fetchImpl: doFetch });
    const [, init] = vi.mocked(doFetch).mock.calls[0] ?? [];
    expect(init?.headers as Record<string, string>).not.toHaveProperty("Upstash-Delay");
  });

  it("carries a delay through to both the row and the message", async () => {
    const { client, inserts } = supabaseDouble();
    const doFetch = fetchOk();
    await enqueue({
      queue: "notify.email",
      payload: {},
      delaySeconds: 90,
      supabase: client,
      fetchImpl: doFetch,
    });

    const [, init] = vi.mocked(doFetch).mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>)["Upstash-Delay"]).toBe("90s");
    // scheduled_at is what the "age of oldest queued job" metric measures from,
    // so a delayed job must not look overdue the moment it is written.
    expect(new Date(String(inserts[0]?.row.scheduled_at)).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("enqueue deduplicates", () => {
  // Doc 39 step 1: an in-flight job already owns this key, so return it rather
  // than publishing a second message for the same work.
  it("reports a unique violation as a deduplication, not a failure", async () => {
    const { client, updates } = supabaseDouble({
      insertError: { code: "23505", message: 'duplicate key value violates unique constraint "jobs_dedupe_idx"' },
      existingJobId: "job-existing",
    });
    const doFetch = fetchOk();

    const result = await enqueue({
      queue: "notify.email",
      payload: {},
      dedupeKey: "n1",
      supabase: client,
      fetchImpl: doFetch,
    });

    expect(result).toEqual({ status: "deduplicated", jobId: "job-existing" });
    // The important half: nothing was published, so the work is not scheduled
    // twice.
    expect(doFetch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("still deduplicates when the conflicting job finished before it could be read", async () => {
    const { client } = supabaseDouble({
      insertError: { code: "23505", message: "duplicate" },
      existingJobId: null,
    });
    const result = await enqueue({
      queue: "notify.email",
      payload: {},
      dedupeKey: "n1",
      supabase: client,
      fetchImpl: fetchOk(),
    });
    expect(result).toEqual({ status: "deduplicated", jobId: null });
  });
});

describe("enqueue never throws", () => {
  it("reports a failure rather than throwing when the row cannot be written", async () => {
    const { client } = supabaseDouble({
      insertError: { code: "42501", message: "permission denied" },
    });
    const result = await enqueue({
      queue: "notify.email",
      payload: {},
      supabase: client,
      fetchImpl: fetchOk(),
    });
    expect(result).toEqual({ status: "failed", reason: "permission denied" });
  });

  it("swallows a driver that throws outright", async () => {
    const { client } = supabaseDouble({ insertThrows: true });
    await expect(
      enqueue({ queue: "notify.email", payload: {}, supabase: client, fetchImpl: fetchOk() }),
    ).resolves.toEqual({ status: "failed", reason: "unexpected failure" });
  });

  // The degraded path createServiceRoleClient documents. Publishing anyway
  // would create a message for a job row that does not exist, which is the one
  // ordering failure this module exists to avoid.
  it("refuses to publish when there is no service-role client", async () => {
    const doFetch = fetchOk();
    const result = await enqueue({
      queue: "notify.email",
      payload: {},
      supabase: null,
      fetchImpl: doFetch,
    });
    expect(result).toEqual({ status: "failed", reason: "no service-role client" });
    expect(doFetch).not.toHaveBeenCalled();
  });
});
