// @vitest-environment node
//
// The shared award path (doc 36 Stage 9: "no separate code path"). These tests
// exist because `process.test.ts` can only exercise this module through the
// whole pipeline, and the human review service will call it from a completely
// different direction. What is pinned here is the CONTRACT both callers rely
// on: who writes status='approved', what a zero price does, the exact RPC
// arguments, and the handling of every error string
// supabase/migrations/0018_award_receipt_points.sql can raise.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// "server-only" throws on import outside Next.js's react-server condition.
vi.mock("server-only", () => ({}));

import type { Database } from "@/lib/supabase/types";

import {
  AWARD_ERROR_HANDLING,
  awardApprovedReceipt,
  awardPoints,
  priceReceipt,
} from "./award";
import type { AwardDeps, AwardPlan, AwardReceipt, CampaignRow, PointsRuleRow } from "./award";

// ===========================================================================
// A fake Supabase client, same shape as the one process.test.ts uses
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
    this.op = { table, op: "select", columns: "*", payload: undefined, filters: [] };
  }

  select(columns?: string): this {
    this.op.columns = columns ?? "*";
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
  is(column: string, value: unknown): this {
    return this.filter("is", column, value);
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => {
        this.record(this.op);
        return this.respond(this.op);
      })
      .then(onFulfilled, onRejected);
  }
}

interface FakeSupabase {
  client: SupabaseClient<Database>;
  ops: FakeOp[];
  rpcCalls: Array<{ name: string; args: unknown }>;
  opsFor(table: string, op: FakeOp["op"]): FakeOp[];
}

function createFakeSupabase(input: {
  pointsRules?: PointsRuleRow[];
  campaigns?: CampaignRow[];
  rulesError?: FakeError;
  campaignsError?: FakeError;
  rpc?: FakeResult;
  updateError?: FakeError;
}): FakeSupabase {
  const ops: FakeOp[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const respond: Responder = (op) => {
    if (op.op === "update") {
      return { data: null, error: input.updateError ?? null };
    }
    if (op.table === "points_rules") {
      if (input.rulesError !== undefined) return { data: null, error: input.rulesError };
      return { data: input.pointsRules ?? [], error: null };
    }
    if (op.table === "campaigns") {
      if (input.campaignsError !== undefined) {
        return { data: null, error: input.campaignsError };
      }
      return { data: input.campaigns ?? [], error: null };
    }
    return { data: [], error: null };
  };

  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(input.rpc ?? { data: LEDGER_ROW_ID, error: null });
    },
  };

  return {
    client: client as unknown as SupabaseClient<Database>,
    ops,
    rpcCalls,
    opsFor: (table, op) => ops.filter((entry) => entry.table === table && entry.op === op),
  };
}

// ===========================================================================
// Fixtures
// ===========================================================================

const RECEIPT_ID = "01980000-0000-7000-8000-000000000001";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b1";
const LEDGER_ROW_ID = "01980000-0000-7000-8000-0000000000e1";
const NOW = new Date("2026-07-25T04:00:00.000Z");

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

// PHP 190.00, the same total the pipeline fixture parses to, so the arithmetic
// in both suites is comparable at a glance: floor(19000 / 100) = 190 points.
const RECEIPT: AwardReceipt = {
  id: RECEIPT_ID,
  createdAt: "2026-07-25T03:55:00.000Z",
  totalCentavos: 19_000,
  receiptDate: new Date("2026-07-24T05:45:00.000Z"),
};

function createDeps(supabase: FakeSupabase): AwardDeps {
  return { supabase: supabase.client, now: () => NOW };
}

