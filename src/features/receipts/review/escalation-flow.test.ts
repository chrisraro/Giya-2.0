// @vitest-environment node
//
// AN ESCALATED RECEIPT FLOWS THROUGH THE ORDINARY REVIEW PATH.
//
// This file lives in the review tree on purpose. It has to import both
// `listReviewQueue` and `reviewReceipt`, and isolation.test.ts allows the
// review tree to be imported only from inside itself, the business portal and
// the admin portal. That fence exists to keep 0017's withheld columns off
// consumer surfaces, so it was left alone and the test came here rather than
// the allowlist growing an entry for a suite under `server/`.
//
// WHAT IT PINS, and it is the most important assertion in the escalation slice:
//
//   ONE APPROVAL PATH. A merchant approving a receipt their customer contested
//   goes through `reviewReceipt` and therefore through `awardApprovedReceipt`
//   EXACTLY ONCE, with exactly one decision audit row, and with guard 4's
//   self-review block still standing. Doc 36 requires a single approval path so
//   the ledger invariants hold, and the whole escalation design is arranged
//   around not becoming a second one. A test that drove escalate.ts alone could
//   not see that, which is why this one runs the real review service against
//   the same in-memory database.
//
// Plus the merchant-facing half of the contract: the escalated receipt turns up
// in that tenant's queue, and it is MARKED, because the reviewer is answering a
// different question on it.
//
// The fake database and its `receipts_number_unique` are the same shape as
// ../server/escalate.test.ts, which is the house pattern here: review.test.ts,
// award.test.ts and process.test.ts each carry their own fake of the same shape
// rather than sharing one that would have to serve all of them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// "server-only" throws on import outside Next.js's react-server condition.
vi.mock("server-only", () => ({}));

// `src/lib/env.ts` validates NEXT_PUBLIC_* at MODULE scope and throws without
// them, so the transitive import through settings.ts has to be stubbed.
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

// Never reached (every test injects deps), but imported at module scope.
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

// The award path is REPLACED rather than wrapped, unlike review.test.ts. This
// suite is not re-testing pricing (award.test.ts owns that); it is asserting
// that an escalated receipt reaches that one shared function, once.
vi.mock("../server/award", () => ({
  awardApprovedReceipt: vi.fn(async () => ({ kind: "awarded" as const, points: 120 })),
}));

// The consumer notification is composed and swallowed elsewhere; stubbing it
// keeps this suite's database free of rows nothing under test reads.
vi.mock("../server/notify", () => ({ notifyReceiptOutcome: vi.fn(async () => undefined) }));

import type { Database } from "@/lib/supabase/types";

import { awardApprovedReceipt } from "../server/award";
import { escalateReceipt } from "../server/escalate";
import { reviewReceipt } from "../server/review";
import type { ReviewDeps } from "../server/review";
import { DEFAULT_RECEIPT_SETTINGS } from "../server/settings";
import { listReviewQueue } from "./queue";

// ===========================================================================
// A tiny in-memory Postgres, faithful about the one constraint that matters
// ===========================================================================

type Row = Record<string, unknown>;

interface FakeError {
  message: string;
  code?: string;
}

interface FakeResult {
  data: unknown;
  error: FakeError | null;
}

interface Filter {
  method: string;
  args: unknown[];
}

const LIVE_STATUSES = new Set(["approved", "review", "processing"]);

class FakeDb {
  readonly tables = new Map<string, Row[]>();

  rows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (rows === undefined) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  seed(table: string, rows: readonly Row[]): void {
    this.tables.set(table, rows.map((row) => ({ ...row })));
  }

  /**
   * `receipts_number_unique` (0017): a partial unique index on
   * (business_id, receipt_number) covering only approved/review/processing.
   * Rejected rows are excluded, which is what makes honest resubmission after a
   * rejection possible and what makes escalating one back into 'review' able to
   * collide.
   */
  violatesNumberUnique(candidate: Row): boolean {
    const number = candidate.receipt_number;
    if (number === null || number === undefined) return false;
    if (!LIVE_STATUSES.has(String(candidate.status))) return false;

    return this.rows("receipts").some(
      (row) =>
        row.id !== candidate.id &&
        row.business_id === candidate.business_id &&
        row.receipt_number === number &&
        LIVE_STATUSES.has(String(row.status)),
    );
  }
}

