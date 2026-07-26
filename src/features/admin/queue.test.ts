// @vitest-environment node
//
// The service-role reads behind the admin portal.
//
// WHAT THIS SUITE IS FOR. These queries run with a client that bypasses RLS and
// - unlike the business review queue - apply NO tenancy predicate, because the
// admin surfaces are platform-wide by design. So the assertions here are the
// mirror image of that suite's: they check that each query is driven off the
// right table with the right filter, that a failed read surfaces as `null`
// rather than as an empty platform, and that the cross-tenant resolution the
// business queue is forbidden from doing actually happens here.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import {
  listAdminFraudQueue,
  listAdminReceipts,
  loadAdminReceiptDetail,
  loadPlatformOverview,
} from "./queue";
import type { AdminQueueDeps } from "./queue";

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

interface Op {
  table: string;
  columns: string;
  filters: Array<{ method: string; args: unknown[] }>;
  single: boolean;
}

interface Result {
  data: unknown;
  error: { message: string } | null;
}

type Responder = (op: Op) => Result;

class FakeQuery implements PromiseLike<Result> {
  readonly op: Op;

  constructor(
    table: string,
    private readonly respond: Responder,
    private readonly log: (op: Op) => void,
  ) {
    this.op = { table, columns: "*", filters: [], single: false };
  }

  select(columns?: string): this {
    this.op.columns = columns ?? "*";
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

  then<T1 = Result, T2 = never>(
    onFulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => {
        this.log(this.op);
        const result = this.respond(this.op);
        if (!this.op.single || result.error !== null) return result;
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { data, error: null };
      })
      .then(onFulfilled, onRejected);
  }
}

interface Harness {
  deps: AdminQueueDeps;
  ops: Op[];
  signed: string[];
  opsFor(table: string): Op[];
}

const NOW = new Date("2026-07-26T12:00:00.000Z");

function hasFilter(op: Op, method: string, column: string, value?: unknown): boolean {
  return op.filters.some(
    (f) =>
      f.method === method &&
      f.args[0] === column &&
      (value === undefined || f.args[1] === value),
  );
}

function createHarness(respond: Responder): Harness {
  const ops: Op[] = [];
  const signed: string[] = [];

  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
    storage: {
      from: () => ({
        createSignedUrl: (path: string) => {
          signed.push(path);
          return Promise.resolve({ data: { signedUrl: `https://signed/${path}` }, error: null });
        },
      }),
    },
  };

  return {
    deps: { supabase: client as unknown as SupabaseClient<Database>, now: () => NOW },
    ops,
    signed,
    opsFor: (table) => ops.filter((op) => op.table === table),
  };
}

const BIZ_A = "aaaaaaaa-1111-4111-8111-111111111111";
const BIZ_B = "bbbbbbbb-2222-4222-8222-222222222222";
const CONSUMER = "cccccccc-3333-4333-8333-333333333333";
const OTHER_CONSUMER = "dddddddd-4444-4444-8444-444444444444";
const RECEIPT = "eeeeeeee-5555-4555-8555-555555555555";
const MATCHED = "ffffffff-6666-4666-8666-666666666666";

function receiptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECEIPT,
    business_id: BIZ_A,
    user_id: CONSUMER,
    status: "review",
    merchant_name: "Kape Diaria",
    receipt_number: "R-001",
    receipt_date: "2026-07-25T02:00:00.000Z",
    total_centavos: 124500,
    created_at: "2026-07-26T09:00:00.000Z",
    reviewed_at: null,
    reject_reason: null,
    subtotal_centavos: 111000,
    tax_centavos: 13500,
    reject_note: null,
    image_path: `${CONSUMER}/r1.jpg`,
    parse_meta: { tier: "template", fields: {} },
    parse_confidence: 0.91,
    match_confidence: 0.96,
    device_id: "device-1",
    ...overrides,
  };
}

