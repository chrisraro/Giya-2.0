// @vitest-environment node
//
// The service-role reads behind `/business/receipts`.
//
// WHAT THIS SUITE IS FOR. These queries run with a client that BYPASSES RLS,
// so the `.eq("business_id", ...)` predicates are the entire tenancy fence.
// The assertions below are therefore mostly about FILTERS, not about returned
// data: every query is checked for the predicate that scopes it to the
// caller's tenant, and the cross-tenant paths (a receipt id from another
// business, a duplicate signal naming another business's receipt) are checked
// to resolve to nothing rather than to data.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import {
  countPendingReview,
  listReviewQueue,
  loadReviewDecisionItem,
  parseParseMeta,
} from "./queue";
import type { ReviewQueueDeps } from "./queue";

// ---------------------------------------------------------------------------
// A fake Supabase client, same shape as server/review.test.ts
// ---------------------------------------------------------------------------

interface FakeOp {
  table: string;
  columns: string;
  filters: Array<{ method: string; args: unknown[] }>;
  single: boolean;
}

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

type Responder = (op: FakeOp) => FakeResult;

class FakeQuery implements PromiseLike<FakeResult> {
  readonly op: FakeOp;

  constructor(
    table: string,
    private readonly respond: Responder,
    private readonly record: (op: FakeOp) => void,
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

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => {
        this.record(this.op);
        const result = this.respond(this.op);
        if (!this.op.single || result.error !== null) return result;
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { data, error: null };
      })
      .then(onFulfilled, onRejected);
  }
}

interface SignedUrlCall {
  bucket: string;
  path: string;
  ttl: number;
}

interface Harness {
  deps: ReviewQueueDeps;
  ops: FakeOp[];
  signedUrls: SignedUrlCall[];
  opsFor(table: string): FakeOp[];
}

function filterValue(op: FakeOp, method: string, column: string): unknown {
  const hit = op.filters.find((f) => f.method === method && f.args[0] === column);
  return hit?.args[1];
}

function hasFilter(op: FakeOp, method: string, column: string, value: unknown): boolean {
  return op.filters.some(
    (f) => f.method === method && f.args[0] === column && f.args[1] === value,
  );
}

const NOW = new Date("2026-07-25T12:00:00.000Z");