function matches(row: Row, filters: readonly Filter[]): boolean {
  for (const filter of filters) {
    const [column, value] = filter.args as [string, unknown];
    switch (filter.method) {
      case "eq":
        if (row[column] !== value) return false;
        break;
      case "neq":
        if (row[column] === value) return false;
        break;
      case "in":
        if (!(value as unknown[]).includes(row[column])) return false;
        break;
      case "is":
        if ((row[column] ?? null) !== null) return false;
        break;
      case "not": {
        // Only `.not(column, "is", null)` is used by the code under test.
        if ((row[column] ?? null) === null) return false;
        break;
      }
      case "gte":
        if ((row[column] as number) < (value as number)) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

class FakeQuery implements PromiseLike<FakeResult> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: unknown = undefined;
  private readonly filters: Filter[] = [];
  private single = false;
  private limitTo: number | null = null;

  constructor(
    private readonly table: string,
    private readonly db: FakeDb,
  ) {}

  select(): this {
    return this;
  }
  insert(payload: unknown): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: unknown): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }

  private filter(method: string, ...args: unknown[]): this {
    this.filters.push({ method, args });
    return this;
  }
  eq(c: string, v: unknown): this {
    return this.filter("eq", c, v);
  }
  neq(c: string, v: unknown): this {
    return this.filter("neq", c, v);
  }
  in(c: string, v: unknown[]): this {
    return this.filter("in", c, v);
  }
  is(c: string, v: unknown): this {
    return this.filter("is", c, v);
  }
  not(c: string, _op: string, v: unknown): this {
    return this.filter("not", c, v);
  }
  gte(c: string, v: unknown): this {
    return this.filter("gte", c, v);
  }
  order(): this {
    return this;
  }
  limit(n: number): this {
    this.limitTo = n;
    return this;
  }
  maybeSingle(): this {
    this.single = true;
    return this;
  }
  singleRow(): this {
    this.single = true;
    return this;
  }

  private run(): FakeResult {
    const rows = this.db.rows(this.table);

    if (this.op === "insert") {
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const inserted = incoming.map((row) => ({ id: `gen-${rows.length + 1}`, ...row }));
      for (const row of inserted) {
        if (this.table === "receipts" && this.db.violatesNumberUnique(row)) {
          return {
            data: null,
            error: {
              message:
                'duplicate key value violates unique constraint "receipts_number_unique"',
              code: "23505",
            },
          };
        }
      }
      rows.push(...inserted);
      return { data: inserted, error: null };
    }

    const hit = rows.filter((row) => matches(row, this.filters));

    if (this.op === "update") {
      const updates = this.payload as Row;
      // Constraint check BEFORE mutating, exactly as Postgres would: a
      // violating statement changes nothing.
      for (const row of hit) {
        const candidate = { ...row, ...updates };
        if (this.table === "receipts" && this.db.violatesNumberUnique(candidate)) {
          return {
            data: null,
            error: {
              message:
                'duplicate key value violates unique constraint "receipts_number_unique"',
              code: "23505",
            },
          };
        }
      }
      for (const row of hit) Object.assign(row, updates);
      return { data: hit.map((row) => ({ ...row })), error: null };
    }

    if (this.op === "delete") {
      for (const row of hit) {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
      }
      return { data: [], error: null };
    }

    const limited = this.limitTo === null ? hit : hit.slice(0, this.limitTo);
    return { data: limited.map((row) => ({ ...row })), error: null };
  }

  then<T1 = FakeResult, T2 = never>(
    onFulfilled?: ((value: FakeResult) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => {
        const result = this.run();
        if (!this.single) return result;
        if (result.error !== null) return result;
        const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
        return { data, error: null };
      })
      .then(onFulfilled, onRejected);
  }
}

function fakeClient(db: FakeDb): SupabaseClient<Database> {
  return {
    from: (table: string) => new FakeQuery(table, db),
  } as unknown as SupabaseClient<Database>;
}

// ===========================================================================
// Fixtures
// ===========================================================================

const BUSINESS = "b0000000-0000-4000-8000-000000000001";
const CONSUMER = "c0000000-0000-4000-8000-000000000001";
const MANAGER = "m0000000-0000-4000-8000-000000000001";
const RECEIPT = "r0000000-0000-4000-8000-000000000001";

const NOW = new Date("2026-08-01T10:00:00.000Z");

function rejectedReceipt(overrides: Row = {}): Row {
  return {
    id: RECEIPT,
    business_id: BUSINESS,
    user_id: CONSUMER,
    status: "rejected",
    reject_reason: "unreadable",
    reject_note: "top of the receipt was folded",
    receipt_number: "OR-2000",
    receipt_date: "2026-07-31T00:00:00.000Z",
    merchant_name: "SARI SARI EXPRESS",
    subtotal_centavos: 44_643,
    tax_centavos: 5_357,
    total_centavos: 50_000,
    created_at: "2026-07-31T09:00:00.000Z",
    escalated_at: null,
    processed_at: "2026-07-31T09:00:30.000Z",
    reviewed_by: null,
    reviewed_at: null,
    parse_meta: { review_reasons: ["parse_confidence_low"], engine: "parse/v1" },
    ...overrides,
  };
}

let db: FakeDb;
let supabase: SupabaseClient<Database>;
let reviewDeps: ReviewDeps;

