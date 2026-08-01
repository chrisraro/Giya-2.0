// @vitest-environment node
//
// Contesting a rejection (0036).
//
// This is a MONEY path: an escalation that a merchant approves mints points. So
// what is pinned here is not "the happy path works" but the properties that
// make the feature safe to ship:
//
//   * THE OWNERSHIP FENCE holds server side, not in the UI.
//   * THE FRAUD FAMILY gets no escalation, so doc 37's retry loop stays closed.
//   * THE CAP is enforced and counts OPEN escalations.
//   * THE 23505 COLLISION never reaches a human as a database error.
//   * THE ATTRIBUTION names itself, so 0035's breakdown does not credit the
//     rule that rejected the receipt originally.
//
// THE ONE APPROVAL PATH is asserted in ../review/escalation-flow.test.ts
// rather than here. That assertion has to drive `reviewReceipt` and
// `listReviewQueue`, and review/isolation.test.ts allows the review tree to be
// imported only from inside itself, the business portal and the admin portal.
// Widening that allowlist for a test would be widening a fence that exists to
// keep withheld columns off consumer surfaces, so the test moved to the tree
// instead.
//
// THE FAKE DATABASE ENFORCES `receipts_number_unique`. That is deliberate and
// is the difference between a test and a fixture: the collision this feature
// has to survive is a real partial unique index (0017), it is proved reachable
// against the live database by receipt_escalation_smoke.sql test 7, and a fake
// that did not model it would let the SUPERSEDED branch rot untested.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// "server-only" throws on import outside Next.js's react-server condition.
vi.mock("server-only", () => ({}));

// `src/lib/env.ts` validates NEXT_PUBLIC_* at MODULE scope and throws without
// them, so the transitive import through settings.ts has to be stubbed.
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

// Never reached (every test injects deps), but imported at module scope.
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import { MAX_OPEN_ESCALATIONS } from "../components/receipt-copy";
import { escalateReceipt, withEscalationReason } from "./escalate";
import type { EscalateDeps } from "./escalate";

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
const STRANGER = "c0000000-0000-4000-8000-000000000002";
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
let deps: EscalateDeps;

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

  deps = { supabase: fakeClient(db), now: () => NOW };
});

afterEach(() => {
  vi.clearAllMocks();
});

function receiptRow(id = RECEIPT): Row {
  return db.rows("receipts").find((row) => row.id === id) as Row;
}

function auditRows(action: string): Row[] {
  return db.rows("audit_logs").filter((row) => row.action === action);
}

async function escalate(actorId = CONSUMER, receiptId = RECEIPT) {
  return escalateReceipt({ receiptId, actorId, requestId: "req-escalate", deps });
}

// ===========================================================================
// The happy path, end to end
// ===========================================================================

describe("a consumer escalates their own rejected receipt", () => {
  it("moves it into the merchant's queue", async () => {
    const outcome = await escalate();

    expect(outcome).toEqual({ ok: true, receiptId: RECEIPT });

    const row = receiptRow();
    expect(row.status).toBe("review");
    expect(row.escalated_at).toBe(NOW.toISOString());
  });

  it("keeps the reject_reason, because the machine's verdict IS the question", async () => {
    await escalate();
    expect(receiptRow().reject_reason).toBe("unreadable");
  });

  it("clears processed_at, so 0018's award-pending marker stays meaningful", async () => {
    await escalate();
    expect(receiptRow().processed_at).toBeNull();
  });

  it("clears reviewed_by and reviewed_at: no human decided this state", async () => {
    db.seed("receipts", [
      rejectedReceipt({ reviewed_by: MANAGER, reviewed_at: "2026-07-31T09:00:30.000Z" }),
    ]);

    await escalate();

    expect(receiptRow().reviewed_by).toBeNull();
    expect(receiptRow().reviewed_at).toBeNull();
  });
});

// ===========================================================================
// The ownership fence
// ===========================================================================