function createHarness(respond: Responder, signedUrl: string | null = "https://signed"): Harness {
  const ops: FakeOp[] = [];
  const signedUrls: SignedUrlCall[] = [];

  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (path: string, ttl: number) => {
          signedUrls.push({ bucket, path, ttl });
          return Promise.resolve(
            signedUrl === null
              ? { data: null, error: { message: "nope" } }
              : { data: { signedUrl }, error: null },
          );
        },
      }),
    },
  };

  return {
    deps: { supabase: client as unknown as SupabaseClient<Database>, now: () => NOW },
    ops,
    signedUrls,
    opsFor: (table) => ops.filter((op) => op.table === table),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b1";
const OTHER_BUSINESS_ID = "01980000-0000-7000-8000-0000000000b2";
const RECEIPT_ID = "01980000-0000-7000-8000-000000000001";
const OTHER_RECEIPT_ID = "01980000-0000-7000-8000-000000000002";
const CONSUMER_ID = "01980000-0000-7000-8000-0000000000c1";
const MANAGER_ID = "01980000-0000-7000-8000-0000000000a1";

const PARSE_META = {
  engine: "parse/v1",
  template_id: null,
  tier: "heuristic",
  parse_confidence: 0.82,
  fields: {
    merchant_name: { tier: "heuristic", present: true },
    receipt_number: { tier: "heuristic", present: true },
    receipt_date: { tier: "heuristic", present: false },
    subtotal_centavos: { tier: "heuristic", present: true },
    tax_centavos: { tier: "heuristic", present: true },
    total_centavos: { tier: "heuristic", present: true },
  },
  vat_consistent: true,
  within_amount_sanity: true,
  date_ambiguous: false,
  notes: ["date_missing"],
  match: { confidence: 0.9, contradicted: false },
  ocr: { engine: "stub", mean_confidence: 0.71, attempt: 1, preprocess_ops: [] },
};

const RECEIPT_ROW = {
  id: RECEIPT_ID,
  user_id: CONSUMER_ID,
  status: "review",
  merchant_name: "SARI SARI EXPRESS",
  receipt_number: "0012345",
  receipt_date: "2026-07-24T05:45:00.000Z",
  total_centavos: 19_000,
  created_at: "2026-07-24T02:00:00.000Z",
  reviewed_at: null,
  reject_reason: null,
  business_id: BUSINESS_ID,
  subtotal_centavos: 16_964,
  tax_centavos: 2_036,
  reject_note: null,
  image_path: `receipts/${CONSUMER_ID}/abc.jpg`,
  parse_meta: PARSE_META,
  parse_confidence: 0.82,
  match_confidence: 0.9,
};

const VELOCITY_SIGNAL = {
  id: "sig-1",
  receipt_id: RECEIPT_ID,
  signal: "velocity",
  severity: "warn",
  score: 0.7,
  evidence: { window: "pair_10min", count: 3, cap: 2 },
  created_at: "2026-07-24T02:00:01.000Z",
};

const DUP_SIGNAL = {
  id: "sig-2",
  receipt_id: RECEIPT_ID,
  signal: "image_hash_dup",
  severity: "block",
  score: 1,
  evidence: {
    matched_receipt_id: OTHER_RECEIPT_ID,
    hamming_distance: 2,
    matched_consumer_id: CONSUMER_ID,
    cross_consumer: false,
  },
  created_at: "2026-07-24T02:00:02.000Z",
};

interface World {
  receipts: Array<Record<string, unknown>>;
  signals: Array<Record<string, unknown>>;
  lineItems: Array<Record<string, unknown>>;
  profiles: Array<{ id: string; display_name: string }>;
  matchedReceipts: Array<Record<string, unknown>>;
}

function defaultWorld(): World {
  return {
    receipts: [RECEIPT_ROW],
    signals: [VELOCITY_SIGNAL, DUP_SIGNAL],
    lineItems: [
      {
        id: "li-1",
        raw_text: "PANDESAL x10",
        qty: 10,
        unit_price_centavos: 500,
        line_total_centavos: 5000,
        sort: 0,
      },
    ],
    profiles: [{ id: CONSUMER_ID, display_name: "Karla Reyes" }],
    matchedReceipts: [],
  };
}

/**
 * A responder that honours the business predicate the way Postgres would, so
 * "the query forgot its scope" and "the query is scoped" produce visibly
 * different results rather than the same fixture.
 */
function respondFrom(world: World): Responder {
  return (op) => {
    if (op.table === "receipts") {
      const businessId = filterValue(op, "eq", "business_id");
      const id = filterValue(op, "eq", "id");
      const status = filterValue(op, "eq", "status");
      const userId = filterValue(op, "eq", "user_id");
      const inIds = op.filters.find((f) => f.method === "in" && f.args[0] === "id");

      if (inIds !== undefined) {
        const ids = inIds.args[1] as string[];
        return {
          data: world.matchedReceipts.filter(
            (row) => ids.includes(row.id as string) && row.business_id === businessId,
          ),
          error: null,
        };
      }

      const rows = world.receipts.filter((row) => {
        if (businessId !== undefined && row.business_id !== businessId) return false;
        if (id !== undefined && row.id !== id) return false;
        if (status !== undefined && row.status !== status) return false;
        if (userId !== undefined && row.user_id !== userId) return false;
        return true;
      });
      return { data: rows, error: null };
    }

    if (op.table === "fraud_signals") {
      const businessId = filterValue(op, "eq", "business_id");
      if (businessId !== BUSINESS_ID) return { data: [], error: null };
      return { data: world.signals, error: null };
    }

    if (op.table === "receipt_line_items") {
      const businessId = filterValue(op, "eq", "business_id");
      if (businessId !== BUSINESS_ID) return { data: [], error: null };
      return { data: world.lineItems, error: null };
    }

    if (op.table === "profiles") {
      return { data: world.profiles, error: null };
    }

    return { data: [], error: null };
  };
}

// ===========================================================================

describe("countPendingReview", () => {
  it("scopes the count to the caller's business and to review status", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    const count = await countPendingReview(BUSINESS_ID, harness.deps);

    expect(count).toBe(1);
    const op = harness.opsFor("receipts")[0];
    expect(op).toBeDefined();
    expect(hasFilter(op!, "eq", "business_id", BUSINESS_ID)).toBe(true);
    expect(hasFilter(op!, "eq", "status", "review")).toBe(true);
  });

  it("returns null rather than a platform-wide count when the service role is absent", async () => {
    expect(await countPendingReview(BUSINESS_ID, null)).toBeNull();
  });

  // The badge and the dashboard tile both read this number, and 0 renders as
  // "Nothing waiting on you". A failed count is not entitled to say that, so it
  // has to be distinguishable from a genuine zero.
  it("returns null rather than zero when the count could not be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness(() => ({ data: null, error: { message: "timeout" } }));

    expect(await countPendingReview(BUSINESS_ID, harness.deps)).toBeNull();
  });
});

