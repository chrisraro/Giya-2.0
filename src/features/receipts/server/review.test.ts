// @vitest-environment node
//
// The human review service (doc 36 Stage 9, doc 37 S9, spec section 4).
//
// This is a money path and an insider-control path, so what is pinned here is
// not "the happy path works" but the GUARD ORDER, the two-manager race, and the
// fact that the award and the cooldown run through the SHARED functions rather
// than through a second implementation. Both shared modules are spied on with
// their real implementations still attached, so the assertions prove reuse and
// exercise the real behaviour at the same time.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// "server-only" throws on import outside Next.js's react-server condition.
vi.mock("server-only", () => ({}));

// `src/lib/env.ts` validates NEXT_PUBLIC_* at MODULE scope and throws without
// them, so the transitive import through settings.ts has to be stubbed.
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

// Never reached (every test injects deps), but imported at module scope.
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

// The two shared paths, wrapped rather than replaced: the real implementation
// still runs, and the spy proves review.ts went through it.
vi.mock("./award", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./award")>();
  return { ...actual, awardApprovedReceipt: vi.fn(actual.awardApprovedReceipt) };
});
vi.mock("./cooldown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cooldown")>();
  return { ...actual, applyCooldownIfEarned: vi.fn(actual.applyCooldownIfEarned) };
});

import type { Database } from "@/lib/supabase/types";

import { awardApprovedReceipt } from "./award";
import type { PointsRuleRow } from "./award";
import { applyCooldownIfEarned } from "./cooldown";
import { reviewReceipt } from "./review";
import type { ReviewDeps } from "./review";
import { DEFAULT_RECEIPT_SETTINGS } from "./settings";
import type { ReceiptSettings } from "./settings";

// ===========================================================================
// A fake Supabase client, same shape as award.test.ts / process.test.ts
// ===========================================================================

interface FakeError {
  message: string;
  code?: string;
}

interface FakeOp {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  columns: string;
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
    this.op = {
      table,
      op: "select",
      columns: "*",
      payload: undefined,
      filters: [],
      single: false,
    };
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
  delete(): this {
    this.op.op = "delete";
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

interface FakeSupabase {
  client: SupabaseClient<Database>;
  ops: FakeOp[];
  rpcCalls: Array<{ name: string; args: unknown }>;
  opsFor(table: string, op: FakeOp["op"]): FakeOp[];
  writes(): FakeOp[];
}

function createFakeSupabase(respond: Responder): FakeSupabase {
  const ops: FakeOp[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: LEDGER_ROW_ID, error: null });
    },
  };

  return {
    client: client as unknown as SupabaseClient<Database>,
    ops,
    rpcCalls,
    opsFor: (table, op) => ops.filter((e) => e.table === table && e.op === op),
    writes: () => ops.filter((e) => e.op !== "select"),
  };
}

// ===========================================================================
// Fixtures
// ===========================================================================

const RECEIPT_ID = "01980000-0000-7000-8000-000000000001";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b1";
const OTHER_BUSINESS_ID = "01980000-0000-7000-8000-0000000000b2";
const CONSUMER_ID = "01980000-0000-7000-8000-0000000000c1";
const MANAGER_ID = "01980000-0000-7000-8000-0000000000a1";
const LEDGER_ROW_ID = "01980000-0000-7000-8000-0000000000e1";
const REQUEST_ID = "req_01980000";

const NOW = new Date("2026-07-25T04:00:00.000Z");
const NOW_ISO = NOW.toISOString();

const BASE_RULE: PointsRuleRow = {
  id: "01980000-0000-7000-8000-0000000000r1",
  campaign_id: null,
  kind: "base",
  rule_type: "amount_rate",
  rate_centavos_per_point: 100,
  fixed_points: null,
  tiers: null,
  multiplier: null,
  bonus_points: null,
  conditions: {},
  rounding: "floor",
};