function plan(overrides: Partial<AwardPlan> = {}): AwardPlan {
  return {
    points: 190,
    ruleSnapshot: { engine: "points/v1", total_points: 190 },
    campaignId: null,
    expiresAt: null,
    ...overrides,
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
// priceReceipt
// ===========================================================================

describe("priceReceipt", () => {
  it("prices a receipt from the business's active base rule", async () => {
    const supabase = createFakeSupabase({ pointsRules: [BASE_RULE] });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(190);
    expect(result.campaignId).toBeNull();
    // Doc 35 section 3: no expiry column exists on points_rules yet, so the
    // documented "never expires" is the only honest value.
    expect(result.expiresAt).toBeNull();
  });

  it("reads only active, undeleted rules of that business", async () => {
    const supabase = createFakeSupabase({ pointsRules: [BASE_RULE] });

    await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    const read = supabase.opsFor("points_rules", "select")[0];
    expect(read?.filters).toEqual([
      { method: "eq", args: ["business_id", BUSINESS_ID] },
      { method: "eq", args: ["is_active", true] },
      { method: "is", args: ["deleted_at", null] },
    ]);
  });

  it("prices at zero when the business has no active base rule", async () => {
    const supabase = createFakeSupabase({ pointsRules: [] });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(0);
    expect(result.campaignId).toBeNull();
  });

  it("prices at zero when the rules read fails, rather than guessing", async () => {
    const supabase = createFakeSupabase({ rulesError: { message: "boom" } });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(0);
  });

  it("evaluates conditions at receipt_date, not at processing time", async () => {
    // A floor of PHP 500.00 that this PHP 190.00 receipt cannot clear: the
    // base rule contributes nothing and the receipt prices at zero.
    const supabase = createFakeSupabase({
      pointsRules: [{ ...BASE_RULE, conditions: { min_amount_centavos: 50_000 } }],
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(0);
  });

  it("falls back to created_at when the receipt carries no date", async () => {
    const supabase = createFakeSupabase({ pointsRules: [BASE_RULE] });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: { ...RECEIPT, receiptDate: null },
      isFirstVisit: false,
    });

    expect(result.points).toBe(190);
    const snapshot = result.ruleSnapshot as Record<string, unknown>;
    expect((snapshot.receipt as Record<string, unknown>).receipt_date).toBeNull();
  });
});

// ===========================================================================
// Campaign stacking and the rule_snapshot
// ===========================================================================

describe("campaign stacking and rule_snapshot", () => {
  const CAMPAIGN: CampaignRow = {
    id: "01980000-0000-7000-8000-0000000000ca",
    type: "promotion",
    status: "active",
    starts_at: "2026-07-01T00:00:00.000Z",
    ends_at: "2026-08-01T00:00:00.000Z",
    timezone: "Asia/Manila",
    priority: 50,
    is_stackable: false,
  };

  const MULTIPLIER_RULE: PointsRuleRow = {
    ...BASE_RULE,
    id: "01980000-0000-7000-8000-0000000000r2",
    campaign_id: CAMPAIGN.id,
    kind: "multiplier",
    rate_centavos_per_point: null,
    multiplier: 2,
  };

  it("applies a live campaign multiplier and names its campaign on the plan", async () => {
    const supabase = createFakeSupabase({
      pointsRules: [BASE_RULE, MULTIPLIER_RULE],
      campaigns: [CAMPAIGN],
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    // base 190 + floor(190 x (2 - 1)) = 380, exactly as the pipeline suite
    // asserts end to end.
    expect(result.points).toBe(380);
    expect(result.campaignId).toBe(CAMPAIGN.id);
  });

  it("decorates the snapshot with campaign_id, priority and is_stackable", async () => {
    const supabase = createFakeSupabase({
      pointsRules: [BASE_RULE, MULTIPLIER_RULE],
      campaigns: [CAMPAIGN],
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    const snapshot = result.ruleSnapshot as Record<string, unknown>;
    expect(snapshot.total_points).toBe(380);
    expect((snapshot.receipt as Record<string, unknown>).id).toBe(RECEIPT_ID);
    expect((snapshot.receipt as Record<string, unknown>).total_centavos).toBe(19_000);
    expect(snapshot.computed_at).toBe(NOW.toISOString());

    const multipliers = snapshot.multipliers as Array<Record<string, unknown>>;
    expect(multipliers).toHaveLength(1);
    expect(multipliers[0]?.campaign_id).toBe(CAMPAIGN.id);
    expect(multipliers[0]?.priority).toBe(50);
    expect(multipliers[0]?.is_stackable).toBe(false);
    expect(snapshot.bonuses).toEqual([]);
  });

  it("ignores a campaign rule whose campaign is not live at receipt_date", async () => {
    const supabase = createFakeSupabase({
      pointsRules: [BASE_RULE, { ...MULTIPLIER_RULE, multiplier: 5 }],
      campaigns: [{ ...CAMPAIGN, status: "ended" }],
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(190);
    expect(result.campaignId).toBeNull();
  });

  it("lets a non-stackable campaign apply alone, dropping the lower-priority one", async () => {
    const stackable: CampaignRow = {
      ...CAMPAIGN,
      id: "01980000-0000-7000-8000-0000000000cb",
      priority: 90,
      is_stackable: true,
    };
    const supabase = createFakeSupabase({
      pointsRules: [
        BASE_RULE,
        MULTIPLIER_RULE,
        {
          ...MULTIPLIER_RULE,
          id: "01980000-0000-7000-8000-0000000000r3",
          campaign_id: stackable.id,
          multiplier: 3,
        },
      ],
      campaigns: [CAMPAIGN, stackable],
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    // Only the priority-50 exclusive campaign applies: 190 + 190 = 380, never
    // 190 + 190 + 380. Over-awarding is the expensive direction on a ledger.
    expect(result.points).toBe(380);
    expect(result.campaignId).toBe(CAMPAIGN.id);
  });
});

// ===========================================================================
// awardPoints - the money write
// ===========================================================================

describe("awardPoints", () => {
  it("calls award_receipt_points with the 0018 argument list verbatim", async () => {
    const supabase = createFakeSupabase({});
    const snapshot = { engine: "points/v1", total_points: 380 };

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({
        points: 380,
        ruleSnapshot: snapshot,
        campaignId: "01980000-0000-7000-8000-0000000000ca",
        expiresAt: "2027-01-01T00:00:00.000Z",
      }),
    });

    expect(supabase.rpcCalls).toHaveLength(1);
    expect(supabase.rpcCalls[0]?.name).toBe("award_receipt_points");
    expect(supabase.rpcCalls[0]?.args).toEqual({
      p_receipt_id: RECEIPT_ID,
      p_points: 380,
      p_rule_snapshot: snapshot,
      p_campaign_id: "01980000-0000-7000-8000-0000000000ca",
      p_expires_at: "2027-01-01T00:00:00.000Z",
    });
    expect(result).toEqual({
      kind: "awarded",
      points: 380,
      transactionId: LEDGER_ROW_ID,
    });
  });

  it("NEVER writes status='approved' itself; the caller owns that transition", async () => {
    // 0018 step 2 guards on the receipt already being 'approved', so the write
    // has to precede this call. The pipeline does it in `persistOutcome` and
    // the review service does it alongside reviewed_by/reviewed_at; if this
    // function ever started writing it too, one of them would be writing it
    // twice and the guard order would stop being reviewable in one place.
    const supabase = createFakeSupabase({});

    await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan(),
    });

    expect(supabase.opsFor("receipts", "update")).toHaveLength(0);
  });

  it("skips the LEDGER at zero points and records the visit instead", async () => {
    // The defect 0023 fixes: every business_customers counter used to be
    // maintained only inside 0018 step 6, so a tenant with no active base rule
    // kept approving receipts whose pair rows never advanced - and with
    // visit_count stuck at 0, isFirstVisit stayed true for every one of its
    // customers, so a later first_visit bonus would pay out to all of them.
    const supabase = createFakeSupabase({});

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({ points: 0 }),
    });

    expect(supabase.rpcCalls).toHaveLength(1);
    expect(supabase.rpcCalls[0]).toEqual({
      name: "record_receipt_visit",
      args: { p_receipt_id: RECEIPT_ID },
    });
    expect(supabase.opsFor("receipts", "update")).toHaveLength(0);
    expect(result).toEqual({ kind: "skipped_zero_points" });
  });

  it("never sends a negative price through the earn door, and still records the visit", async () => {
    const supabase = createFakeSupabase({});

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({ points: -5 }),
    });

    expect(supabase.rpcCalls.map((call) => call.name)).toEqual(["record_receipt_visit"]);
    expect(result).toEqual({ kind: "skipped_zero_points" });
  });

  it("does not call record_receipt_visit when points are awarded (0018 step 6b did it)", async () => {
    const supabase = createFakeSupabase({});

    await awardPoints({ deps: createDeps(supabase), receiptId: RECEIPT_ID, plan: plan() });

    expect(supabase.rpcCalls.map((call) => call.name)).toEqual(["award_receipt_points"]);
  });
});

// ===========================================================================
// record_receipt_visit failures (0023), handled exactly as award failures are
// ===========================================================================

describe("record_receipt_visit error handling (0023)", () => {
  // 0023 raises no message of its own: it reuses these three, so the severity
  // map and the never-throw contract apply unchanged.
  const VISIT_ERRORS = [
    "RECEIPT_NOT_AWARDABLE",
    "AWARD_RECEIPT_ID_REQUIRED",
    "CUSTOMER_RECORD_MISSING",
  ] as const;

  for (const message of VISIT_ERRORS) {
    it(`annotates the receipt with visit_failed:${message} and refuses`, async () => {
      const supabase = createFakeSupabase({ rpc: { data: null, error: { message } } });

      const result = await awardPoints({
        deps: createDeps(supabase),
        receiptId: RECEIPT_ID,
        plan: plan({ points: 0 }),
      });

      const update = supabase.opsFor("receipts", "update")[0];
      expect(update?.payload).toEqual({ reject_note: `visit_failed:${message}` });
      expect(update?.filters).toEqual([{ method: "eq", args: ["id", RECEIPT_ID] }]);
      expect(result).toEqual({
        kind: "refused",
        code: message,
        severity: AWARD_ERROR_HANDLING[message],
      });
    });
  }

  it("does not throw when even the annotation write fails", async () => {
    const supabase = createFakeSupabase({
      rpc: { data: null, error: { message: "RECEIPT_NOT_AWARDABLE" } },
      updateError: { message: "connection lost" },
    });

    await expect(
      awardPoints({
        deps: createDeps(supabase),
        receiptId: RECEIPT_ID,
        plan: plan({ points: 0 }),
      }),
    ).resolves.toEqual({
      kind: "refused",
      code: "RECEIPT_NOT_AWARDABLE",
      severity: "warn",
    });
  });
});

// ===========================================================================
// Every error string 0018 can raise
// ===========================================================================

describe("award RPC error handling (0018)", () => {
  // Verified line by line against supabase/migrations/0018_award_receipt_points
  // .sql: these six `raise exception ... message = '...'` strings are the
  // complete set, and every one of them is mapped. 0023 adds no seventh: it
  // reuses three of these so both RPCs share one taxonomy.
  const MIGRATION_ERRORS = [
    "AWARD_RECEIPT_ID_REQUIRED",
    "AWARD_POINTS_INVALID",
    "RECEIPT_NOT_AWARDABLE",
    "RECEIPT_ALREADY_AWARDED",
    "CUSTOMER_RECORD_MISSING",
    "CUSTOMER_BLACKLISTED",
  ] as const;

  it("maps every message 0018 raises, and nothing it does not", () => {
    expect(Object.keys(AWARD_ERROR_HANDLING).sort()).toEqual([...MIGRATION_ERRORS].sort());
  });

  it("treats RECEIPT_ALREADY_AWARDED as benign and annotates nothing", async () => {
    // The idempotent case: pt_receipt_earn_once did its job. Annotating here
    // would put a scary reject_note on a receipt that is correctly paid.
    const supabase = createFakeSupabase({
      rpc: { data: null, error: { message: "RECEIPT_ALREADY_AWARDED" } },
    });

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan(),
    });

    expect(supabase.opsFor("receipts", "update")).toHaveLength(0);
    expect(console.info).toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "refused",
      code: "RECEIPT_ALREADY_AWARDED",
      severity: "info",
    });
  });

  for (const message of MIGRATION_ERRORS.filter(
    (code) => code !== "RECEIPT_ALREADY_AWARDED",
  )) {
    it(`annotates the receipt with award_failed:${message}`, async () => {
      const supabase = createFakeSupabase({ rpc: { data: null, error: { message } } });

      const result = await awardPoints({
        deps: createDeps(supabase),
        receiptId: RECEIPT_ID,
        plan: plan(),
      });

      const update = supabase.opsFor("receipts", "update")[0];
      expect(update?.payload).toEqual({ reject_note: `award_failed:${message}` });
      expect(update?.filters).toEqual([{ method: "eq", args: ["id", RECEIPT_ID] }]);
      expect(result).toEqual({
        kind: "refused",
        code: message,
        severity: AWARD_ERROR_HANDLING[message],
      });
    });
  }

  it("logs the two mid-flight-state refusals at warn, not error", async () => {
    for (const message of ["RECEIPT_NOT_AWARDABLE", "CUSTOMER_BLACKLISTED"]) {
      expect(AWARD_ERROR_HANDLING[message]).toBe("warn");
    }
    const supabase = createFakeSupabase({
      rpc: { data: null, error: { message: "CUSTOMER_BLACKLISTED" } },
    });

    await awardPoints({ deps: createDeps(supabase), receiptId: RECEIPT_ID, plan: plan() });

    expect(console.warn).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs the three caller-bug refusals at error", async () => {
    for (const message of [
      "CUSTOMER_RECORD_MISSING",
      "AWARD_POINTS_INVALID",
      "AWARD_RECEIPT_ID_REQUIRED",
    ]) {
      expect(AWARD_ERROR_HANDLING[message]).toBe("error");
    }
    const supabase = createFakeSupabase({
      rpc: { data: null, error: { message: "AWARD_POINTS_INVALID" } },
    });

    await awardPoints({ deps: createDeps(supabase), receiptId: RECEIPT_ID, plan: plan() });

    expect(console.error).toHaveBeenCalled();
  });

  it("treats an unrecognized message as an error and still annotates", async () => {
    const supabase = createFakeSupabase({
      rpc: { data: null, error: { message: "SOMETHING_NEW" } },
    });

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan(),
    });

    expect(result).toEqual({
      kind: "refused",
      code: "SOMETHING_NEW",
      severity: "error",
    });
    expect(supabase.opsFor("receipts", "update")).toHaveLength(1);
  });

  it("does not throw when even the annotation write fails", async () => {
    const supabase = createFakeSupabase({
      rpc: { data: null, error: { message: "RECEIPT_NOT_AWARDABLE" } },
      updateError: { message: "connection lost" },
    });

    await expect(
      awardPoints({ deps: createDeps(supabase), receiptId: RECEIPT_ID, plan: plan() }),
    ).resolves.toEqual({
      kind: "refused",
      code: "RECEIPT_NOT_AWARDABLE",
      severity: "warn",
    });
  });
});

