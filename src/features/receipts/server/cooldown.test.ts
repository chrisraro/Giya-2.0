// @vitest-environment node
//
// The automatic half of doc 37's consequences ladder step 2: strike-counting,
// the never-shorten rule, and - the piece this file exists to pin - the
// system-actor `audit_logs` row `applyCooldownIfEarned` now writes once the
// block lands. `review.test.ts` and `process.test.ts` exercise this function
// through its two real callers; this file exercises it directly so the audit
// row's exact shape is asserted in one place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import type { Database } from "@/lib/supabase/types";

import { applyCooldownIfEarned } from "./cooldown";
import type { CooldownDeps, CooldownSettings } from "./cooldown";

// ===========================================================================
// A minimal fake Supabase client, same shape as review.test.ts / process.test.ts.
// ===========================================================================

interface FakeError {
  message: string;
}

interface FakeOp {
  table: string;
  op: "select" | "insert" | "update";
  payload: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
  single: boolean;
}

interface FakeResult {
  data: unknown;
  error: FakeError | null;
}

type Responder = (op: FakeOp) => FakeResult;

class FakeQuery implements PromiseLike<FakeResult> {
  readonly op: FakeOp;

  constructor(
    table: string,
    private readonly respond: Responder,
    private readonly record: (op: FakeOp) => void,
  ) {
    this.op = { table, op: "select", payload: undefined, filters: [], single: false };
  }

  select(): this {
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
  in(column: string, values: unknown[]): this {
    return this.filter("in", column, values);
  }
  gte(column: string, value: unknown): this {
    return this.filter("gte", column, value);
  }
  limit(count: number): this {
    return this.filter("limit", count);
  }
  maybeSingle(): this {
    this.op.single = true;
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => {
        this.record(this.op);
        const result = this.respond(this.op);
        if (!this.op.single) return result;
        if (result.error !== null) return result;
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { data, error: null };
      })
      .then(onFulfilled, onRejected);
  }
}

interface World {
  /** Rows the strike-count read sees (the just-rejected receipt included). */
  fraudRejections: Array<{ id: string }>;
  scanBlockedUntil: string | null;
  auditError: FakeError | null;
}

function createWorld(overrides: Partial<World> = {}): World {
  return { fraudRejections: [], scanBlockedUntil: null, auditError: null, ...overrides };
}

function worldResponder(world: World): Responder {
  return (op) => {
    const ok = (data: unknown): FakeResult => ({ data, error: null });

    if (op.table === "receipts" && op.op === "select") return ok(world.fraudRejections);
    if (op.table === "consumers" && op.op === "select") {
      return ok({ scan_blocked_until: world.scanBlockedUntil });
    }
    if (op.table === "consumers" && op.op === "update") return ok(null);
    if (op.table === "audit_logs" && op.op === "insert") {
      return world.auditError === null ? ok(null) : { data: null, error: world.auditError };
    }
    return ok(null);
  };
}

function createHarness(world: World = createWorld()) {
  const ops: FakeOp[] = [];
  const respond = worldResponder(world);
  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
  };
  return {
    ops,
    auditRows: () => ops.filter((op) => op.table === "audit_logs" && op.op === "insert"),
    consumerUpdates: () => ops.filter((op) => op.table === "consumers" && op.op === "update"),
    deps: { supabase: client as unknown as SupabaseClient<Database>, now: () => NOW } as CooldownDeps,
  };
}

const CONSUMER_ID = "01980000-0000-7000-8000-0000000000c1";
const REQUEST_ID = "req_01980000";
const NOW = new Date("2026-07-25T04:00:00.000Z");

