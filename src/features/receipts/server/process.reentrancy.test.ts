// @vitest-environment node
//
// Re-entrancy of the receipt pipeline: what has to hold before `processReceipt`
// may be put behind a queue that delivers at least once (doc 39's contract) and
// therefore delivers twice.
//
// These tests are deliberately NOT in process.test.ts. That suite's fake
// answers every write with `{data: null, error: null}`, which is the right
// shape for asserting WHICH writes a stage makes and in what order, and the
// wrong shape entirely for asserting who WON a race. The fake below is the
// other half: fewer stages exercised, but the receipts row is real state that
// conditional updates actually match against, so "exactly one worker proceeds"
// is a fact about the code rather than about the double.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  incr: () => Promise.resolve(1),
  expireNx: () => Promise.resolve(true),
  setNx: () => Promise.resolve(true),
  get: () => Promise.resolve(null),
}));

import type { Database } from "@/lib/supabase/types";

import { DEFAULT_RECEIPT_SETTINGS } from "./settings";
import type { ReceiptSettings } from "./settings";
import type { OcrProvider, OcrResponse } from "./ocr/provider";
import { processReceipt } from "./process";
import type { ProcessReceiptDeps, VelocityRedis } from "./process";

// ===========================================================================
// Fixtures
// ===========================================================================

const RECEIPT_ID = "01980000-0000-7000-8000-000000000001";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b1";
const CONSUMER_ID = "01980000-0000-7000-8000-0000000000c1";

/** 2026-07-25T04:00:00Z is noon in Asia/Manila. */
const NOW = new Date("2026-07-25T04:00:00.000Z");

const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR_MS).toISOString();
}

/** The same clean thermal slip process.test.ts uses: parses complete and
 * VAT-consistent, so the receipt auto-approves and the whole chain runs. */
const CLEAN_RECEIPT_TEXT = [
  "SARI SARI EXPRESS",
  "CEBU CITY BRANCH",
  "TIN 123-456-789-000",
  "OR# 0012345",
  "07/24/2026 13:45",
  "",
  "1  CHICKEN ADOBO           120.00     120.00",
  "2  GARLIC RICE              35.00      70.00",
  "",
  "VATABLE SALES                          169.64",
  "VAT (12%)                               20.36",
  "TOTAL                                  190.00",
  "",
  "THIS SERVES AS AN OFFICIAL RECEIPT",
].join("\n");

function ocrResponse(): OcrResponse {
  return {
    engine: "stub",
    engineVersion: "stub-v1",
    preprocessOps: ["stub"],
    rawText: CLEAN_RECEIPT_TEXT,
    blocks: [],
    meanConfidence: 0.95,
    durationMs: 1200,
  };
}

// ===========================================================================
// A fake Supabase whose receipts row is real state
// ===========================================================================

interface FakeOp {
  table: string;
  op: "select" | "insert" | "update";
  columns: string;
  payload: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
  single: boolean;
}

interface FakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

type ReceiptRecord = Record<string, unknown>;

/**
 * Evaluate the PostgREST filters this pipeline actually builds against one
 * in-memory row. Only the operators the claim uses are implemented, because
 * only the claim's predicate decides anything here.
 */
function rowMatches(row: ReceiptRecord, filters: FakeOp["filters"]): boolean {
  for (const filter of filters) {
    const [column, second, third] = filter.args as [string, unknown, unknown];
    if (filter.method === "eq") {
      if (row[column] !== second) return false;
      continue;
    }
    if (filter.method === "not" && second === "gt") {
      const left = Date.parse(String(row[column] ?? ""));
      const right = Date.parse(String(third));
      // not(x > t) is x <= t. An unparseable left side cannot satisfy it.
      if (!Number.isFinite(left) || left > right) return false;
      continue;
    }
  }
  return true;
}

interface World {
  receipt: ReceiptRecord | null;
  ocrAttempts: Array<{ attempt: number }>;
}

interface FakeSupabase {
  client: SupabaseClient<Database>;
  ops: FakeOp[];
  rpcCalls: Array<{ name: string; args: unknown }>;
  opsFor(table: string, op: FakeOp["op"]): FakeOp[];
  insertedRows(table: string): Record<string, unknown>[];
}