let errorSpy: { mockRestore: () => void };

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("listAdminFraudQueue", () => {
  it("drives the open queue off receipts in review, oldest first", async () => {
    const harness = createHarness((op) =>
      op.table === "receipts" ? { data: [receiptRow()], error: null } : { data: [], error: null },
    );

    const items = await listAdminFraudQueue({ filter: "open" }, harness.deps);
    expect(items).toHaveLength(1);

    const query = harness.opsFor("receipts")[0]!;
    expect(hasFilter(query, "eq", "status", "review")).toBe(true);
    // Platform-wide by design: no business predicate anywhere.
    expect(hasFilter(query, "eq", "business_id")).toBe(false);
    expect(query.filters.some((f) => f.method === "order" && f.args[0] === "created_at")).toBe(true);
  });

  it("drives the blocked queue off fraud_signals severity, not off receipt status", async () => {
    // A blocking signal auto-rejects, so those receipts are never in `review`
    // and a receipts-driven query would return none of them.
    const harness = createHarness((op) => {
      if (op.table === "fraud_signals") {
        return { data: [{ receipt_id: RECEIPT, created_at: "2026-07-26T10:00:00.000Z" }], error: null };
      }
      if (op.table === "receipts") return { data: [receiptRow({ status: "rejected" })], error: null };
      return { data: [], error: null };
    });

    const items = await listAdminFraudQueue({ filter: "blocked" }, harness.deps);
    expect(items).toHaveLength(1);

    const feed = harness.opsFor("fraud_signals")[0]!;
    expect(feed.filters.some((f) => f.method === "in" && f.args[0] === "severity")).toBe(true);
    const severities = feed.filters.find((f) => f.method === "in")?.args[1];
    expect(severities).toEqual(["block"]);
  });

  it("widens to warn and block on the all filter", async () => {
    const harness = createHarness(() => ({ data: [], error: null }));
    await listAdminFraudQueue({ filter: "all" }, harness.deps);
    const feed = harness.opsFor("fraud_signals")[0]!;
    expect(feed.filters.find((f) => f.method === "in")?.args[1]).toEqual(["warn", "block"]);
  });

  it("returns NULL, not an empty queue, when the read fails", async () => {
    // An empty admin fraud queue is a claim that the platform is clean. A
    // dropped connection is not entitled to make it.
    const harness = createHarness(() => ({ data: null, error: { message: "down" } }));
    expect(await listAdminFraudQueue({ filter: "open" }, harness.deps)).toBeNull();
  });

  it("flags a staff self-scan on the row so it is visible without opening it", async () => {
    const harness = createHarness((op) => {
      if (op.table === "receipts") return { data: [receiptRow()], error: null };
      if (op.table === "fraud_signals") {
        return {
          data: [
            {
              id: "sig-1",
              receipt_id: RECEIPT,
              business_id: BIZ_A,
              consumer_id: CONSUMER,
              signal: "staff_self_scan",
              severity: "warn",
              score: 0.8,
              evidence: {},
              created_at: "2026-07-26T09:05:00.000Z",
            },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    const items = await listAdminFraudQueue({ filter: "open" }, harness.deps);
    expect(items?.[0]?.staffSelfScan).toBe(true);
    expect(items?.[0]?.topSeverity).toBe("warn");
  });
});

describe("listAdminReceipts", () => {
  it("finds the unmatched receipts that no tenant can see", async () => {
    const harness = createHarness((op) =>
      op.table === "receipts"
        ? { data: [receiptRow({ business_id: null })], error: null }
        : { data: [], error: null },
    );

    const items = await listAdminReceipts({ filter: "unmatched" }, harness.deps);
    expect(items?.[0]?.businessId).toBeNull();
    expect(items?.[0]?.businessName).toBeNull();
    expect(hasFilter(harness.opsFor("receipts")[0]!, "is", "business_id", null)).toBe(true);
  });

  it("orders recently decided receipts by when they were decided", async () => {
    const harness = createHarness(() => ({ data: [], error: null }));
    await listAdminReceipts({ filter: "recent" }, harness.deps);
    const query = harness.opsFor("receipts")[0]!;
    expect(query.filters.some((f) => f.method === "not" && f.args[0] === "reviewed_at")).toBe(true);
    expect(query.filters.some((f) => f.method === "order" && f.args[0] === "reviewed_at")).toBe(true);
  });
});

describe("loadAdminReceiptDetail", () => {
  const signalRow = {
    id: "sig-dup",
    receipt_id: RECEIPT,
    business_id: BIZ_A,
    consumer_id: CONSUMER,
    signal: "image_hash_dup",
    severity: "block",
    score: 1,
    evidence: { matched_receipt_id: MATCHED, hamming_distance: 2, cross_consumer: true },
    created_at: "2026-07-26T09:05:00.000Z",
  };

  function detailHarness(overrides: { ledger?: unknown[] } = {}): Harness {
    let receiptCalls = 0;
    return createHarness((op) => {
      if (op.table === "receipts") {
        receiptCalls += 1;
        if (op.single) return { data: receiptRow(), error: null };
        // The matched-receipt lookup: a receipt at ANOTHER business, submitted
        // by ANOTHER consumer. The business queue is forbidden from resolving
        // this; the admin queue must.
        if (op.filters.some((f) => f.method === "in" && f.args[0] === "id")) {
          return {
            data: [
              {
                id: MATCHED,
                business_id: BIZ_B,
                user_id: OTHER_CONSUMER,
                image_path: `${OTHER_CONSUMER}/m1.jpg`,
                merchant_name: "Rival Cafe",
                receipt_number: "R-777",
                receipt_date: "2026-07-24T02:00:00.000Z",
                total_centavos: 60000,
                status: "approved",
                created_at: "2026-07-24T03:00:00.000Z",
              },
            ],
            error: null,
          };
        }
        // The standing read.
        return {
          data: [
            { status: "approved", reject_reason: null, business_id: BIZ_A, device_id: "d1", created_at: "2026-07-20T00:00:00.000Z" },
            { status: "rejected", reject_reason: "duplicate", business_id: BIZ_B, device_id: "d2", created_at: "2026-07-25T00:00:00.000Z" },
            { status: "rejected", reject_reason: "unreadable", business_id: BIZ_B, device_id: "d2", created_at: "2026-07-25T00:00:00.000Z" },
            { status: "rejected", reject_reason: "fraud_suspected", business_id: BIZ_A, device_id: "d1", created_at: "2026-01-01T00:00:00.000Z" },
          ],
          error: null,
        };
      }
      if (op.table === "fraud_signals") {
        return op.columns.includes("evidence")
          ? { data: [signalRow], error: null }
          : { data: [{ id: "s1" }, { id: "s2" }], error: null };
      }
      if (op.table === "businesses") {
        return { data: [{ id: BIZ_A, name: "Kape Diaria" }, { id: BIZ_B, name: "Rival Cafe" }], error: null };
      }
      if (op.table === "profiles") {
        if (op.single) return { data: { is_suspended: false, suspended_reason: null }, error: null };
        return {
          data: [
            { id: CONSUMER, display_name: "Ana Reyes" },
            { id: OTHER_CONSUMER, display_name: "Ben Cruz" },
          ],
          error: null,
        };
      }
      if (op.table === "consumers") return { data: { scan_blocked_until: null }, error: null };
      if (op.table === "points_transactions") return { data: overrides.ledger ?? [], error: null };
      if (op.table === "audit_logs") return { data: [], error: null };
      void receiptCalls;
      return { data: [], error: null };
    });
  }

  it("resolves a cross-tenant duplicate in full: the other business, the other account, both images", async () => {
    const harness = detailHarness();
    const detail = await loadAdminReceiptDetail({ receiptId: RECEIPT }, harness.deps);

    const item = detail?.signals[0];
    expect(item?.matchedBusinessName).toBe("Rival Cafe");
    expect(item?.matchedConsumerName).toBe("Ben Cruz");
    expect(item?.signal.matchedReceipt?.receiptId).toBe(MATCHED);
    // Doc 37's side-by-side comparison: both halves signed, which the business
    // queue cannot do because it is not entitled to the other tenant's image.
    expect(item?.matchedImageUrl).not.toBeNull();
    expect(harness.signed).toContain(`${CONSUMER}/r1.jpg`);
    expect(harness.signed).toContain(`${OTHER_CONSUMER}/m1.jpg`);
  });

  it("counts strikes as fraud-family REJECTIONS inside the 30-day window only", async () => {
    // Doc 37's ladder counts rejections, not signals, and the automatic path in
    // receipts/server/cooldown.ts counts the same way. `unreadable` is a
    // quality outcome and the January row is outside the window.
    const harness = detailHarness();
    const detail = await loadAdminReceiptDetail({ receiptId: RECEIPT }, harness.deps);
    expect(detail?.standing.strikes).toBe(1);
  });

  it("answers the platform-wide facts the business queue deliberately withholds", async () => {
    const harness = detailHarness();
    const detail = await loadAdminReceiptDetail({ receiptId: RECEIPT }, harness.deps);
    expect(detail?.standing.devices).toBe(2);
    expect(detail?.standing.businesses).toBe(2);
    expect(detail?.standing.approved).toBe(1);
    expect(detail?.standing.rejected).toBe(3);
    expect(detail?.standing.approvalRatio).toBeCloseTo(0.25);
  });

  it("reports a receipt that never earned points as never awarded", async () => {
    const harness = detailHarness({ ledger: [] });
    const detail = await loadAdminReceiptDetail({ receiptId: RECEIPT }, harness.deps);
    expect(detail?.clawback).toEqual({ kind: "never_awarded" });
  });

  it("reports an awarded receipt as eligible, with the points at stake", async () => {
    const harness = detailHarness({
      ledger: [{ id: "earn-1", type: "earn", points: 400, reverses_id: null }],
    });
    const detail = await loadAdminReceiptDetail({ receiptId: RECEIPT }, harness.deps);
    expect(detail?.clawback).toEqual({ kind: "eligible", earnPoints: 400 });
  });

  it("reports an already-reversed earn as already reversed, so the control explains itself", async () => {
    const harness = detailHarness({
      ledger: [
        { id: "earn-1", type: "earn", points: 400, reverses_id: null },
        { id: "claw-1", type: "clawback", points: -400, reverses_id: "earn-1" },
      ],
    });
    const detail = await loadAdminReceiptDetail({ receiptId: RECEIPT }, harness.deps);
    expect(detail?.clawback).toEqual({ kind: "already_reversed", clawedPoints: 400 });
  });

  it("returns null for a receipt that does not exist", async () => {
    const harness = createHarness(() => ({ data: null, error: null }));
    expect(await loadAdminReceiptDetail({ receiptId: RECEIPT }, harness.deps)).toBeNull();
  });
});

describe("loadPlatformOverview", () => {
  it("counts live, indexed facts and nothing invented", async () => {
    const harness = createHarness((op) => {
      if (op.table === "businesses" && hasFilter(op, "eq", "status", "pending_verification")) {
        return { data: [{ id: "b1" }, { id: "b2" }], error: null };
      }
      if (op.table === "receipts" && hasFilter(op, "eq", "status", "review")) {
        return { data: [{ id: "r1" }], error: null };
      }
      if (op.table === "receipts" && hasFilter(op, "is", "business_id", null)) {
        return { data: [{ id: "r9" }], error: null };
      }
      if (op.table === "fraud_signals") {
        return { data: [{ receipt_id: RECEIPT, created_at: "2026-07-25T00:00:00.000Z" }], error: null };
      }
      if (op.table === "receipts") return { data: [receiptRow()], error: null };
      return { data: [], error: null };
    });

    const overview = await loadPlatformOverview(harness.deps);
    expect(overview.businessesAwaitingVerification).toBe(2);
    expect(overview.receiptsInReview).toBe(1);
    expect(overview.unmatchedReceipts).toBe(1);
    expect(overview.fraudBlocks7d).toBe(1);
    expect(overview.recentBlocks).toHaveLength(1);
  });

  it("bounds the block window to seven days rather than scanning history", async () => {
    const harness = createHarness(() => ({ data: [], error: null }));
    await loadPlatformOverview(harness.deps);
    const feed = harness.opsFor("fraud_signals")[0]!;
    const gte = feed.filters.find((f) => f.method === "gte" && f.args[0] === "created_at");
    expect(gte?.args[1]).toBe(new Date(NOW.getTime() - 7 * 24 * 3_600_000).toISOString());
  });

  it("reports a failed count as NULL, never as zero", async () => {
    // "0 receipts in review" is a claim that the whole platform is clear, and
    // it is the claim an operator acts on by closing the tab.
    const harness = createHarness((op) =>
      op.table === "receipts" && hasFilter(op, "eq", "status", "review")
        ? { data: null, error: { message: "down" } }
        : { data: [], error: null },
    );
    const overview = await loadPlatformOverview(harness.deps);
    expect(overview.receiptsInReview).toBeNull();
    expect(overview.businessesAwaitingVerification).toBe(0);
  });

  it("renders nothing at all when the service-role key is missing", async () => {
    const overview = await loadPlatformOverview(null);
    expect(overview.businessesAwaitingVerification).toBeNull();
    expect(overview.recentBlocks).toEqual([]);
  });
});

afterAll(() => {
  errorSpy.mockRestore();
});