const SETTINGS: CooldownSettings = { cooldownStrikes: 3, cooldownHours: 24 };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyCooldownIfEarned: the audit row", () => {
  it("writes exactly one system-actor audit row when the block lands", async () => {
    const harness = createHarness(
      createWorld({ fraudRejections: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] }),
    );

    await applyCooldownIfEarned(harness.deps, CONSUMER_ID, SETTINGS, REQUEST_ID);

    const rows = harness.auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]?.payload as Record<string, unknown>;
    expect(row).toMatchObject({
      actor_id: null,
      actor_kind: "system",
      actor_role: null,
      business_id: null,
      action: "fraud.cooldown_applied",
      entity_type: "consumer",
      entity_id: CONSUMER_ID,
      reason: null,
      request_id: REQUEST_ID,
    });
    // The dot-namespaced shape 0022's `audit_logs_action_shape` requires.
    expect(row.action as string).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    // 0022's `audit_logs_admin_reason_required` is scoped to actor_kind='admin'
    // alone, so a null reason on this system-actor row is already legal - this
    // is the fact the task brief asked to be verified rather than re-derived.
    expect(row.reason).toBeNull();
    expect(row.after).toMatchObject({
      scan_blocked_until: new Date(NOW.getTime() + 24 * 3_600_000).toISOString(),
      hours: 24,
      strikes: 3,
    });
    expect(row.before).toEqual({ scan_blocked_until: null });
  });

  it("carries forward the PREVIOUS block in `before`, not null, on a re-strike", async () => {
    const previous = new Date(NOW.getTime() + 5 * 3_600_000).toISOString();
    const harness = createHarness(
      createWorld({
        fraudRejections: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
        scanBlockedUntil: previous,
      }),
    );

    await applyCooldownIfEarned(harness.deps, CONSUMER_ID, SETTINGS, REQUEST_ID);

    // 24h from now is later than the existing 5h block, so it is NOT the
    // never-shorten case: the write proceeds and `before` records the truth.
    const row = harness.auditRows()[0]?.payload as Record<string, unknown>;
    expect(row.before).toEqual({ scan_blocked_until: previous });
  });

  it("defaults request_id to null when the caller supplies none (the pipeline's own shape)", async () => {
    const harness = createHarness(
      createWorld({ fraudRejections: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] }),
    );

    // No fourth argument - `process.ts`'s call site, which has no request
    // context to give.
    await applyCooldownIfEarned(harness.deps, CONSUMER_ID, SETTINGS);

    const row = harness.auditRows()[0]?.payload as Record<string, unknown>;
    expect(row.request_id).toBeNull();
  });

  it("writes no audit row when the strike threshold is not reached", async () => {
    const harness = createHarness(createWorld({ fraudRejections: [{ id: "r1" }] }));

    await applyCooldownIfEarned(harness.deps, CONSUMER_ID, SETTINGS, REQUEST_ID);

    expect(harness.auditRows()).toHaveLength(0);
    expect(harness.consumerUpdates()).toHaveLength(0);
  });

  it("writes no audit row when an existing longer block is not shortened", async () => {
    const longerBlock = new Date(NOW.getTime() + 72 * 3_600_000).toISOString();
    const harness = createHarness(
      createWorld({
        fraudRejections: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
        scanBlockedUntil: longerBlock,
      }),
    );

    await applyCooldownIfEarned(harness.deps, CONSUMER_ID, SETTINGS, REQUEST_ID);

    expect(harness.consumerUpdates()).toHaveLength(0);
    expect(harness.auditRows()).toHaveLength(0);
  });

  it("is best-effort: a failed audit insert does not undo the cooldown, and does not throw", async () => {
    const harness = createHarness(
      createWorld({
        fraudRejections: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
        auditError: { message: "audit_logs is append-only" },
      }),
    );

    await expect(
      applyCooldownIfEarned(harness.deps, CONSUMER_ID, SETTINGS, REQUEST_ID),
    ).resolves.toBeUndefined();

    // The block itself already landed and is never reverted by this module -
    // no second write to `consumers` undoes it.
    expect(harness.consumerUpdates()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("could not audit the cooldown"),
      expect.anything(),
    );
  });
});
