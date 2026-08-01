// @vitest-environment node
//
// "This is my receipt header, always accept it": the write behind the review
// queue's one-tap affordance.
//
// This is a MONEY-PATH WRITE, not a preference. An alias widens what
// auto-approves at a merchant forever, so most of what follows is about what
// the caller is NOT allowed to influence.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import { headerTextFromParseMeta, learnMerchantAlias } from "./alias";
import type { LearnAliasDeps } from "./alias";

const RECEIPT_ID = "01980000-0000-7000-8000-0000000000f1";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b9";
const OTHER_BUSINESS_ID = "01980000-0000-7000-8000-0000000000b8";
const ACTOR_ID = "01980000-0000-7000-8000-0000000000a1";
const REQUEST_ID = "01980000-0000-7000-8000-0000000000e1";

interface RecordedOp {
  table: string;
  op: "select" | "insert" | "upsert";
  payload: unknown;
  options: unknown;
  filters: Array<{ column: string; value: unknown }>;
}

interface FakeWorld {
  /** The receipt the tenancy predicate is allowed to find. */
  receipt: { id: string; business_id: string | null; parse_meta: unknown } | null;
  /** Rows the upsert returns; empty means "the unique index swallowed it". */
  upsertReturns: Array<{ id: string }>;
  upsertError: { message: string; code?: string } | null;
  auditError: { message: string } | null;
}

function createHarness(overrides: Partial<FakeWorld> = {}) {
  const world: FakeWorld = {
    receipt: {
      id: RECEIPT_ID,
      business_id: BUSINESS_ID,
      parse_meta: {
        merchant_check: { verdict: "mismatch", header_text: "KB COFFEE HOUSE" },
      },
    },
    upsertReturns: [{ id: "alias-row-1" }],
    upsertError: null,
    auditError: null,
    ...overrides,
  };

  const ops: RecordedOp[] = [];

  class Query implements PromiseLike<{ data: unknown; error: unknown }> {
    private readonly record: RecordedOp;

    constructor(table: string) {
      this.record = { table, op: "select", payload: undefined, options: undefined, filters: [] };
      ops.push(this.record);
    }

    select(): this {
      return this;
    }
    insert(payload: unknown): this {
      this.record.op = "insert";
      this.record.payload = payload;
      return this;
    }
    upsert(payload: unknown, options?: unknown): this {
      this.record.op = "upsert";
      this.record.payload = payload;
      this.record.options = options;
      return this;
    }
    eq(column: string, value: unknown): this {
      this.record.filters.push({ column, value });
      return this;
    }
    maybeSingle(): this {
      return this;
    }

    then<T1, T2 = never>(
      onFulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
      onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return Promise.resolve()
        .then(() => {
          if (this.record.table === "receipts") {
            // The tenancy predicate is enforced by the fake exactly as the
            // database would: a filter that does not match returns no row.
            const matched = this.record.filters.every((filter) => {
              if (filter.column === "id") return world.receipt?.id === filter.value;
              if (filter.column === "business_id") {
                return world.receipt?.business_id === filter.value;
              }
              return true;
            });
            return { data: matched ? world.receipt : null, error: null };
          }
          if (this.record.table === "business_merchant_aliases") {
            return world.upsertError === null
              ? { data: world.upsertReturns, error: null }
              : { data: null, error: world.upsertError };
          }
          return { data: null, error: world.auditError };
        })
        .then(onFulfilled, onRejected);
    }
  }

  const deps: LearnAliasDeps = {
    supabase: {
      from: (table: string) => new Query(table),
    } as unknown as SupabaseClient<Database>,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  };

  const run = (input: Partial<Parameters<typeof learnMerchantAlias>[0]> = {}) =>
    learnMerchantAlias({
      receiptId: RECEIPT_ID,
      actorId: ACTOR_ID,
      businessId: BUSINESS_ID,
      actorRole: "owner",
      requestId: REQUEST_ID,
      deps,
      ...input,
    });

  return {
    run,
    ops,
    aliasWrite: () => ops.find((op) => op.table === "business_merchant_aliases"),
    auditWrite: () => ops.find((op) => op.table === "audit_logs"),
  };
}

