import { beforeEach, describe, expect, it, vi } from "vitest";

// The consumer read layer. Two properties are load-bearing enough to be
// tested against a fake PostgREST builder rather than trusted:
//
//   1. EVERY query names its columns. 0017_receipts.sql revoked the
//      table-level SELECT on `receipts` and re-granted 13 columns, so a
//      `select("*")` here is not a style problem, it is a 42501 in
//      production. The assertions below check the literal select strings and
//      that nothing outside the grant is ever named.
//
//   2. OWNERSHIP IS RE-CHECKED IN CODE. `receipts` RLS is a union that also
//      admits the matched business's owner/manager, so a row coming back is
//      not proof it belongs to the caller. getMyReceipt must return null for
//      somebody else's receipt, which is what lets the route answer 404
//      rather than 403.

vi.mock("server-only", () => ({}));

interface Recorded {
  table: string;
  select?: string;
  eq: [string, unknown][];
  in: [string, unknown[]][];
  or?: string;
  limit?: number;
  order: [string, unknown][];
  maybeSingle: boolean;
}

const state = vi.hoisted(() => ({
  recorded: [] as Recorded[],
  results: new Map<string, { data: unknown; error: unknown }>(),
}));

function resultFor(table: string): { data: unknown; error: unknown } {
  return state.results.get(table) ?? { data: [], error: null };
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  constructor(private readonly record: Recorded) {}

  select(columns: string): this {
    this.record.select = columns;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.record.eq.push([column, value]);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.record.in.push([column, values]);
    return this;
  }
  or(expression: string): this {
    this.record.or = expression;
    return this;
  }
  order(column: string, options: unknown): this {
    this.record.order.push([column, options]);
    return this;
  }
  limit(count: number): this {
    this.record.limit = count;
    return this;
  }
  maybeSingle(): this {
    this.record.maybeSingle = true;
    return this;
  }
  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(resultFor(this.record.table)).then(onfulfilled, onrejected);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      const record: Recorded = { table, eq: [], in: [], order: [], maybeSingle: false };
      state.recorded.push(record);
      return new FakeQuery(record);
    },
  })),
}));

const { getMyReceipt, listMyReceipts, RECEIPT_CLIENT_COLUMNS } = await import("./repo");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "99999999-9999-4999-8999-999999999999";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";
const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RECEIPT_ID,
    user_id: USER_ID,
    business_id: BUSINESS_ID,
    status: "approved",
    reject_reason: null,
    merchant_name: "KAPE DIARIA",
    receipt_number: "OR-000412",
    receipt_date: "2026-07-24T04:00:00.000Z",
    total_centavos: 24500,
    created_at: "2026-07-25T03:15:00.000Z",
    processed_at: "2026-07-25T03:15:40.000Z",
    ...overrides,
  };
}

function recordedFor(table: string): Recorded[] {
  return state.recorded.filter((entry) => entry.table === table);
}

beforeEach(() => {
  state.recorded.length = 0;
  state.results.clear();
});

describe("column safety", () => {
  it("names every column on receipts, never a wildcard", async () => {
    state.results.set("receipts", { data: [receiptRow()], error: null });

    await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    const select = recordedFor("receipts")[0]?.select ?? "";
    expect(select).not.toContain("*");
    expect(select.length).toBeGreaterThan(0);
  });

  it("never names a column outside the grant 0017 gives authenticated", async () => {
    state.results.set("receipts", { data: [receiptRow()], error: null });

    await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });
    state.results.set("receipts", { data: receiptRow(), error: null });
    await getMyReceipt(RECEIPT_ID, USER_ID);

    const granted = new Set<string>(RECEIPT_CLIENT_COLUMNS);
    for (const record of recordedFor("receipts")) {
      for (const column of (record.select ?? "").split(",").map((part) => part.trim())) {
        expect(granted.has(column), `${column} is not in the column grant`).toBe(true);
      }
    }
  });

  it("does not select the columns deliberately withheld", async () => {
    state.results.set("receipts", { data: [receiptRow()], error: null });

    await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    const select = recordedFor("receipts")[0]?.select ?? "";
    for (const column of [
      "reject_note",
      "parse_meta",
      "match_confidence",
      "parse_confidence",
      "sha256",
      "image_hash",
    ]) {
      expect(select, column).not.toContain(column);
    }
  });

  it("names its columns on receipt_line_items too, omitting parser internals", async () => {
    state.results.set("receipts", { data: receiptRow(), error: null });
    state.results.set("receipt_line_items", { data: [], error: null });

    await getMyReceipt(RECEIPT_ID, USER_ID);

    const select = recordedFor("receipt_line_items")[0]?.select ?? "";
    expect(select).not.toContain("*");
    expect(select).not.toContain("product_id");
    expect(select).not.toContain("match_score");
  });
});