function createFakeSupabase(world: World, clock: () => Date): FakeSupabase {
  const ops: FakeOp[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const respond = (op: FakeOp): FakeResult => {
    const ok = (data: unknown): FakeResult => ({ data, error: null });

    if (op.op === "update" && op.table === "receipts") {
      const row = world.receipt;
      if (row === null || !rowMatches(row, op.filters)) return ok([]);
      Object.assign(row, op.payload as ReceiptRecord);
      // The touch_receipts trigger (0017) stamps updated_at on every update,
      // whatever the statement said, so the fake stamps it last.
      row.updated_at = clock().toISOString();
      return ok([{ id: row.id }]);
    }

    if (op.op !== "select") return ok(null);

    switch (op.table) {
      case "receipts":
        if (op.columns.startsWith("id, business_id")) {
          return ok(world.receipt === null ? null : { ...world.receipt });
        }
        return ok([]);
      case "ocr_results":
        return ok(world.ocrAttempts);
      case "businesses":
        return ok({
          id: BUSINESS_ID,
          name: "Sari Sari Express",
          verified_at: "2026-01-01T00:00:00.000Z",
        });
      case "business_customers":
        return ok({ segment: "regular", visit_count: 3 });
      case "points_rules":
        return ok([]);
      case "consumers":
        return ok({ scan_blocked_until: null });
      default:
        return ok([]);
    }
  };

  class FakeQuery implements PromiseLike<FakeResult> {
    readonly op: FakeOp = {
      table: "",
      op: "select",
      columns: "*",
      payload: undefined,
      filters: [],
      single: false,
    };

    constructor(table: string) {
      this.op.table = table;
    }

    select(columns?: string): this {
      this.op.columns = columns ?? "*";
      return this;
    }
    insert(payload: unknown): this {
      this.op.op = "insert";
      this.op.payload = payload;
      return this;
    }
    update(payload: unknown): this {
      this.op.op = "update";
      this.op.payload = payload;
      return this;
    }
    private filter(method: string, ...args: unknown[]): this {
      this.op.filters.push({ method, args });
      return this;
    }
    eq(column: string, value: unknown): this {
      return this.filter("eq", column, value);
    }
    neq(column: string, value: unknown): this {
      return this.filter("neq", column, value);
    }
    in(column: string, values: unknown[]): this {
      return this.filter("in", column, values);
    }
    is(column: string, value: unknown): this {
      return this.filter("is", column, value);
    }
    not(column: string, operator: string, value: unknown): this {
      return this.filter("not", column, operator, value);
    }
    gte(column: string, value: unknown): this {
      return this.filter("gte", column, value);
    }
    order(column: string, options?: unknown): this {
      return this.filter("order", column, options);
    }
    limit(count: number): this {
      return this.filter("limit", count);
    }
    maybeSingle(): this {
      this.op.single = true;
      return this;
    }
    single(): this {
      this.op.single = true;
      return this;
    }

    then<TResult1 = FakeResult, TResult2 = never>(
      onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve()
        .then(() => {
          ops.push(this.op);
          const result = respond(this.op);
          if (!this.op.single || result.error !== null) return result;
          const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
          return { data, error: null };
        })
        .then(onFulfilled, onRejected);
    }
  }

  const client = {
    from: (table: string) => new FakeQuery(table),
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve({
            data: { signedUrl: "https://signed.example/receipt.jpg" },
            error: null,
          }),
      }),
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: "ledger-row-id", error: null });
    },
  };

  return {
    client: client as unknown as SupabaseClient<Database>,
    ops,
    rpcCalls,
    opsFor: (table, op) => ops.filter((entry) => entry.table === table && entry.op === op),
    insertedRows: (table) =>
      ops
        .filter((entry) => entry.table === table && entry.op === "insert")
        .flatMap((entry) =>
          Array.isArray(entry.payload)
            ? (entry.payload as Record<string, unknown>[])
            : [entry.payload as Record<string, unknown>],
        ),
  };
}

// ===========================================================================
// A fake Redis that actually stores things
// ===========================================================================

function createFakeRedis(options: { throws?: boolean } = {}) {
  const store = new Map<string, string>();
  const boom = () => Promise.reject(new Error("redis down"));

  const incr = vi.fn((key: string) => {
    if (options.throws === true) return boom();
    const next = Number(store.get(key) ?? "0") + 1;
    store.set(key, String(next));
    return Promise.resolve(next);
  });
  const expireNx = vi.fn(() =>
    options.throws === true ? boom() : Promise.resolve(true),
  );
  const setNx = vi.fn((key: string) => {
    if (options.throws === true) return boom();
    if (store.has(key)) return Promise.resolve(false);
    store.set(key, "1");
    return Promise.resolve(true);
  });
  const get = vi.fn((key: string) =>
    options.throws === true ? boom() : Promise.resolve(store.get(key) ?? null),
  );

  // The port the pipeline sees, kept beside the mocks rather than being them,
  // so `VelocityRedis` is genuinely satisfied and the spies stay callable.
  const port: VelocityRedis = { incr, expireNx, setNx, get };

  return { store, port, incr, expireNx, setNx, get };
}