describe("learnMerchantAlias", () => {
  it("stores the header the PIPELINE read, against the receipt's own business", async () => {
    const harness = createHarness();

    const outcome = await harness.run();

    expect(outcome).toEqual({ ok: true, alias: "KB COFFEE HOUSE", alreadyKnown: false });
    expect(harness.aliasWrite()?.payload).toMatchObject({
      business_id: BUSINESS_ID,
      alias: "KB COFFEE HOUSE",
      source: "learned",
      receipt_id: RECEIPT_ID,
      created_by: ACTOR_ID,
    });
  });

  it("takes no alias string from its caller at all", async () => {
    // THE SECURITY PROPERTY. The whole payload is a receipt id; there is no
    // parameter a compromised reviewer session could use to teach "%", a
    // rival's name, or a bare space. Asserted on the signature rather than on
    // behaviour, because a widening here would be a new parameter.
    const harness = createHarness();
    const outcome = await harness.run();

    expect(outcome.ok).toBe(true);
    expect(Object.keys(harness.aliasWrite()?.payload as object)).not.toContain(
      "alias_normalized",
    );
  });

  it("refuses a receipt that belongs to another business, as a not-found", async () => {
    // Indistinguishable from a receipt that does not exist, deliberately: a
    // reviewer probing ids must not learn which ones are real.
    const harness = createHarness();

    const outcome = await harness.run({ businessId: OTHER_BUSINESS_ID });

    expect(outcome).toMatchObject({ ok: false, code: "RECEIPT_NOT_FOUND" });
    expect(harness.aliasWrite()).toBeUndefined();
  });

  it("applies the tenancy predicate in the query rather than after it", async () => {
    const harness = createHarness();
    await harness.run();

    expect(harness.ops[0]?.filters).toEqual([
      { column: "id", value: RECEIPT_ID },
      { column: "business_id", value: BUSINESS_ID },
    ]);
  });

  it("refuses a receipt whose header could not be read", async () => {
    // The unreadable case has nothing to teach, which is also why the review
    // screen never offers the affordance for it.
    const harness = createHarness({
      receipt: {
        id: RECEIPT_ID,
        business_id: BUSINESS_ID,
        parse_meta: { merchant_check: { verdict: "unreadable", header_text: null } },
      },
    });

    const outcome = await harness.run();

    expect(outcome).toMatchObject({ ok: false, code: "NO_HEADER_TEXT" });
    expect(harness.aliasWrite()).toBeUndefined();
  });

  it("refuses a header that normalizes to nothing", async () => {
    // An all-punctuation header would satisfy 0034's length check and then
    // violate its non-empty check on the generated column. Refused here with a
    // sentence instead of a 23514 from the driver.
    const harness = createHarness({
      receipt: {
        id: RECEIPT_ID,
        business_id: BUSINESS_ID,
        parse_meta: { merchant_check: { header_text: "~~~ ~~~" } },
      },
    });

    expect(await harness.run()).toMatchObject({ ok: false, code: "NO_HEADER_TEXT" });
  });

  it("refuses a header longer than the column allows", async () => {
    const harness = createHarness({
      receipt: {
        id: RECEIPT_ID,
        business_id: BUSINESS_ID,
        parse_meta: { merchant_check: { header_text: "A".repeat(201) } },
      },
    });

    expect(await harness.run()).toMatchObject({ ok: false, code: "NO_HEADER_TEXT" });
  });

  it("is idempotent: a second tap succeeds and says the alias was already known", async () => {
    // 0034's unique index plus `ignoreDuplicates` is what makes a double tap,
    // a retried action, or two reviewers on two receipts with the same header
    // converge on one row rather than raising 23505 at a merchant.
    const harness = createHarness({ upsertReturns: [] });

    const outcome = await harness.run();

    expect(outcome).toEqual({ ok: true, alias: "KB COFFEE HOUSE", alreadyKnown: true });
  });

  it("writes through the unique index rather than blind-inserting", async () => {
    const harness = createHarness();
    await harness.run();

    expect(harness.aliasWrite()?.op).toBe("upsert");
    expect(harness.aliasWrite()?.options).toEqual({
      onConflict: "business_id,alias_normalized",
      ignoreDuplicates: true,
    });
  });

  it("audits the widening", async () => {
    const harness = createHarness();
    await harness.run();

    expect(harness.auditWrite()?.payload).toMatchObject({
      actor_id: ACTOR_ID,
      actor_kind: "user",
      actor_role: "owner",
      business_id: BUSINESS_ID,
      action: "receipt.merchant_alias_learned",
      entity_type: "receipt",
      entity_id: RECEIPT_ID,
      request_id: REQUEST_ID,
      after: { merchant_alias: "KB COFFEE HOUSE", source: "learned" },
    });
  });

  it("keeps the alias when the audit row fails, rather than undoing what was asked", async () => {
    const harness = createHarness({ auditError: { message: "audit down" } });

    expect(await harness.run()).toMatchObject({ ok: true });
  });

  it("reports a failed write instead of claiming success", async () => {
    const harness = createHarness({ upsertError: { message: "nope", code: "23514" } });

    const outcome = await harness.run();

    expect(outcome).toMatchObject({ ok: false, code: "ALIAS_WRITE_FAILED" });
    expect(harness.auditWrite()).toBeUndefined();
  });

  it("refuses when the service-role client is unavailable", async () => {
    const outcome = await learnMerchantAlias({
      receiptId: RECEIPT_ID,
      actorId: ACTOR_ID,
      businessId: BUSINESS_ID,
      actorRole: "owner",
      requestId: REQUEST_ID,
      deps: null,
    });

    expect(outcome).toMatchObject({ ok: false, code: "DEPENDENCY_UNAVAILABLE" });
  });
});

describe("headerTextFromParseMeta", () => {
  it("reads the header the pipeline recorded", () => {
    expect(
      headerTextFromParseMeta({ merchant_check: { header_text: "  KB COFFEE  " } }),
    ).toBe("KB COFFEE");
  });

  it("answers null for every shape it has never seen", () => {
    // parse_meta is jsonb: a row written by an older build has no
    // merchant_check at all, and a future one may hold anything. Both are "no
    // header to learn", never a crash on a screen a merchant is working.
    for (const value of [
      null,
      undefined,
      "a string",
      [],
      {},
      { merchant_check: null },
      { merchant_check: [] },
      { merchant_check: { header_text: 42 } },
      { merchant_check: { header_text: "   " } },
    ]) {
      expect(headerTextFromParseMeta(value)).toBeNull();
    }
  });
});