interface ReceiptFixture {
  id: string;
  business_id: string | null;
  user_id: string;
  status: string;
  created_at: string;
  merchant_name: string | null;
  receipt_number: string | null;
  receipt_date: string | null;
  subtotal_centavos: number | null;
  tax_centavos: number | null;
  total_centavos: number | null;
  reject_reason: string | null;
  reject_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

interface World {
  receipt: ReceiptFixture | null;
  /** What the row really holds when the conditional UPDATE runs. */
  statusAtWrite: string;
  staff: { business_id: string; user_id: string; role: string } | null;
  staffError: FakeError | null;
  customer: { visit_count: number } | null;
  pointsRules: PointsRuleRow[];
  /** Rows the cooldown strike count sees (the just-rejected receipt included). */
  fraudRejections: Array<{ id: string }>;
  scanBlockedUntil: string | null;
  auditError: FakeError | null;
  decisionUpdateError: FakeError | null;
}

const BASE_RECEIPT: ReceiptFixture = {
  id: RECEIPT_ID,
  business_id: BUSINESS_ID,
  user_id: CONSUMER_ID,
  status: "review",
  created_at: "2026-07-24T02:00:00.000Z",
  merchant_name: "SARI SARI EXPRES",
  receipt_number: "0012345",
  receipt_date: "2026-07-24T05:45:00.000Z",
  subtotal_centavos: 16964,
  tax_centavos: 2036,
  total_centavos: 19000,
  reject_reason: null,
  reject_note: null,
  reviewed_by: null,
  reviewed_at: null,
};

function createWorld(overrides: Partial<World> = {}): World {
  return {
    receipt: { ...BASE_RECEIPT },
    statusAtWrite: "review",
    staff: { business_id: BUSINESS_ID, user_id: MANAGER_ID, role: "manager" },
    staffError: null,
    customer: { visit_count: 3 },
    pointsRules: [BASE_RULE],
    fraudRejections: [],
    scanBlockedUntil: null,
    auditError: null,
    decisionUpdateError: null,
    ...overrides,
  };
}

function eqValue(op: FakeOp, column: string): unknown {
  return op.filters.find((f) => f.method === "eq" && f.args[0] === column)?.args[1];
}

function inValues(op: FakeOp, column: string): unknown[] {
  const found = op.filters.find((f) => f.method === "in" && f.args[0] === column);
  return Array.isArray(found?.args[1]) ? (found.args[1] as unknown[]) : [];
}

/** True for the ONE conditional decision write (the one carrying the guard). */
function isDecisionWrite(op: FakeOp): boolean {
  return (
    op.table === "receipts" && op.op === "update" && eqValue(op, "status") === "review"
  );
}

function worldResponder(world: World): Responder {
  return (op) => {
    const ok = (data: unknown): FakeResult => ({ data, error: null });

    if (op.table === "receipts" && op.op === "update") {
      if (world.decisionUpdateError !== null && isDecisionWrite(op)) {
        return { data: null, error: world.decisionUpdateError };
      }
      if (isDecisionWrite(op)) {
        // The optimistic-concurrency predicate, simulated: zero rows unless the
        // row really is still 'review' when the statement runs.
        return ok(world.statusAtWrite === "review" ? [{ id: RECEIPT_ID }] : []);
      }
      return ok(null);
    }

    if (op.table === "audit_logs" && op.op === "insert") {
      return world.auditError === null
        ? ok(null)
        : { data: null, error: world.auditError };
    }

    if (op.op !== "select") return ok(null);

    switch (op.table) {
      case "receipts":
        // The guard load names every column it needs; the cooldown strike count
        // asks for "id" alone.
        if (op.columns.startsWith("id, business_id")) return ok(world.receipt);
        if (op.columns === "id") return ok(world.fraudRejections);
        return ok([]);
      case "business_staff": {
        if (world.staffError !== null) return { data: null, error: world.staffError };
        const staff = world.staff;
        if (staff === null) return ok(null);
        if (eqValue(op, "business_id") !== staff.business_id) return ok(null);
        if (eqValue(op, "user_id") !== staff.user_id) return ok(null);
        if (eqValue(op, "status") !== "active") return ok(null);
        if (!inValues(op, "role").includes(staff.role)) return ok(null);
        return ok({ role: staff.role });
      }
      case "business_customers":
        return ok(world.customer);
      case "points_rules":
        return ok(world.pointsRules);
      case "campaigns":
        return ok([]);
      case "consumers":
        return ok({ scan_blocked_until: world.scanBlockedUntil });
      default:
        return ok([]);
    }
  };
}

interface Harness {
  supabase: FakeSupabase;
  deps: ReviewDeps;
  auditRows(): Record<string, unknown>[];
  decisionPayload(): Record<string, unknown> | undefined;
}

function createHarness(
  world: World = createWorld(),
  settings: Partial<ReceiptSettings> = {},
): Harness {
  const supabase = createFakeSupabase(worldResponder(world));
  const merged: ReceiptSettings = { ...DEFAULT_RECEIPT_SETTINGS, ...settings };

  return {
    supabase,
    deps: {
      supabase: supabase.client,
      now: () => NOW,
      loadSettings: () => Promise.resolve(merged),
    },
    auditRows() {
      return supabase
        .opsFor("audit_logs", "insert")
        .map((op) => op.payload as Record<string, unknown>);
    },
    decisionPayload() {
      const write = supabase.ops.find(isDecisionWrite);
      return write?.payload as Record<string, unknown> | undefined;
    },
  };
}

const APPROVE_FIELDS = {
  merchant_name: "Sari Sari Express",
  receipt_number: "0012345",
  receipt_date: "2026-07-24T05:45:00.000Z",
  subtotal_centavos: 16964,
  tax_centavos: 2036,
  total_centavos: 19000,
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ===========================================================================
// Guard order (spec section 4, normative)
// ===========================================================================

describe("reviewReceipt guard order", () => {
  it("guard 1: refuses a receipt that does not exist, before anything else", async () => {
    const harness = createHarness(createWorld({ receipt: null }));

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_NOT_FOUND" });
    expect(harness.supabase.writes()).toHaveLength(0);
    // The membership read never happens either: there is no tenant to check.
    expect(harness.supabase.opsFor("business_staff", "select")).toHaveLength(0);
  });

  it("guard 2: refuses a caller with no staff row", async () => {
    const harness = createHarness(createWorld({ staff: null }));

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(harness.supabase.writes()).toHaveLength(0);
  });

  it("guard 2: refuses active staff of a DIFFERENT tenant, scoping the check to the receipt's business", async () => {
    const harness = createHarness(
      createWorld({
        staff: { business_id: OTHER_BUSINESS_ID, user_id: MANAGER_ID, role: "owner" },
      }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(harness.supabase.writes()).toHaveLength(0);
    const check = harness.supabase.opsFor("business_staff", "select")[0];
    // The tenant comes from the RECEIPT, never from the caller.
    expect(eqValue(check as FakeOp, "business_id")).toBe(BUSINESS_ID);
  });

  it.each(["marketing", "staff"])(
    "guard 2: refuses the %s role, which cannot even read a receipt",
    async (role) => {
      const harness = createHarness(
        createWorld({ staff: { business_id: BUSINESS_ID, user_id: MANAGER_ID, role } }),
      );

      const result = await reviewReceipt({
        receiptId: RECEIPT_ID,
        actorId: MANAGER_ID,
        action: "approve",
        fields: APPROVE_FIELDS,
        requestId: REQUEST_ID,
        deps: harness.deps,
      });

      expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(harness.supabase.writes()).toHaveLength(0);
    },
  );

  it("guard 2: only owner and manager are asked for", async () => {
    const harness = createHarness();
    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const check = harness.supabase.opsFor("business_staff", "select")[0] as FakeOp;
    expect(inValues(check, "role")).toEqual(["owner", "manager"]);
    expect(eqValue(check, "status")).toBe("active");
  });

  it("guard 2: fails CLOSED when the membership read errors", async () => {
    const harness = createHarness(
      createWorld({ staffError: { message: "connection reset" } }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(harness.supabase.writes()).toHaveLength(0);
  });

  it("guard 2 runs BEFORE guard 3: a stranger is told FORBIDDEN, not that the item was decided", async () => {
    const harness = createHarness(
      createWorld({ staff: null, receipt: { ...BASE_RECEIPT, status: "approved" } }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("guard 3 runs BEFORE guard 4: a submitter looking at an already-decided receipt is told it was decided", async () => {
    const harness = createHarness(
      createWorld({
        staff: { business_id: BUSINESS_ID, user_id: MANAGER_ID, role: "manager" },
        receipt: { ...BASE_RECEIPT, status: "rejected", user_id: MANAGER_ID },
      }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_NOT_REVIEWABLE" });
    expect(harness.supabase.writes()).toHaveLength(0);
  });

  it("guard 3: refuses a receipt that is not in review", async () => {
    const harness = createHarness(
      createWorld({ receipt: { ...BASE_RECEIPT, status: "approved" } }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_NOT_REVIEWABLE" });
    expect(harness.supabase.writes()).toHaveLength(0);
    expect(harness.supabase.rpcCalls).toHaveLength(0);
  });
});

// ===========================================================================
// Guard 4: the insider control (doc 37 S9)
// ===========================================================================

describe("reviewReceipt self-review guard (doc 37 S9)", () => {
  it("refuses an approval by the submitter and writes NOTHING", async () => {
    const harness = createHarness(
      createWorld({
        staff: { business_id: BUSINESS_ID, user_id: MANAGER_ID, role: "owner" },
        receipt: { ...BASE_RECEIPT, user_id: MANAGER_ID },
      }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    // Nothing at all: no decision write, no audit row, no line items, no award.
    expect(harness.supabase.writes()).toHaveLength(0);
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(vi.mocked(awardApprovedReceipt)).not.toHaveBeenCalled();
    expect(harness.auditRows()).toHaveLength(0);
  });

  it("refuses a REJECTION by the submitter too", async () => {
    const harness = createHarness(
      createWorld({
        staff: { business_id: BUSINESS_ID, user_id: MANAGER_ID, role: "owner" },
        receipt: { ...BASE_RECEIPT, user_id: MANAGER_ID },
      }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "fraud_suspected",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(harness.supabase.writes()).toHaveLength(0);
    expect(vi.mocked(applyCooldownIfEarned)).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Optimistic concurrency: two managers, one item
// ===========================================================================

describe("reviewReceipt optimistic concurrency", () => {
  it("carries the expected status as a WHERE predicate, not an in-memory check", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const write = harness.supabase.ops.find(isDecisionWrite) as FakeOp;
    expect(eqValue(write, "id")).toBe(RECEIPT_ID);
    expect(eqValue(write, "business_id")).toBe(BUSINESS_ID);
    expect(eqValue(write, "status")).toBe("review");
  });

  it("refuses when the conditional update matches zero rows, awarding nothing", async () => {
    // The row read as 'review' but another manager decided it first.
    const harness = createHarness(createWorld({ statusAtWrite: "approved" }));

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_NOT_REVIEWABLE" });
    expect(harness.auditRows()).toHaveLength(0);
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(vi.mocked(awardApprovedReceipt)).not.toHaveBeenCalled();
  });

  it("refuses a rejection that lost the same race, with no strike", async () => {
    const harness = createHarness(createWorld({ statusAtWrite: "rejected" }));

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "duplicate",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_NOT_REVIEWABLE" });
    expect(harness.auditRows()).toHaveLength(0);
    expect(vi.mocked(applyCooldownIfEarned)).not.toHaveBeenCalled();
  });

  it("surfaces a failed decision write without awarding", async () => {
    const harness = createHarness(
      createWorld({ decisionUpdateError: { message: "deadlock detected", code: "40P01" } }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "REVIEW_WRITE_FAILED" });
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(harness.auditRows()).toHaveLength(0);
  });
});

// ===========================================================================
// Approve
// ===========================================================================

describe("reviewReceipt approve", () => {
  it("awards exactly once, THROUGH the shared award path", async () => {
    const harness = createHarness();

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: true, status: "approved" });
    // The shared function from ./award.ts is what ran, not a local copy.
    expect(vi.mocked(awardApprovedReceipt)).toHaveBeenCalledTimes(1);
    // And it really reached the ledger, exactly once.
    expect(harness.supabase.rpcCalls).toHaveLength(1);
    expect(harness.supabase.rpcCalls[0]?.name).toBe("award_receipt_points");
    expect(harness.supabase.rpcCalls[0]?.args).toMatchObject({
      p_receipt_id: RECEIPT_ID,
      p_points: 190,
    });
    if (result.ok && result.status === "approved") {
      expect(result.award).toEqual({
        kind: "awarded",
        points: 190,
        transactionId: LEDGER_ROW_ID,
      });
    }
  });

  it("writes status, reviewer and timestamp in ONE conditional update", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const decisionWrites = harness.supabase.ops.filter(isDecisionWrite);
    expect(decisionWrites).toHaveLength(1);
    expect(harness.decisionPayload()).toMatchObject({
      status: "approved",
      reviewed_by: MANAGER_ID,
      reviewed_at: NOW_ISO,
      reject_reason: null,
    });
  });

  it("persists the corrections AND prices the CORRECTED total, not the parsed one", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: {
        ...APPROVE_FIELDS,
        merchant_name: "  Sari Sari Express Cebu  ",
        receipt_number: "0012399",
        receipt_date: "2026-07-24T06:00:00.000Z",
        subtotal_centavos: 22321,
        tax_centavos: 2679,
        total_centavos: 25000,
      },
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(harness.decisionPayload()).toMatchObject({
      merchant_name: "Sari Sari Express Cebu",
      receipt_number: "0012399",
      receipt_date: "2026-07-24T06:00:00.000Z",
      subtotal_centavos: 22321,
      tax_centavos: 2679,
      total_centavos: 25000,
    });

    // 25000 centavos at 100 centavos/point = 250, NOT the parsed 190.
    expect(harness.supabase.rpcCalls[0]?.args).toMatchObject({ p_points: 250 });
    expect(vi.mocked(awardApprovedReceipt).mock.calls[0]?.[0]).toMatchObject({
      businessId: BUSINESS_ID,
      receipt: { id: RECEIPT_ID, totalCentavos: 25000 },
      isFirstVisit: false,
    });
  });

  it("approves the parsed values as they stand when no fields are supplied", async () => {
    const harness = createHarness();

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: true, status: "approved" });
    expect(harness.decisionPayload()).toMatchObject({
      merchant_name: "SARI SARI EXPRES",
      total_centavos: 19000,
    });
    expect(harness.supabase.rpcCalls[0]?.args).toMatchObject({ p_points: 190 });
  });

  it("refuses invalid corrections without writing anything", async () => {
    const harness = createHarness();

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: { ...APPROVE_FIELDS, total_centavos: -1 },
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_FIELDS_INVALID" });
    if (!result.ok) expect(result.fieldErrors[0]).toContain("total_centavos");
    expect(harness.supabase.writes()).toHaveLength(0);
    expect(harness.supabase.rpcCalls).toHaveLength(0);
  });

  it("refuses a partial patch: the form sends every field or none", async () => {
    const harness = createHarness();

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: { total_centavos: 19000 },
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_FIELDS_INVALID" });
    expect(harness.supabase.writes()).toHaveLength(0);
  });

  it("refuses to approve a receipt with no total at all", async () => {
    const harness = createHarness(
      createWorld({ receipt: { ...BASE_RECEIPT, total_centavos: null } }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_FIELDS_INVALID" });
    expect(harness.supabase.writes()).toHaveLength(0);
  });

  it("approves at ZERO points without ever touching the ledger", async () => {
    // No active base rule: a legitimate configuration, not a failure.
    const harness = createHarness(createWorld({ pointsRules: [] }));

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: true, status: "approved" });
    if (result.ok && result.status === "approved") {
      expect(result.award).toEqual({ kind: "skipped_zero_points" });
    }
    // The receipt is approved and audited; no points were minted.
    expect(harness.supabase.rpcCalls.map((call) => call.name)).not.toContain(
      "award_receipt_points",
    );
    expect(harness.decisionPayload()).toMatchObject({ status: "approved" });
    expect(harness.auditRows()).toHaveLength(1);
    // `processed_at` belongs to the shared award path (0018 step 7 / 0023),
    // never to a second write from here.
    const extraWrites = harness.supabase
      .opsFor("receipts", "update")
      .filter((op) => !isDecisionWrite(op));
    expect(extraWrites).toHaveLength(0);
  });

  it("passes isFirstVisit through from the customer pair", async () => {
    const harness = createHarness(createWorld({ customer: null }));

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(vi.mocked(awardApprovedReceipt).mock.calls[0]?.[0]).toMatchObject({
      isFirstVisit: true,
    });
  });

  it("replaces the line items when the reviewer edited them", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: {
        ...APPROVE_FIELDS,
        line_items: [
          {
            raw_text: "CHICKEN ADOBO",
            qty: 1,
            unit_price_centavos: 12000,
            line_total_centavos: 12000,
          },
          {
            raw_text: "GARLIC RICE",
            qty: 2,
            unit_price_centavos: 3500,
            line_total_centavos: 7000,
          },
        ],
      },
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(harness.supabase.opsFor("receipt_line_items", "delete")).toHaveLength(1);
    const insert = harness.supabase.opsFor("receipt_line_items", "insert")[0];
    expect(insert?.payload).toEqual([
      {
        business_id: BUSINESS_ID,
        receipt_id: RECEIPT_ID,
        raw_text: "CHICKEN ADOBO",
        qty: 1,
        unit_price_centavos: 12000,
        line_total_centavos: 12000,
        sort: 0,
      },
      {
        business_id: BUSINESS_ID,
        receipt_id: RECEIPT_ID,
        raw_text: "GARLIC RICE",
        qty: 2,
        unit_price_centavos: 3500,
        line_total_centavos: 7000,
        sort: 1,
      },
    ]);
  });

  it("leaves the parsed line items alone when the reviewer did not touch them", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(harness.supabase.opsFor("receipt_line_items", "delete")).toHaveLength(0);
  });
});

// ===========================================================================
// Reject
// ===========================================================================

describe("reviewReceipt reject", () => {
  it("writes the reason and the note, and awards nothing", async () => {
    const harness = createHarness();

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "unreadable",
      rejectNote: "  The total is smudged.  ",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toEqual({ ok: true, status: "rejected", reason: "unreadable" });
    expect(harness.decisionPayload()).toEqual({
      status: "rejected",
      reject_reason: "unreadable",
      reject_note: "The total is smudged.",
      reviewed_by: MANAGER_ID,
      reviewed_at: NOW_ISO,
      processed_at: NOW_ISO,
    });
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(vi.mocked(awardApprovedReceipt)).not.toHaveBeenCalled();
  });

  it("stores a blank note as null", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "too_old",
      rejectNote: "   ",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(harness.decisionPayload()).toMatchObject({ reject_note: null });
  });

  it("refuses a reason outside the enum", async () => {
    const harness = createHarness();

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "because_i_said_so",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_FIELDS_INVALID" });
    expect(harness.supabase.writes()).toHaveLength(0);
  });

  it("refuses a missing reason", async () => {
    const harness = createHarness();

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "RECEIPT_FIELDS_INVALID" });
    expect(harness.supabase.writes()).toHaveLength(0);
  });
});

// ===========================================================================
// Doc 37 consequences ladder step 2
// ===========================================================================

describe("reviewReceipt cooldown ladder", () => {
  it.each(["duplicate", "fraud_suspected"])(
    "runs the SHARED strike check for a %s rejection and blocks at the threshold",
    async (reason) => {
      const harness = createHarness(
        createWorld({
          // Three fraud-family rejections in the window, the new one included.
          fraudRejections: [{ id: "r1" }, { id: "r2" }, { id: RECEIPT_ID }],
        }),
      );

      const result = await reviewReceipt({
        receiptId: RECEIPT_ID,
        actorId: MANAGER_ID,
        action: "reject",
        rejectReason: reason,
        requestId: REQUEST_ID,
        deps: harness.deps,
      });

      expect(result).toMatchObject({ ok: true, status: "rejected" });
      // The pipeline's own function, not a copy.
      expect(vi.mocked(applyCooldownIfEarned)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(applyCooldownIfEarned).mock.calls[0]?.[1]).toBe(CONSUMER_ID);

      const block = harness.supabase.opsFor("consumers", "update")[0];
      expect(block?.payload).toEqual({
        scan_blocked_until: new Date(
          NOW.getTime() + DEFAULT_RECEIPT_SETTINGS.cooldownHours * 3_600_000,
        ).toISOString(),
      });
    },
  );

  it("counts strikes without blocking below the threshold", async () => {
    const harness = createHarness(
      createWorld({ fraudRejections: [{ id: "r1" }, { id: RECEIPT_ID }] }),
    );

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "duplicate",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(vi.mocked(applyCooldownIfEarned)).toHaveBeenCalledTimes(1);
    expect(harness.supabase.opsFor("consumers", "update")).toHaveLength(0);
  });

  it.each(["unreadable", "too_old", "wrong_business", "manual"])(
    "does NOT strike for a %s rejection",
    async (reason) => {
      const harness = createHarness(
        createWorld({
          fraudRejections: [{ id: "r1" }, { id: "r2" }, { id: RECEIPT_ID }],
        }),
      );

      await reviewReceipt({
        receiptId: RECEIPT_ID,
        actorId: MANAGER_ID,
        action: "reject",
        rejectReason: reason,
        requestId: REQUEST_ID,
        deps: harness.deps,
      });

      expect(vi.mocked(applyCooldownIfEarned)).not.toHaveBeenCalled();
      expect(harness.supabase.opsFor("consumers", "update")).toHaveLength(0);
    },
  );

  it("never strikes on the approve path", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(vi.mocked(applyCooldownIfEarned)).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Guard 7: the audit row
// ===========================================================================

describe("reviewReceipt audit row", () => {
  it("writes exactly ONE row on approval, with the real before and after", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: { ...APPROVE_FIELDS, merchant_name: "Sari Sari Express", total_centavos: 25000 },
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const rows = harness.auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      actor_id: MANAGER_ID,
      actor_kind: "user",
      actor_role: "manager",
      business_id: BUSINESS_ID,
      action: "receipt.review_approved",
      entity_type: "receipt",
      entity_id: RECEIPT_ID,
      request_id: REQUEST_ID,
    });
    // Real values, and ONLY the fields that actually changed.
    expect(row.before).toEqual({
      status: "review",
      merchant_name: "SARI SARI EXPRES",
      total_centavos: 19000,
      reviewed_by: null,
      reviewed_at: null,
    });
    expect(row.after).toEqual({
      status: "approved",
      merchant_name: "Sari Sari Express",
      total_centavos: 25000,
      reviewed_by: MANAGER_ID,
      reviewed_at: NOW_ISO,
    });
    // Non-blank, per audit_logs_reason_not_blank.
    expect(String(row.reason)).toContain("merchant_name");
    expect(String(row.reason)).toContain("total_centavos");
  });

  it("records only the fields that actually moved", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const row = harness.auditRows()[0] as Record<string, unknown>;
    expect(row.before).toEqual({
      status: "review",
      // The reviewer retyped the merchant name in its clean form.
      merchant_name: "SARI SARI EXPRES",
      reviewed_by: null,
      reviewed_at: null,
    });
    expect(row.reason).toBe(
      "Approved from the review queue with corrected fields: merchant_name.",
    );
  });

  it("does not report an untouched date as a correction just because Postgres spells it differently", async () => {
    // What a real timestamptz read hands back, against the ...Z the form sends.
    const harness = createHarness(
      createWorld({
        receipt: { ...BASE_RECEIPT, receipt_date: "2026-07-24T05:45:00+00:00" },
      }),
    );

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: { ...APPROVE_FIELDS, merchant_name: "SARI SARI EXPRES" },
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const row = harness.auditRows()[0] as Record<string, unknown>;
    expect(row.after).toEqual({
      status: "approved",
      reviewed_by: MANAGER_ID,
      reviewed_at: NOW_ISO,
    });
    expect(row.reason).toBe(
      "Approved from the review queue with no field corrections.",
    );
  });

  it("writes exactly ONE row on rejection", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "duplicate",
      rejectNote: "Same OR number as receipt 0012344.",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const rows = harness.auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      action: "receipt.review_rejected",
      actor_kind: "user",
      actor_role: "manager",
      entity_type: "receipt",
      entity_id: RECEIPT_ID,
      business_id: BUSINESS_ID,
      request_id: REQUEST_ID,
    });
    expect(row.before).toEqual({
      status: "review",
      reject_reason: null,
      reject_note: null,
      reviewed_by: null,
      reviewed_at: null,
    });
    expect(row.after).toEqual({
      status: "rejected",
      reject_reason: "duplicate",
      reject_note: "Same OR number as receipt 0012344.",
      reviewed_by: MANAGER_ID,
      reviewed_at: NOW_ISO,
    });
    expect(row.reason).toBe(
      "Rejected from the review queue as duplicate: Same OR number as receipt 0012344.",
    );
  });

  it("carries the ACTUAL staff role, not an assumed one", async () => {
    const harness = createHarness(
      createWorld({
        staff: { business_id: BUSINESS_ID, user_id: MANAGER_ID, role: "owner" },
      }),
    );

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "manual",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(harness.auditRows()[0]).toMatchObject({ actor_role: "owner" });
  });

  it("writes the audit row BEFORE the award reaches the ledger", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    // The ordering trade documented at the top of review.ts: an audited award
    // that failed beats an unaudited award that succeeded.
    const auditIndex = harness.supabase.ops.findIndex(
      (op) => op.table === "audit_logs" && op.op === "insert",
    );
    const rulesIndex = harness.supabase.ops.findIndex((op) => op.table === "points_rules");
    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(rulesIndex).toBeGreaterThan(auditIndex);
  });

  it("aborts the award when the audit row cannot be written", async () => {
    const harness = createHarness(
      createWorld({ auditError: { message: "audit_logs is append-only" } }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "AUDIT_WRITE_FAILED" });
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(vi.mocked(awardApprovedReceipt)).not.toHaveBeenCalled();
    // The decision itself still landed; it is recoverable, an unaudited award is not.
    expect(harness.decisionPayload()).toMatchObject({ status: "approved" });
  });

  it("aborts the cooldown strike when the audit row cannot be written", async () => {
    const harness = createHarness(
      createWorld({
        auditError: { message: "audit_logs is append-only" },
        fraudRejections: [{ id: "r1" }, { id: "r2" }, { id: RECEIPT_ID }],
      }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "fraud_suspected",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "AUDIT_WRITE_FAILED" });
    expect(vi.mocked(applyCooldownIfEarned)).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Wiring
// ===========================================================================

describe("reviewReceipt wiring", () => {
  it("refuses cleanly when the service role client is unavailable", async () => {
    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: null,
    });

    expect(result).toMatchObject({ ok: false, code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("reads the receipt by id and nothing else on the way in", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "manual",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const load = harness.supabase.opsFor("receipts", "select")[0] as FakeOp;
    expect(eqValue(load, "id")).toBe(RECEIPT_ID);
    expect(load.columns).toContain("user_id");
    // parse_meta is never read here: it belongs to the queue UI, not the decision.
    expect(load.columns).not.toContain("parse_meta");
  });
});

// ===========================================================================
// The consumer notification (doc 36 Stage 10, "approved (auto or human)")
// ===========================================================================
//
// Doc 36 draws no distinction between an auto-approval and a reviewer's, and
// neither does this service: both go through ./notify.ts and therefore through
// the same tested copy matrix. What these tests own is the wiring and the two
// properties that make it safe - the reviewer's free-text note never reaches
// the consumer, and a failed notification cannot undo a decision that has
// already been persisted, audited and paid.

describe("reviewReceipt notification", () => {
  // 0030 made notifications one row per recipient PER CHANNEL, so a kind that
  // ../../notifications/kinds.ts lists the email channel on (today only
  // receipt_rejected) writes two rows for one message. Every assertion here is
  // about the INBOX row, which is the guaranteed channel; `emailed` below is
  // the second one, asserted separately.
  function raised(harness: Harness): Record<string, unknown>[] {
    return allRaised(harness).filter((row) => row.channel === "in_app");
  }

  function emailed(harness: Harness): Record<string, unknown>[] {
    return allRaised(harness).filter((row) => row.channel === "email");
  }

  function allRaised(harness: Harness): Record<string, unknown>[] {
    return harness.supabase
      .opsFor("notifications", "insert")
      .map((op) => op.payload as Record<string, unknown>);
  }

  it("raises points_awarded when a reviewer approves", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const rows = raised(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("points_awarded");
    expect(rows[0]?.user_id).toBe(CONSUMER_ID);
    expect(rows[0]?.business_id).toBe(BUSINESS_ID);
    // 19,000 centavos at 100 centavos per point = 190.
    expect(String(rows[0]?.body)).toContain("190");
  });

  it("addresses it to the SUBMITTER, never to the reviewer", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(raised(harness)[0]?.user_id).not.toBe(MANAGER_ID);
  });

  it("raises receipt_rejected when a reviewer rejects, carrying the enum reason", async () => {
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "fraud_suspected",
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const rows = raised(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("receipt_rejected");
    expect(
      (rows[0]?.data as { params?: Record<string, unknown> }).params?.reject_reason,
    ).toBe("fraud_suspected");
  });

  // The second channel, on the human-decision path as well as the pipeline's:
  // a reviewer's rejection is exactly as worth an email as an automatic one,
  // and more so, since it can arrive a day after the consumer stopped looking.
  it("also queues an email when a reviewer rejects, and never on approval", async () => {
    const rejected = createHarness();
    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "duplicate",
      requestId: REQUEST_ID,
      deps: rejected.deps,
    });
    const emails = emailed(rejected);
    expect(emails).toHaveLength(1);
    expect(emails[0]?.status).toBe("pending");
    expect(emails[0]?.title).toBe(raised(rejected)[0]?.title);

    const approved = createHarness();
    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: approved.deps,
    });
    expect(emailed(approved)).toHaveLength(0);
  });

  // The reviewer's note is withheld from BOTH channels, and the email matters
  // more: it persists in an inbox and is indexed by a mail provider.
  it("CRITICAL: the reviewer's free-text note never reaches the consumer", async () => {
    // A reviewer doing their job writes things like this. 0017 makes the column
    // unreadable by the client and receipt-copy.ts has no parameter for it;
    // this asserts the same at the point where the two meet.
    const note = "same receipt Ana scanned at 2pm, matched image hash";
    const harness = createHarness();

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "reject",
      rejectReason: "duplicate",
      rejectNote: note,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    const serialized = JSON.stringify(allRaised(harness));
    expect(serialized).not.toContain(note);
    expect(serialized).not.toContain("Ana");
    expect(serialized).not.toMatch(/hash/i);
    // ...while the audit row, which is tenant-private, keeps it.
    expect(JSON.stringify(harness.auditRows()[0])).toContain(note);
  });

  it("raises nothing on a refused decision, because nothing happened to report", async () => {
    const harness = createHarness(createWorld({ receipt: null }));

    await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(raised(harness)).toHaveLength(0);
  });

  it("raises nothing when the audit write failed, because the consequences were stopped", async () => {
    const harness = createHarness(
      createWorld({ auditError: { message: "audit unavailable" } }),
    );

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: false, code: "AUDIT_WRITE_FAILED" });
    expect(raised(harness)).toHaveLength(0);
  });

  it("CRITICAL: a failed notification does not turn a completed approval into an error", async () => {
    const harness = createHarness();
    const client = harness.deps.supabase as unknown as {
      from: (table: string) => unknown;
    };
    const realFrom = client.from.bind(client);
    client.from = (table: string) => {
      if (table === "notifications") {
        return { insert: () => Promise.reject(new Error("notifications table is on fire")) };
      }
      return realFrom(table);
    };

    const result = await reviewReceipt({
      receiptId: RECEIPT_ID,
      actorId: MANAGER_ID,
      action: "approve",
      fields: APPROVE_FIELDS,
      requestId: REQUEST_ID,
      deps: harness.deps,
    });

    expect(result).toMatchObject({ ok: true, status: "approved" });
    // The award went through the shared path regardless.
    expect(awardApprovedReceipt).toHaveBeenCalledTimes(1);
  });
});