describe("listMyReceipts", () => {
  beforeEach(() => {
    state.results.set("receipts", { data: [receiptRow()], error: null });
  });

  it("CRITICAL: constrains user_id itself, because RLS also admits the business's staff", async () => {
    await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(recordedFor("receipts")[0]?.eq).toContainEqual(["user_id", USER_ID]);
  });

  it("sorts newest first with the id as a tiebreaker, per doc 13's default", async () => {
    await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(recordedFor("receipts")[0]?.order).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  it("over-fetches exactly one row so has_more needs no count query", async () => {
    await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(recordedFor("receipts")[0]?.limit).toBe(26);
  });

  it("expresses the keyset cursor as PostgREST's disjunction, never an offset", async () => {
    await listMyReceipts({
      userId: USER_ID,
      limit: 25,
      cursor: { sortKey: "2026-07-03T00:00:00.000Z", id: "receipt-2" },
    });

    expect(recordedFor("receipts")[0]?.or).toBe(
      "created_at.lt.2026-07-03T00:00:00.000Z,and(created_at.eq.2026-07-03T00:00:00.000Z,id.lt.receipt-2)",
    );
  });

  it("applies no cursor predicate on the first page", async () => {
    await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });
    expect(recordedFor("receipts")[0]?.or).toBeUndefined();
  });

  it("applies the status filter when one is given", async () => {
    await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null, status: "review" });
    expect(recordedFor("receipts")[0]?.eq).toContainEqual(["status", "review"]);
  });

  it("returns an empty page rather than throwing when the query fails", async () => {
    state.results.set("receipts", { data: null, error: { message: "boom" } });

    await expect(listMyReceipts({ userId: USER_ID, limit: 25, cursor: null })).resolves.toEqual({
      rows: [],
    });
  });

  it("reads awarded points from the ledger, filtered to earn rows", async () => {
    state.results.set("points_transactions", {
      data: [{ receipt_id: RECEIPT_ID, points: 245 }],
      error: null,
    });

    const { rows } = await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(recordedFor("points_transactions")[0]?.eq).toContainEqual(["type", "earn"]);
    expect(recordedFor("points_transactions")[0]?.select).toBe("receipt_id, points");
    expect(rows[0]?.pointsAwarded).toBe(245);
  });

  it("leaves pointsAwarded null (not zero) when no earn row exists yet", async () => {
    state.results.set("points_transactions", { data: [], error: null });

    const { rows } = await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(rows[0]?.pointsAwarded).toBeNull();
  });

  it("resolves the business name for display", async () => {
    state.results.set("businesses", {
      data: [{ id: BUSINESS_ID, name: "Kape Diaria" }],
      error: null,
    });

    const { rows } = await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(rows[0]?.businessName).toBe("Kape Diaria");
  });

  it("does not query businesses for an unmatched receipt", async () => {
    state.results.set("receipts", { data: [receiptRow({ business_id: null })], error: null });

    const { rows } = await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(recordedFor("businesses")).toHaveLength(0);
    expect(rows[0]?.businessName).toBeNull();
  });

  it("narrows an unrecognised status to a safe reading rather than trusting the string", async () => {
    state.results.set("receipts", { data: [receiptRow({ status: "teleported" })], error: null });

    const { rows } = await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(rows[0]?.status).toBe("processing");
  });

  it("maps an unrecognised reject_reason to manual so a rejection is never unexplained", async () => {
    state.results.set("receipts", {
      data: [receiptRow({ status: "rejected", reject_reason: "brand_new" })],
      error: null,
    });

    const { rows } = await listMyReceipts({ userId: USER_ID, limit: 25, cursor: null });

    expect(rows[0]?.rejectReason).toBe("manual");
  });
});

describe("getMyReceipt", () => {
  it("returns the receipt with its line items for the owner", async () => {
    state.results.set("receipts", { data: receiptRow(), error: null });
    state.results.set("receipt_line_items", {
      data: [
        {
          id: "line-1",
          raw_text: "1 KAPE BARAKO 145.00",
          qty: 1,
          unit_price_centavos: 14500,
          line_total_centavos: 14500,
          sort: 0,
        },
      ],
      error: null,
    });

    const receipt = await getMyReceipt(RECEIPT_ID, USER_ID);

    expect(receipt?.receiptId).toBe(RECEIPT_ID);
    expect(receipt?.lineItems).toHaveLength(1);
    expect(receipt?.lineItems[0]?.rawText).toBe("1 KAPE BARAKO 145.00");
  });

  it("CRITICAL: returns null for a row RLS let through that belongs to somebody else", async () => {
    // This is exactly what a business owner reading a customer's receipt id
    // looks like: RLS returns the row, ownership does not hold. Null is what
    // lets the route answer 404 rather than 403.
    state.results.set("receipts", { data: receiptRow({ user_id: OTHER_USER_ID }), error: null });

    await expect(getMyReceipt(RECEIPT_ID, USER_ID)).resolves.toBeNull();
  });

  it("does not fetch line items for a receipt the caller does not own", async () => {
    state.results.set("receipts", { data: receiptRow({ user_id: OTHER_USER_ID }), error: null });

    await getMyReceipt(RECEIPT_ID, USER_ID);

    expect(recordedFor("receipt_line_items")).toHaveLength(0);
  });

  it("returns null for an absent receipt, indistinguishably from a foreign one", async () => {
    state.results.set("receipts", { data: null, error: null });

    await expect(getMyReceipt(RECEIPT_ID, USER_ID)).resolves.toBeNull();
  });

  it("returns null rather than throwing when the query errors", async () => {
    state.results.set("receipts", { data: null, error: { message: "boom" } });

    await expect(getMyReceipt(RECEIPT_ID, USER_ID)).resolves.toBeNull();
  });

  it("orders line items by their parsed sort", async () => {
    state.results.set("receipts", { data: receiptRow(), error: null });
    state.results.set("receipt_line_items", { data: [], error: null });

    await getMyReceipt(RECEIPT_ID, USER_ID);

    expect(recordedFor("receipt_line_items")[0]?.order).toEqual([["sort", { ascending: true }]]);
  });
});