// ===========================================================================
// awardApprovedReceipt - the one call the review service makes
// ===========================================================================

describe("awardApprovedReceipt", () => {
  it("prices and awards in one call, with the priced points on the RPC", async () => {
    const supabase = createFakeSupabase({ pointsRules: [BASE_RULE] });

    const result = await awardApprovedReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(supabase.rpcCalls).toHaveLength(1);
    const args = supabase.rpcCalls[0]?.args as Record<string, unknown>;
    expect(args.p_receipt_id).toBe(RECEIPT_ID);
    expect(args.p_points).toBe(190);
    expect(result).toEqual({
      kind: "awarded",
      points: 190,
      transactionId: LEDGER_ROW_ID,
    });
  });

  it("approves at zero points without touching the ledger, but still records the visit", async () => {
    // The review service's zero-point path: a manager approves a receipt of a
    // tenant that has configured no earning. The CRM counters must still move,
    // or that tenant's customer list stays frozen at zero visits.
    const supabase = createFakeSupabase({ pointsRules: [] });

    const result = await awardApprovedReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(supabase.rpcCalls).toEqual([
      { name: "record_receipt_visit", args: { p_receipt_id: RECEIPT_ID } },
    ]);
    expect(supabase.opsFor("receipts", "update")).toHaveLength(0);
    expect(result).toEqual({ kind: "skipped_zero_points" });
  });

  it("awards on the corrected total a reviewer supplies, not a parsed one", async () => {
    // The whole reason `AwardReceipt` is not the receipts row: the review
    // service prices the values the manager fixed.
    const supabase = createFakeSupabase({ pointsRules: [BASE_RULE] });

    await awardApprovedReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: { ...RECEIPT, totalCentavos: 45_000 },
      isFirstVisit: false,
    });

    const args = supabase.rpcCalls[0]?.args as Record<string, unknown>;
    expect(args.p_points).toBe(450);
  });
});