describe("listReviewQueue", () => {
  it("filters by business and by the requested status", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    await listReviewQueue(
      { businessId: BUSINESS_ID, status: "approved", viewerId: MANAGER_ID },
      harness.deps,
    );

    const op = harness.opsFor("receipts")[0];
    expect(hasFilter(op!, "eq", "business_id", BUSINESS_ID)).toBe(true);
    expect(hasFilter(op!, "eq", "status", "approved")).toBe(true);
  });

  it("returns nothing for a business that owns none of the rows", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    const items = await listReviewQueue(
      { businessId: OTHER_BUSINESS_ID, status: "review", viewerId: MANAGER_ID },
      harness.deps,
    );

    expect(items).toEqual([]);
  });

  // `[]` and null are different claims: the first says the queue is empty, the
  // second says we do not know. The screen renders the second as its
  // "cannot be loaded" alert instead of the empty state, whose copy tells the
  // manager every scan went through on its own.
  it("returns null rather than an empty queue when the read fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness(() => ({ data: null, error: { message: "connection reset" } }));

    const items = await listReviewQueue(
      { businessId: BUSINESS_ID, status: "review", viewerId: MANAGER_ID },
      harness.deps,
    );

    expect(items).toBeNull();
  });

  it("returns null rather than an empty queue when the service role is absent", async () => {
    const items = await listReviewQueue(
      { businessId: BUSINESS_ID, status: "review", viewerId: MANAGER_ID },
      null,
    );

    expect(items).toBeNull();
  });

  it("sorts the review queue oldest first and history newest first", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    await listReviewQueue(
      { businessId: BUSINESS_ID, status: "review", viewerId: MANAGER_ID },
      harness.deps,
    );
    expect(harness.opsFor("receipts")[0]?.filters).toContainEqual({
      method: "order",
      args: ["created_at", { ascending: true }],
    });

    const history = createHarness(respondFrom(world));
    await listReviewQueue(
      { businessId: BUSINESS_ID, status: "rejected", viewerId: MANAGER_ID },
      history.deps,
    );
    expect(history.opsFor("receipts")[0]?.filters).toContainEqual({
      method: "order",
      args: ["created_at", { ascending: false }],
    });
  });

  it("scopes the signal read to the same business", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    await listReviewQueue(
      { businessId: BUSINESS_ID, status: "review", viewerId: MANAGER_ID },
      harness.deps,
    );

    const op = harness.opsFor("fraud_signals")[0];
    expect(hasFilter(op!, "eq", "business_id", BUSINESS_ID)).toBe(true);
    expect(op!.filters).toContainEqual({ method: "in", args: ["receipt_id", [RECEIPT_ID]] });
  });

  it("summarises severity, signal count and the composite score per row", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    const items = await listReviewQueue(
      { businessId: BUSINESS_ID, status: "review", viewerId: MANAGER_ID },
      harness.deps,
    );
    const item = items?.[0];

    expect(item?.topSeverity).toBe("block");
    expect(item?.signalCount).toBe(2);
    // 0.7 x 0.4 (warn) + 1 x 1.0 (block) = 1.28, clamped to 1.
    expect(item?.fraudScore).toBe(1);
    expect(item?.consumerName).toBe("Karla Reyes");
  });

  it("flags the viewer's own submission, which the review service will refuse", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    const items = await listReviewQueue(
      { businessId: BUSINESS_ID, status: "review", viewerId: CONSUMER_ID },
      harness.deps,
    );

    expect(items?.[0]?.submittedByViewer).toBe(true);
  });
});