describe("only the submitter may escalate", () => {
  it("CRITICAL - another consumer cannot escalate it", async () => {
    const outcome = await escalate(STRANGER);

    expect(outcome.ok).toBe(false);
    // Nothing was written. The guard is not merely an error return.
    expect(receiptRow().status).toBe("rejected");
    expect(receiptRow().escalated_at).toBeNull();
  });

  it("answers a stranger with the SAME sentence as a missing receipt, so it is no id oracle", async () => {
    const notMine = await escalate(STRANGER);
    const missing = await escalate(CONSUMER, "r0000000-0000-4000-8000-00000000dead");

    expect(notMine.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (notMine.ok || missing.ok) throw new Error("expected both to refuse");
    expect(notMine.refusal).toBe("NOT_FOUND");
    expect(notMine.message).toBe(missing.message);
  });

  it("writes no audit row for a refused escalation", async () => {
    await escalate(STRANGER);
    expect(db.rows("audit_logs")).toHaveLength(0);
  });
});

// ===========================================================================
// The fraud family (doc 37)
// ===========================================================================

describe("the fraud family offers no escalation", () => {
  it("CRITICAL - fraud_suspected cannot be escalated, so no retry loop against a human exists", async () => {
    db.seed("receipts", [rejectedReceipt({ reject_reason: "fraud_suspected" })]);

    const outcome = await escalate();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal).toBe("NOT_ESCALATABLE");
    expect(receiptRow().status).toBe("rejected");
  });

  it("duplicate cannot be escalated either: it is fraud family and already took a strike", async () => {
    db.seed("receipts", [rejectedReceipt({ reject_reason: "duplicate" })]);

    const outcome = await escalate();

    expect(outcome.ok).toBe(false);
    expect(receiptRow().status).toBe("rejected");
  });

  it("the copy never names which check refused, only that this route is closed", async () => {
    db.seed("receipts", [rejectedReceipt({ reject_reason: "fraud_suspected" })]);
    const outcome = await escalate();
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.message).not.toMatch(/fraud|suspect|duplicate|score|check/i);
  });

  it("allows every quality and matching outcome through", async () => {
    for (const reason of ["unreadable", "wrong_business", "too_old", "manual"] as const) {
      db.seed("receipts", [rejectedReceipt({ reject_reason: reason })]);
      const outcome = await escalate();
      expect(outcome.ok, reason).toBe(true);
    }
  });
});

// ===========================================================================
// Status and repeat guards
// ===========================================================================

describe("what cannot be escalated", () => {
  it("refuses a receipt that is not rejected", async () => {
    for (const status of ["queued", "processing", "review", "approved"] as const) {
      db.seed("receipts", [rejectedReceipt({ status })]);
      const outcome = await escalate();
      expect(outcome.ok, status).toBe(false);
    }
  });

  it("CRITICAL - refuses a second escalation, so a re-rejection cannot become a loop", async () => {
    // The merchant looked and rejected again: back at 'rejected', with a reason
    // that is still escalatable. escalated_at is the only thing standing in the
    // way of an argument conducted through a queue.
    db.seed("receipts", [
      rejectedReceipt({ escalated_at: "2026-07-31T12:00:00.000Z", reject_reason: "unreadable" }),
    ]);

    const outcome = await escalate();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal).toBe("ALREADY_ESCALATED");
    expect(receiptRow().status).toBe("rejected");
  });

  it("refuses a receipt with no business, which would land in a queue nobody can open", async () => {
    db.seed("receipts", [rejectedReceipt({ business_id: null })]);
    const outcome = await escalate();
    expect(outcome.ok).toBe(false);
    expect(receiptRow().status).toBe("rejected");
  });
});

// ===========================================================================
// The cap
// ===========================================================================

describe("the per-consumer cap on OPEN escalations", () => {
  function openEscalation(index: number, userId = CONSUMER): Row {
    return rejectedReceipt({
      id: `open-${index}`,
      user_id: userId,
      status: "review",
      escalated_at: "2026-07-31T12:00:00.000Z",
      receipt_number: `OPEN-${index}`,
    });
  }

  it("CRITICAL - refuses once the consumer is at the cap", async () => {
    db.seed("receipts", [
      rejectedReceipt(),
      ...Array.from({ length: MAX_OPEN_ESCALATIONS }, (_, index) => openEscalation(index)),
    ]);

    const outcome = await escalate();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal).toBe("LIMIT_REACHED");
    expect(receiptRow().status).toBe("rejected");
  });

  it("allows one more while the consumer is one under the cap", async () => {
    db.seed("receipts", [
      rejectedReceipt(),
      ...Array.from({ length: MAX_OPEN_ESCALATIONS - 1 }, (_, index) => openEscalation(index)),
    ]);

    expect((await escalate()).ok).toBe(true);
  });

  it("counts OPEN escalations only: a decided one frees the slot", async () => {
    // Same number of escalated receipts as the cap, but they have all been
    // decided. A lifetime cap would refuse here, which would punish exactly the
    // customer this feature exists for.
    db.seed("receipts", [
      rejectedReceipt(),
      ...Array.from({ length: MAX_OPEN_ESCALATIONS }, (_, index) => ({
        ...openEscalation(index),
        status: "approved",
      })),
    ]);

    expect((await escalate()).ok).toBe(true);
  });

  it("is per consumer: another customer's open escalations do not count", async () => {
    db.seed("receipts", [
      rejectedReceipt(),
      ...Array.from({ length: MAX_OPEN_ESCALATIONS }, (_, index) =>
        openEscalation(index, STRANGER),
      ),
    ]);

    expect((await escalate()).ok).toBe(true);
  });
});