type FakeRedis = ReturnType<typeof createFakeRedis>;

// ===========================================================================
// Harness
// ===========================================================================

function queuedReceipt(overrides: ReceiptRecord = {}): ReceiptRecord {
  return {
    id: RECEIPT_ID,
    business_id: BUSINESS_ID,
    user_id: CONSUMER_ID,
    status: "queued",
    image_path: `${CONSUMER_ID}/photo.jpg`,
    image_hash: "0f1e2d3c4b5a6978",
    device_id: null,
    created_at: "2026-07-25T03:55:00.000Z",
    updated_at: "2026-07-25T03:55:00.000Z",
    ...overrides,
  };
}

interface Harness {
  world: World;
  supabase: FakeSupabase;
  redis: FakeRedis;
  deps: ProcessReceiptDeps;
  ocr: ReturnType<typeof vi.fn>;
  velocityKeys(): string[];
}

function createHarness(
  input: { receipt?: ReceiptRecord; redis?: FakeRedis; settings?: Partial<ReceiptSettings> } = {},
): Harness {
  const world: World = {
    receipt: input.receipt ?? queuedReceipt(),
    ocrAttempts: [],
  };
  const supabase = createFakeSupabase(world, () => NOW);
  const redis = input.redis ?? createFakeRedis();
  const ocr = vi.fn(() => Promise.resolve(ocrResponse()));
  const provider: OcrProvider = { name: "stub", ocr };
  const settings: ReceiptSettings = { ...DEFAULT_RECEIPT_SETTINGS, ...input.settings };

  return {
    world,
    supabase,
    redis,
    ocr,
    deps: {
      supabase: supabase.client,
      ocr: provider,
      loadSettings: () => Promise.resolve(settings),
      redis: redis.port,
      now: () => NOW,
    },
    velocityKeys: () =>
      [...redis.store.keys()].filter((key) => key.includes(":velocity:")),
  };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Fix 1 - velocity counts a submission, not a pass
// ===========================================================================

describe("velocity counters (doc 37 S4) count submissions, not processing passes", () => {
  it("leaves every window unmoved when the same receipt is processed twice", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    const windows = harness.velocityKeys();
    // Four windows: the two consumer ones and the two pair ones. No device_id
    // on this submission, so device_day is not counted at all.
    expect(windows).toHaveLength(4);
    expect(windows.some((key) => key.includes("consumer_hour"))).toBe(true);
    expect(windows.some((key) => key.includes("pair_10min"))).toBe(true);
    expect(windows.some((key) => key.includes("device_day"))).toBe(false);
    const afterFirstPass = windows.map((key) => harness.redis.store.get(key));
    expect(afterFirstPass).toEqual(["1", "1", "1", "1"]);

    const incrCallsAfterFirstPass = harness.redis.incr.mock.calls.length;

    // THE REDELIVERY. The receipt is put back the way a retryable OCR failure
    // leaves it - parked at 'processing' - and abandoned long enough that this
    // invocation is entitled to reclaim it, so the whole pipeline runs a second
    // time over the SAME submission.
    harness.world.receipt = queuedReceipt({
      status: "processing",
      updated_at: hoursAgo(30),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    // The second pass reached the fraud stage...
    expect(harness.ocr).toHaveBeenCalledTimes(2);
    // ...and moved nothing. Same four keys, same four values.
    expect(harness.velocityKeys()).toEqual(windows);
    expect(windows.map((key) => harness.redis.store.get(key))).toEqual([
      "1",
      "1",
      "1",
      "1",
    ]);
    expect(harness.redis.incr.mock.calls.length).toBe(incrCallsAfterFirstPass);
  });

  it("reads the windows back on the second pass rather than going blind", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);
    harness.world.receipt = queuedReceipt({
      status: "processing",
      updated_at: hoursAgo(30),
    });
    harness.redis.get.mockClear();

    await processReceipt(RECEIPT_ID, harness.deps);

    // Every window the first pass incremented is GET on the second, so the
    // fraud stage still evaluates against real counts.
    const read = harness.redis.get.mock.calls.map((call) => String(call[0]));
    for (const key of harness.velocityKeys()) {
      expect(read).toContain(key);
    }
  });

  it("still counts the first pass when the marker cannot be claimed", async () => {
    // A Redis that answers INCR but not SET NX (or answers it with an error):
    // the pass must count rather than silently stop counting, because a
    // suppressed counter is a blind spot an abuser could open on demand.
    const redis = createFakeRedis();
    redis.setNx.mockImplementation(() => Promise.reject(new Error("nope")));
    const harness = createHarness({ redis });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.velocityKeys()).toHaveLength(4);
  });

  it("completes the scan and manufactures no signal when Redis is down", async () => {
    const harness = createHarness({ redis: createFakeRedis({ throws: true }) });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.world.receipt?.status).toBe("approved");
    expect(harness.supabase.rpcCalls).toHaveLength(0); // no base rule, so no award
    expect(harness.supabase.insertedRows("fraud_signals")).toHaveLength(0);
  });
});