beforeEach(() => {
  db = new FakeDb();
  db.seed("receipts", [rejectedReceipt()]);
  db.seed("business_staff", [
    { business_id: BUSINESS, user_id: MANAGER, status: "active", role: "manager" },
  ]);
  db.seed("audit_logs", []);
  db.seed("profiles", [{ id: CONSUMER, display_name: "Karla Reyes" }]);
  db.seed("fraud_signals", []);
  db.seed("business_customers", []);

  supabase = fakeClient(db);
  reviewDeps = {
    supabase,
    now: () => new Date("2026-08-01T11:00:00.000Z"),
    loadSettings: async () => DEFAULT_RECEIPT_SETTINGS,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function receiptRow(): Row {
  return db.rows("receipts").find((row) => row.id === RECEIPT) as Row;
}

function auditRows(action: string): Row[] {
  return db.rows("audit_logs").filter((row) => row.action === action);
}

async function escalate(actorId = CONSUMER) {
  return escalateReceipt({
    receiptId: RECEIPT,
    actorId,
    requestId: "req-escalate",
    deps: { supabase, now: () => NOW },
  });
}

async function decide(action: "approve" | "reject", actorId = MANAGER) {
  return reviewReceipt({
    receiptId: RECEIPT,
    actorId,
    action,
    ...(action === "reject" ? { rejectReason: "unreadable" } : {}),
    requestId: `req-${action}`,
    deps: reviewDeps,
  });
}

// ===========================================================================
// The merchant sees it, and sees what it is
// ===========================================================================

describe("an escalated receipt in the merchant's queue", () => {
  it("appears in that tenant's review queue", async () => {
    await escalate();

    const items = await listReviewQueue(
      { businessId: BUSINESS, status: "review", viewerId: MANAGER },
      { supabase, now: () => NOW },
    );

    expect(items).toHaveLength(1);
    expect(items?.[0]?.receiptId).toBe(RECEIPT);
  });

  it("CRITICAL - is MARKED as escalated, because it asks a different question", async () => {
    await escalate();

    const items = await listReviewQueue(
      { businessId: BUSINESS, status: "review", viewerId: MANAGER },
      { supabase, now: () => NOW },
    );

    expect(items?.[0]?.escalated).toBe(true);
  });

  it("does not mark the receipts the pipeline routed itself", async () => {
    db.seed("receipts", [
      rejectedReceipt({ id: "r-routed", status: "review", receipt_number: "OR-9000" }),
    ]);

    const items = await listReviewQueue(
      { businessId: BUSINESS, status: "review", viewerId: MANAGER },
      { supabase, now: () => NOW },
    );

    expect(items?.[0]?.escalated).toBe(false);
  });

  it("is invisible to another tenant's queue", async () => {
    await escalate();

    const items = await listReviewQueue(
      {
        businessId: "b0000000-0000-4000-8000-00000000ffff",
        status: "review",
        viewerId: MANAGER,
      },
      { supabase, now: () => NOW },
    );

    expect(items).toEqual([]);
  });
});

// ===========================================================================
// THE ONE THAT MATTERS: the single approval path
// ===========================================================================

describe("a merchant approving an escalated receipt", () => {
  it("CRITICAL - awards through the shared reviewReceipt path exactly once", async () => {
    await escalate();

    const outcome = await decide("approve");

    expect(outcome.ok).toBe(true);
    // ONE award call, through the one shared function. This is the assertion
    // doc 36's "one approval path so the ledger invariants hold" rests on:
    // escalation added no second route to the ledger.
    expect(awardApprovedReceipt).toHaveBeenCalledTimes(1);
    expect(receiptRow().status).toBe("approved");
  });

  it("prices from the receipt's own total, unchanged by the escalation", async () => {
    await escalate();
    await decide("approve");

    expect(awardApprovedReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS,
        receipt: expect.objectContaining({ id: RECEIPT, totalCentavos: 50_000 }),
      }),
    );
  });

  it("writes exactly one decision audit row, on top of the escalation's own", async () => {
    await escalate();
    await decide("approve");

    expect(auditRows("receipt.review_approved")).toHaveLength(1);
    expect(auditRows("receipt.escalation_requested")).toHaveLength(1);
  });

  it("clears the reject_reason on approval, as any other approval does", async () => {
    await escalate();
    await decide("approve");

    expect(receiptRow().reject_reason).toBeNull();
  });

  it("CRITICAL - still refuses a self-review, so escalation cannot route around guard 4", async () => {
    // A staff member's own rejected receipt, escalated by them. The insider
    // control has to survive the new entry point into the queue.
    db.seed("receipts", [rejectedReceipt({ user_id: MANAGER })]);
    await escalate(MANAGER);

    const outcome = await decide("approve");

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.code).toBe("FORBIDDEN");
    expect(awardApprovedReceipt).not.toHaveBeenCalled();
  });

  it("can be rejected again, and the escalation stays spent", async () => {
    await escalate();

    const outcome = await decide("reject");

    expect(outcome.ok).toBe(true);
    expect(receiptRow().status).toBe("rejected");
    // escalated_at survives the second rejection, which is what closes the loop:
    // ../server/escalate.test.ts asserts the refusal this makes reachable.
    expect(receiptRow().escalated_at).toBe(NOW.toISOString());
    expect(awardApprovedReceipt).not.toHaveBeenCalled();
  });
});