describe("loadReviewDecisionItem", () => {
  it("pairs the URL's receipt id with the resolved business id in one query", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    await loadReviewDecisionItem(
      { businessId: BUSINESS_ID, receiptId: RECEIPT_ID, viewerId: MANAGER_ID },
      harness.deps,
    );

    const op = harness.opsFor("receipts")[0];
    expect(hasFilter(op!, "eq", "id", RECEIPT_ID)).toBe(true);
    expect(hasFilter(op!, "eq", "business_id", BUSINESS_ID)).toBe(true);
  });

  it("returns null for a receipt belonging to another business", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    const item = await loadReviewDecisionItem(
      { businessId: OTHER_BUSINESS_ID, receiptId: RECEIPT_ID, viewerId: MANAGER_ID },
      harness.deps,
    );

    expect(item).toBeNull();
    // Nothing further was read: the tenancy failure short-circuits before the
    // signals, the line items, the profile, the history and the signed URL.
    expect(harness.opsFor("fraud_signals")).toHaveLength(0);
    expect(harness.signedUrls).toHaveLength(0);
  });

  it("mints a 5 minute signed URL from the stored object path", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    const item = await loadReviewDecisionItem(
      { businessId: BUSINESS_ID, receiptId: RECEIPT_ID, viewerId: MANAGER_ID },
      harness.deps,
    );

    expect(item?.imageUrl).toBe("https://signed");
    expect(harness.signedUrls).toEqual([
      { bucket: "receipts", path: `${CONSUMER_ID}/abc.jpg`, ttl: 300 },
    ]);
  });

  it("degrades to no image rather than failing the screen when signing fails", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world), null);

    const item = await loadReviewDecisionItem(
      { businessId: BUSINESS_ID, receiptId: RECEIPT_ID, viewerId: MANAGER_ID },
      harness.deps,
    );

    expect(item).not.toBeNull();
    expect(item?.imageUrl).toBeNull();
  });

  it("resolves a matched receipt only when it belongs to this business", async () => {
    const world = defaultWorld();
    world.matchedReceipts = [
      {
        id: OTHER_RECEIPT_ID,
        business_id: BUSINESS_ID,
        merchant_name: "SARI SARI EXPRESS",
        receipt_number: "0012344",
        receipt_date: "2026-07-23T00:00:00.000Z",
        total_centavos: 19_000,
        status: "approved",
        created_at: "2026-07-23T00:00:00.000Z",
      },
    ];
    const harness = createHarness(respondFrom(world));

    const item = await loadReviewDecisionItem(
      { businessId: BUSINESS_ID, receiptId: RECEIPT_ID, viewerId: MANAGER_ID },
      harness.deps,
    );

    const dup = item?.signals.find((signal) => signal.signal === "image_hash_dup");
    expect(dup?.matchedReceipt?.receiptId).toBe(OTHER_RECEIPT_ID);
    expect(dup?.matchedReceiptOutsideTenant).toBe(false);

    // The lookup itself carries the tenancy predicate.
    const lookup = harness
      .opsFor("receipts")
      .find((op) => op.filters.some((f) => f.method === "in" && f.args[0] === "id"));
    expect(hasFilter(lookup!, "eq", "business_id", BUSINESS_ID)).toBe(true);
  });

  it("reports a cross-tenant duplicate as existing without exposing it", async () => {
    const world = defaultWorld();
    // The pHash neighbour lives at ANOTHER business (the detector unions the
    // consumer's own history in, so this is a real case, not a hypothetical).
    world.matchedReceipts = [
      {
        id: OTHER_RECEIPT_ID,
        business_id: OTHER_BUSINESS_ID,
        merchant_name: "SOMEONE ELSE'S STORE",
        receipt_number: "9999",
        receipt_date: "2026-07-23T00:00:00.000Z",
        total_centavos: 100_000,
        status: "approved",
        created_at: "2026-07-23T00:00:00.000Z",
      },
    ];
    const harness = createHarness(respondFrom(world));

    const item = await loadReviewDecisionItem(
      { businessId: BUSINESS_ID, receiptId: RECEIPT_ID, viewerId: MANAGER_ID },
      harness.deps,
    );

    const dup = item?.signals.find((signal) => signal.signal === "image_hash_dup");
    expect(dup?.matchedReceipt).toBeNull();
    expect(dup?.matchedReceiptOutsideTenant).toBe(true);
    expect(JSON.stringify(item)).not.toContain("SOMEONE ELSE'S STORE");
  });

  it("scopes the line items and the consumer history to the business", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    const item = await loadReviewDecisionItem(
      { businessId: BUSINESS_ID, receiptId: RECEIPT_ID, viewerId: MANAGER_ID },
      harness.deps,
    );

    expect(item?.lineItems).toHaveLength(1);
    const lineItemOp = harness.opsFor("receipt_line_items")[0];
    expect(hasFilter(lineItemOp!, "eq", "business_id", BUSINESS_ID)).toBe(true);
    expect(hasFilter(lineItemOp!, "eq", "receipt_id", RECEIPT_ID)).toBe(true);

    const historyOp = harness
      .opsFor("receipts")
      .find((op) => op.filters.some((f) => f.method === "eq" && f.args[0] === "user_id"));
    expect(hasFilter(historyOp!, "eq", "business_id", BUSINESS_ID)).toBe(true);
    expect(hasFilter(historyOp!, "eq", "user_id", CONSUMER_ID)).toBe(true);

    const signalCountOp = harness
      .opsFor("fraud_signals")
      .find((op) => op.filters.some((f) => f.method === "eq" && f.args[0] === "consumer_id"));
    expect(hasFilter(signalCountOp!, "eq", "business_id", BUSINESS_ID)).toBe(true);
  });

  it("marks the viewer's own submission so the screen can explain it up front", async () => {
    const world = defaultWorld();
    const harness = createHarness(respondFrom(world));

    const item = await loadReviewDecisionItem(
      { businessId: BUSINESS_ID, receiptId: RECEIPT_ID, viewerId: CONSUMER_ID },
      harness.deps,
    );

    expect(item?.submittedByViewer).toBe(true);
  });
});

describe("parseParseMeta", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("narrows the shape written by the pipeline", () => {
    const meta = parseParseMeta(PARSE_META);
    expect(meta?.engine).toBe("parse/v1");
    expect(meta?.tier).toBe("heuristic");
    expect(meta?.fields.total_centavos).toEqual({ tier: "heuristic", present: true });
    expect(meta?.fields.receipt_date?.present).toBe(false);
    expect(meta?.ocrMeanConfidence).toBe(0.71);
    expect(meta?.notes).toEqual(["date_missing"]);
  });

  it("survives jsonb it has never seen rather than throwing at a reviewer", () => {
    expect(parseParseMeta(null)).toBeNull();
    expect(parseParseMeta("not an object")).toBeNull();
    expect(parseParseMeta([1, 2, 3])).toBeNull();

    const odd = parseParseMeta({ fields: { total_centavos: "nope" }, notes: [1, "keep"] });
    expect(odd?.fields).toEqual({});
    expect(odd?.notes).toEqual(["keep"]);
    expect(odd?.engine).toBeNull();
  });
});