// ===========================================================================
// Fix 2 - a real compare-and-swap claim
// ===========================================================================

describe("the status claim is a compare-and-swap", () => {
  it("lets exactly one of two concurrent workers proceed", async () => {
    const harness = createHarness();

    await Promise.all([
      processReceipt(RECEIPT_ID, harness.deps),
      processReceipt(RECEIPT_ID, harness.deps),
    ]);

    // The loser wrote NOTHING: one OCR call, one evidence row, one meter row.
    expect(harness.ocr).toHaveBeenCalledTimes(1);
    expect(harness.supabase.insertedRows("ocr_results")).toHaveLength(1);
    expect(harness.supabase.insertedRows("ai_usage_events")).toHaveLength(1);

    // BOTH workers issued the claim - that is the point of folding the expected
    // status into the WHERE clause rather than checking it in memory - and the
    // database let exactly one of them through, so exactly one terminal write
    // followed.
    const updates = harness.supabase.opsFor("receipts", "update");
    const claims = updates.filter(
      (op) => (op.payload as Record<string, unknown>).status === "processing",
    );
    const terminal = updates.filter(
      (op) => (op.payload as Record<string, unknown>).status === "approved",
    );
    expect(claims).toHaveLength(2);
    expect(terminal).toHaveLength(1);
    expect(harness.world.receipt?.status).toBe("approved");
  });

  it("refuses the claim when the row is no longer 'queued'", async () => {
    const harness = createHarness();
    // Somebody else won between our load and our update: the fake's row is
    // already 'processing' and freshly touched, so the conditional UPDATE
    // matches nothing.
    harness.world.receipt = queuedReceipt({
      status: "processing",
      updated_at: NOW.toISOString(),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.ocr).not.toHaveBeenCalled();
    expect(harness.supabase.opsFor("receipts", "update")).toHaveLength(0);
    expect(harness.supabase.insertedRows("ocr_results")).toHaveLength(0);
    expect(harness.supabase.insertedRows("ai_usage_events")).toHaveLength(0);
  });
});

describe("a 'processing' receipt is reclaimable only once it is stale", () => {
  it("leaves a freshly claimed receipt to the worker that holds it", async () => {
    const harness = createHarness({
      receipt: queuedReceipt({ status: "processing", updated_at: hoursAgo(1) }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.ocr).not.toHaveBeenCalled();
    expect(harness.supabase.opsFor("receipts", "update")).toHaveLength(0);
    expect(harness.supabase.insertedRows("ocr_results")).toHaveLength(0);
  });

  it("reclaims one abandoned past receipts.stuck_processing_hours", async () => {
    const harness = createHarness({
      receipt: queuedReceipt({ status: "processing", updated_at: hoursAgo(25) }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.ocr).toHaveBeenCalledTimes(1);
    // The reclaim renews the lease rather than re-writing a status the row
    // already carries, and it is guarded by the staleness predicate itself.
    const lease = harness.supabase.opsFor("receipts", "update")[0];
    expect(lease?.payload).toEqual({ updated_at: NOW.toISOString() });
    expect(lease?.filters).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["status", "processing"] },
        { method: "not", args: ["updated_at", "gt", hoursAgo(24)] },
      ]),
    );
    expect(harness.world.receipt?.status).toBe("approved");
  });

  it("uses the same threshold the 0028 sweep uses, tuned or not", async () => {
    // stuck_processing_hours lowered to 2: a receipt idle for 3 hours is now
    // abandoned, where the platform default would still call it live.
    const harness = createHarness({
      receipt: queuedReceipt({ status: "processing", updated_at: hoursAgo(3) }),
      settings: { stuckProcessingHours: 2 },
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.ocr).toHaveBeenCalledTimes(1);
  });

  it("never throws, whichever way the claim goes", async () => {
    const harness = createHarness({
      receipt: queuedReceipt({ status: "processing", updated_at: hoursAgo(1) }),
    });

    await expect(processReceipt(RECEIPT_ID, harness.deps)).resolves.toBeUndefined();
  });
});