// ===========================================================================
// The receipt-number collision (0017's receipts_number_unique)
// ===========================================================================

describe("the receipt-number collision", () => {
  /**
   * The commonest way to reach this, and it is entirely innocent: the first
   * scan was rejected as unreadable, the customer retook the photo, the second
   * scan was APPROVED, and only later did they tap the button on the first one.
   * `receipts_number_unique` covers approved/review/processing and excludes
   * rejected, so moving the old row back into 'review' would create a second
   * live claim on one receipt number at one business.
   */
  function seedWithLiveClaimant(): void {
    db.seed("receipts", [
      rejectedReceipt(),
      rejectedReceipt({
        id: "r-resubmitted",
        status: "approved",
        reject_reason: null,
        escalated_at: null,
      }),
    ]);
  }

  it("CRITICAL - refuses with a sentence, never a raw database error", async () => {
    seedWithLiveClaimant();

    const outcome = await escalate();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal).toBe("SUPERSEDED");
    // A person reads this. It must not contain a constraint name, an SQLSTATE
    // or anything else that leaked out of Postgres.
    expect(outcome.message).not.toMatch(/23505|constraint|violat|receipts_number_unique|null/i);
    expect(outcome.message.length).toBeGreaterThan(20);
  });

  it("leaves the receipt exactly as it was", async () => {
    seedWithLiveClaimant();
    await escalate();

    expect(receiptRow().status).toBe("rejected");
    expect(receiptRow().escalated_at).toBeNull();
  });

  it("names no other receipt and no other person", async () => {
    seedWithLiveClaimant();
    const outcome = await escalate();
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.message).not.toContain("OR-2000");
    expect(outcome.message).not.toContain("r-resubmitted");
  });

  it("CRITICAL - catches the 23505 when the claimant appears after the pre-check", async () => {
    // The window between the pre-check read and the write is real. The database
    // is the only thing that closes it, and its error must still become a
    // sentence. Modelled by making the claimant live only once the pre-check
    // has already run.
    db.seed("receipts", [
      rejectedReceipt(),
      rejectedReceipt({ id: "r-racer", status: "rejected", escalated_at: null }),
    ]);

    let preCheckDone = false;
    const racingClient = {
      from: (table: string) => {
        if (table === "receipts" && preCheckDone) {
          const racer = db.rows("receipts").find((row) => row.id === "r-racer");
          if (racer !== undefined) racer.status = "approved";
        }
        if (table === "receipts") preCheckDone = true;
        return new FakeQuery(table, db);
      },
    } as unknown as SupabaseClient<Database>;

    const outcome = await escalateReceipt({
      receiptId: RECEIPT,
      actorId: CONSUMER,
      requestId: "req-race",
      deps: { supabase: racingClient, now: () => NOW },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal).toBe("SUPERSEDED");
    expect(outcome.message).not.toMatch(/23505/);
  });

  it("does not refuse a receipt whose number is only held by another REJECTED row", async () => {
    // Two rejected rows may share a number quite legally: that exclusion is
    // what makes honest resubmission possible in the first place.
    db.seed("receipts", [
      rejectedReceipt(),
      rejectedReceipt({ id: "r-other-rejected", escalated_at: null }),
    ]);

    expect((await escalate()).ok).toBe(true);
  });

  it("escalates a receipt with no receipt number at all", async () => {
    db.seed("receipts", [rejectedReceipt({ receipt_number: null })]);
    expect((await escalate()).ok).toBe(true);
  });
});

// ===========================================================================
// Routing attribution (0035)
// ===========================================================================

describe("the escalation names itself in the routing attribution", () => {
  it("appends consumer_escalation to parse_meta.review_reasons", async () => {
    await escalate();

    const meta = receiptRow().parse_meta as { review_reasons: string[] };
    expect(meta.review_reasons).toContain("consumer_escalation");
  });

  it("keeps the reason that rejected it originally, because both are true", async () => {
    await escalate();

    const meta = receiptRow().parse_meta as { review_reasons: string[] };
    expect(meta.review_reasons).toEqual(["parse_confidence_low", "consumer_escalation"]);
  });

  it("preserves the rest of parse_meta rather than assigning over it", async () => {
    await escalate();
    expect((receiptRow().parse_meta as { engine: string }).engine).toBe("parse/v1");
  });

  it("starts a list on a receipt that had no parse_meta at all", async () => {
    db.seed("receipts", [rejectedReceipt({ parse_meta: null })]);
    await escalate();

    const meta = receiptRow().parse_meta as { review_reasons: string[] };
    expect(meta.review_reasons).toEqual(["consumer_escalation"]);
  });
});

describe("withEscalationReason", () => {
  it("degrades a malformed parse_meta to a fresh list rather than throwing", () => {
    for (const junk of [null, undefined, "a string", 42, ["an array"]]) {
      expect(withEscalationReason(junk)).toEqual({ review_reasons: ["consumer_escalation"] });
    }
  });

  it("drops non-string members of an existing list without losing the real ones", () => {
    expect(withEscalationReason({ review_reasons: ["fraud_composite", 7, null] })).toEqual({
      review_reasons: ["fraud_composite", "consumer_escalation"],
    });
  });

  it("never records itself twice", () => {
    expect(withEscalationReason({ review_reasons: ["consumer_escalation"] })).toEqual({
      review_reasons: ["consumer_escalation"],
    });
  });
});

// ===========================================================================
// The audit record
// ===========================================================================

describe("the escalation is audited", () => {
  it("writes exactly one append-only record of the REQUEST", async () => {
    await escalate();

    const rows = auditRows("receipt.escalation_requested");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entity_id).toBe(RECEIPT);
    expect(rows[0]?.actor_id).toBe(CONSUMER);
    expect(rows[0]?.business_id).toBe(BUSINESS);
  });

  it("records the actor as a consumer, the first non-staff actor in the log", async () => {
    await escalate();

    const row = auditRows("receipt.escalation_requested")[0];
    expect(row?.actor_kind).toBe("user");
    expect(row?.actor_role).toBe("consumer");
  });

  it("uses a dot-namespaced verb, per 0022's audit_logs_action_shape", async () => {
    await escalate();
    expect(String(auditRows("receipt.escalation_requested")[0]?.action)).toMatch(
      /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    );
  });

  it("minimizes the diff: no reject_note, no parse_meta, no image", async () => {
    await escalate();

    const row = auditRows("receipt.escalation_requested")[0];
    const serialized = JSON.stringify({ before: row?.before, after: row?.after });
    expect(serialized).not.toContain("folded");
    expect(serialized).not.toContain("parse/v1");
    expect(serialized).not.toContain("image");
  });

  it("does not undo the escalation when the audit insert fails", async () => {
    // The opposite rule to review.ts, and deliberately: this path mints
    // nothing, so failing closed would cost a customer their only remedy to
    // protect a record that duplicates the row's own state.
    const failing = {
      from: (table: string) =>
        table === "audit_logs"
          ? ({
              insert: async () => ({ data: null, error: { message: "nope", code: "XX000" } }),
            } as unknown as FakeQuery)
          : new FakeQuery(table, db),
    } as unknown as SupabaseClient<Database>;

    const outcome = await escalateReceipt({
      receiptId: RECEIPT,
      actorId: CONSUMER,
      requestId: "req-audit-fail",
      deps: { supabase: failing, now: () => NOW },
    });

    expect(outcome.ok).toBe(true);
    expect(receiptRow().status).toBe("review");
  });
});

// ===========================================================================
// Degraded dependencies
// ===========================================================================

describe("degraded dependencies", () => {
  it("refuses with a sentence when the service-role client is absent", async () => {
    const outcome = await escalateReceipt({
      receiptId: RECEIPT,
      actorId: CONSUMER,
      requestId: "req-nodeps",
      deps: null,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal).toBe("UNAVAILABLE");
  });

  it("refuses rather than proceeding when the cap could not be counted", async () => {
    // A failed read proves nothing about the cap, and the direction to fail in
    // is the one that cannot flood a merchant's queue.
    let receiptReads = 0;
    const flaky = {
      from: (table: string) => {
        if (table === "receipts") {
          receiptReads += 1;
          if (receiptReads === 2) {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    not: () => ({
                      limit: async () => ({
                        data: null,
                        error: { message: "connection reset" },
                      }),
                    }),
                  }),
                }),
              }),
            } as unknown as FakeQuery;
          }
        }
        return new FakeQuery(table, db);
      },
    } as unknown as SupabaseClient<Database>;

    const outcome = await escalateReceipt({
      receiptId: RECEIPT,
      actorId: CONSUMER,
      requestId: "req-flaky",
      deps: { supabase: flaky, now: () => NOW },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.refusal).toBe("UNAVAILABLE");
    expect(receiptRow().status).toBe("rejected");
  });
});
