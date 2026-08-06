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
  gt(column: string, value: unknown): this {
    return this.filter("gt", column, value);
  }
  gte(column: string, value: unknown): this {
    return this.filter("gte", column, value);
  }
  lt(column: string, value: unknown): this {
    return this.filter("lt", column, value);
  }
  limit(count: number): this {
    return this.filter("limit", count);
  }
  single(): this {
    return this.filter("single");
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
  // Default response for award_receipt_points / record_receipt_visit calls.
  rpc?: FakeResult;
  // FIFO queue consumed specifically by award_receipt_points calls, one entry
  // per call: lets a test make the FIRST call raise FIXED_PER_VISIT_RACE and
  // the RETRY (C2 recovery) succeed, without touching `rpc` above.
  awardRpcQueue?: FakeResult[];
  updateError?: FakeError;
  // The fixed_per_visit VISIT-DAY precheck (`priceReceipt` calling the 0038
  // RPC `fixed_per_visit_already_paid` before pricing). `true` simulates a
  // prior PAID fixed_per_visit earn already existing for this visit day.
  fixedPerVisitAlreadyPaid?: boolean;
  fixedPerVisitCheckError?: FakeError;
  // The receipts row `persistFixedPerVisitDedupeMarker` reads before merging
  // its parse_meta update (C3).
  receiptParseMeta?: Record<string, unknown> | null;
  receiptReadError?: FakeError;
}): FakeSupabase {
  const ops: FakeOp[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const awardRpcQueue = input.awardRpcQueue !== undefined ? [...input.awardRpcQueue] : undefined;

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
    if (op.table === "receipts" && op.op === "select") {
      if (input.receiptReadError !== undefined) {
        return { data: null, error: input.receiptReadError };
      }
      return { data: { parse_meta: input.receiptParseMeta ?? null }, error: null };
    }
    return { data: [], error: null };
  };

  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "fixed_per_visit_already_paid") {
        if (input.fixedPerVisitCheckError !== undefined) {
          return Promise.resolve({ data: null, error: input.fixedPerVisitCheckError });
        }
        return Promise.resolve({ data: input.fixedPerVisitAlreadyPaid ?? false, error: null });
      }
      if (name === "award_receipt_points" && awardRpcQueue !== undefined && awardRpcQueue.length > 0) {
        return Promise.resolve(awardRpcQueue.shift() as FakeResult);
      }
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
const USER_ID = "01980000-0000-7000-8000-0000000000c1";
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

// A fixed_per_visit base, for the same-day dedupe suite: 10 points per visit.
const FIXED_VISIT_RULE: PointsRuleRow = {
  ...BASE_RULE,
  id: "01980000-0000-7000-8000-0000000000r9",
  rule_type: "fixed_per_visit",
  rate_centavos_per_point: null,
  fixed_points: 10,
};

// PHP 190.00, the same total the pipeline fixture parses to, so the arithmetic
// in both suites is comparable at a glance: floor(19000 / 100) = 190 points.
const RECEIPT: AwardReceipt = {
  id: RECEIPT_ID,
  userId: USER_ID,
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
    verifyNoPriorFixedPerVisitEarn: false,
    dedupedFallback: null,
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
// priceReceipt: fixed_per_visit same-day dedupe (task 1.1)
// ===========================================================================

describe("priceReceipt: fixed_per_visit VISIT-DAY dedupe (C1 fix)", () => {
  it("pays normally when no prior paid fixed_per_visit earn exists for this visit day", async () => {
    const supabase = createFakeSupabase({
      pointsRules: [FIXED_VISIT_RULE],
      fixedPerVisitAlreadyPaid: false,
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(10);
    expect(result.verifyNoPriorFixedPerVisitEarn).toBe(true);
    const snapshot = result.ruleSnapshot as { base: { fixed_per_visit_deduped: boolean } };
    expect(snapshot.base.fixed_per_visit_deduped).toBe(false);
    // C2: a fallback is precomputed so a race can recover without a second
    // implementation of the rule math - here that fallback is the deduped
    // total (0, no bonus configured).
    expect(result.dedupedFallback).toEqual({
      points: 0,
      ruleSnapshot: expect.objectContaining({
        base: expect.objectContaining({ points: 0, fixed_per_visit_deduped: true }),
      }),
    });
  });

  it("suppresses the base to 0 and records the dedupe when a prior paid earn exists for this visit day", async () => {
    const supabase = createFakeSupabase({
      pointsRules: [FIXED_VISIT_RULE],
      fixedPerVisitAlreadyPaid: true,
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(0);
    expect(result.verifyNoPriorFixedPerVisitEarn).toBe(false);
    // Nothing to recover to: the precheck already applied the dedupe.
    expect(result.dedupedFallback).toBeNull();
    const snapshot = result.ruleSnapshot as { base: { points: number; fixed_per_visit_deduped: boolean } };
    expect(snapshot.base.points).toBe(0);
    expect(snapshot.base.fixed_per_visit_deduped).toBe(true);
  });

  it("still pays an independent bonus when the fixed base is deduped", async () => {
    const bonus: PointsRuleRow = {
      ...FIXED_VISIT_RULE,
      id: "01980000-0000-7000-8000-0000000000rb",
      kind: "bonus",
      fixed_points: null,
      bonus_points: 5,
      rule_type: "amount_rate",
    };
    const supabase = createFakeSupabase({
      pointsRules: [FIXED_VISIT_RULE, bonus],
      fixedPerVisitAlreadyPaid: true,
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(5);
    // A positive total was still reached by dedupe (bonus alone), so the RPC
    // must NOT re-verify: that prior earn is precisely why the base is 0, and
    // re-verifying would wrongly refuse the legitimate bonus-only award.
    expect(result.verifyNoPriorFixedPerVisitEarn).toBe(false);
    expect(result.dedupedFallback).toBeNull();
  });

  it("precomputes a positive dedupedFallback (independent bonus) when the precheck has NOT yet found the prior earn", async () => {
    const bonus: PointsRuleRow = {
      ...FIXED_VISIT_RULE,
      id: "01980000-0000-7000-8000-0000000000rb",
      kind: "bonus",
      fixed_points: null,
      bonus_points: 5,
      rule_type: "amount_rate",
    };
    const supabase = createFakeSupabase({
      pointsRules: [FIXED_VISIT_RULE, bonus],
      fixedPerVisitAlreadyPaid: false,
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    // Primary (undeduped) plan: base 10 + bonus 5 = 15.
    expect(result.points).toBe(15);
    expect(result.verifyNoPriorFixedPerVisitEarn).toBe(true);
    // Fallback, priced as if the prior earn WAS found: base suppressed to 0,
    // bonus (never derived from base) still pays -> 5.
    expect(result.dedupedFallback).toEqual({
      points: 5,
      ruleSnapshot: expect.objectContaining({
        base: expect.objectContaining({ points: 0, fixed_per_visit_deduped: true }),
      }),
    });
  });

  it("never calls fixed_per_visit_already_paid for a non-fixed_per_visit base", async () => {
    const supabase = createFakeSupabase({ pointsRules: [BASE_RULE] });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(supabase.rpcCalls.map((call) => call.name)).not.toContain(
      "fixed_per_visit_already_paid",
    );
    expect(result.verifyNoPriorFixedPerVisitEarn).toBe(false);
    expect(result.dedupedFallback).toBeNull();
  });

  it("calls fixed_per_visit_already_paid with the receipt's VISIT day, not the processing day (C1)", async () => {
    const supabase = createFakeSupabase({ pointsRules: [FIXED_VISIT_RULE] });

    await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    // RECEIPT.receiptDate is 2026-07-24T05:45Z (Manila day 2026-07-24), while
    // `now` (NOW, used only for computed_at) is 2026-07-25T04:00Z (Manila day
    // 2026-07-25) - a full processing day later. The old (0037) check keyed
    // on manila_day(now()) would have asked about 2026-07-25; the fix must
    // ask about the receipt's OWN visit day, 2026-07-24.
    const call = supabase.rpcCalls.find((c) => c.name === "fixed_per_visit_already_paid");
    expect(call?.args).toEqual({
      p_business_id: BUSINESS_ID,
      p_consumer_id: USER_ID,
      p_visit_day: "2026-07-24",
    });
  });

  it("dedupes correctly when a receipt is approved a processing day (or more) after the visit it duplicates (review lag)", async () => {
    // The exact scenario C1 named: a human-review approval lands a day after
    // the auto-approved original of the SAME visit day. `now` here stands in
    // for "today", well after the visit day RECEIPT itself carries; the
    // precheck must still key on the receipt's visit day and find the prior
    // paid earn regardless of how much later "now" is.
    const supabase = createFakeSupabase({
      pointsRules: [FIXED_VISIT_RULE],
      fixedPerVisitAlreadyPaid: true,
    });

    const laterNow = new Date("2026-07-28T04:00:00.000Z"); // three processing days later
    const result = await priceReceipt({
      deps: { supabase: supabase.client, now: () => laterNow },
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    const call = supabase.rpcCalls.find((c) => c.name === "fixed_per_visit_already_paid");
    expect(call?.args).toMatchObject({ p_visit_day: "2026-07-24" });
    expect(result.points).toBe(0);
  });

  it("prices as NOT deduped (fails open to the RPC-side check) when the precheck read errors", async () => {
    const supabase = createFakeSupabase({
      pointsRules: [FIXED_VISIT_RULE],
      fixedPerVisitCheckError: { message: "boom" },
    });

    const result = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });

    expect(result.points).toBe(10);
    expect(result.verifyNoPriorFixedPerVisitEarn).toBe(true);
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
// awardPoints: fixed_per_visit same-day dedupe race guard (0037, task 1.1)
// ===========================================================================

describe("awardPoints: fixed_per_visit dedupe verify flag", () => {
  it("sends p_verify_no_prior_fixed_visit_earn: true when the plan says so", async () => {
    const supabase = createFakeSupabase({});

    await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({ points: 10, verifyNoPriorFixedPerVisitEarn: true }),
    });

    expect(supabase.rpcCalls[0]?.args).toMatchObject({
      p_verify_no_prior_fixed_visit_earn: true,
    });
  });

  it("omits the verify argument entirely when the plan does not ask for it (0018 argument list stays verbatim)", async () => {
    const supabase = createFakeSupabase({});

    await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({ verifyNoPriorFixedPerVisitEarn: false }),
    });

    expect(supabase.rpcCalls[0]?.args).not.toHaveProperty("p_verify_no_prior_fixed_visit_earn");
  });
});

// ===========================================================================
// awardPoints: FIXED_PER_VISIT_RACE recovery (C2 fix)
//
// The reviewer's finding: the losing receipt used to end status='approved',
// processed_at null, no ledger row, no visit - stranded, with the consumer
// notified "points on their way" (false). None of these tests should ever see
// `kind: "refused"` for FIXED_PER_VISIT_RACE; the race is recovered from
// entirely in TypeScript, replaying `plan.dedupedFallback` (never a second
// implementation of the rule math).
// ===========================================================================

describe("awardPoints: FIXED_PER_VISIT_RACE recovery (C2 fix)", () => {
  it("falls back to the zero-point path when the fallback total is 0 (no bonus)", async () => {
    // awardRpcQueue targets ONLY award_receipt_points calls, so the
    // subsequent record_receipt_visit call still succeeds on its default.
    const supabase = createFakeSupabase({
      awardRpcQueue: [{ data: null, error: { message: "FIXED_PER_VISIT_RACE" } }],
    });

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({
        points: 10,
        verifyNoPriorFixedPerVisitEarn: true,
        dedupedFallback: {
          points: 0,
          ruleSnapshot: { engine: "points/v1", base: { fixed_per_visit_deduped: true, points: 0 } },
        },
      }),
    });

    expect(supabase.rpcCalls.map((call) => call.name)).toEqual([
      "award_receipt_points",
      "record_receipt_visit",
    ]);
    expect(result).toEqual({ kind: "skipped_zero_points" });
    // NEVER the stranded state: no reject_note, receipt not left refused.
    expect(supabase.opsFor("receipts", "update")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ reject_note: expect.anything() }) })]),
    );
  });

  it("retries award_receipt_points once with the fallback total when it is positive (independent bonus)", async () => {
    const fallbackSnapshot = {
      engine: "points/v1",
      base: { fixed_per_visit_deduped: true, points: 0 },
      total_points: 5,
    };
    const supabase = createFakeSupabase({
      awardRpcQueue: [
        { data: null, error: { message: "FIXED_PER_VISIT_RACE" } },
        { data: LEDGER_ROW_ID, error: null },
      ],
    });

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({
        points: 15,
        verifyNoPriorFixedPerVisitEarn: true,
        dedupedFallback: { points: 5, ruleSnapshot: fallbackSnapshot },
      }),
    });

    expect(supabase.rpcCalls).toHaveLength(2);
    expect(supabase.rpcCalls[0]?.name).toBe("award_receipt_points");
    expect(supabase.rpcCalls[0]?.args).toMatchObject({ p_points: 15 });
    // The retry must NOT set p_verify_no_prior_fixed_visit_earn: the prior
    // earn that caused this race IS the fact the fallback already accounts
    // for, so re-verifying would find that same earn and refuse in a loop.
    expect(supabase.rpcCalls[1]?.name).toBe("award_receipt_points");
    expect(supabase.rpcCalls[1]?.args).toMatchObject({
      p_receipt_id: RECEIPT_ID,
      p_points: 5,
      p_rule_snapshot: fallbackSnapshot,
    });
    expect(supabase.rpcCalls[1]?.args).not.toHaveProperty("p_verify_no_prior_fixed_visit_earn");
    expect(result).toEqual({ kind: "awarded", points: 5, transactionId: LEDGER_ROW_ID });
  });

  it("never re-strands the receipt: a failed retry falls all the way to the zero-point path (terminal fallback)", async () => {
    const supabase = createFakeSupabase({
      awardRpcQueue: [
        { data: null, error: { message: "FIXED_PER_VISIT_RACE" } },
        { data: null, error: { message: "CUSTOMER_BLACKLISTED" } },
      ],
    });

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({
        points: 15,
        verifyNoPriorFixedPerVisitEarn: true,
        dedupedFallback: {
          points: 5,
          ruleSnapshot: { engine: "points/v1", base: { fixed_per_visit_deduped: true, points: 0 } },
        },
      }),
    });

    // Two award_receipt_points attempts, then the terminal zero-point path -
    // never a "refused" result for this receipt.
    expect(supabase.rpcCalls.map((call) => call.name)).toEqual([
      "award_receipt_points",
      "award_receipt_points",
      "record_receipt_visit",
    ]);
    expect(result).toEqual({ kind: "skipped_zero_points" });

    // M-b (review): a breadcrumb is left before the terminal fallback
    // swallows the specific failure into a generic skipped_zero_points, so
    // support can find WHY the retry did not land.
    const update = supabase
      .opsFor("receipts", "update")
      .find(
        (op) =>
          typeof op.payload === "object" && op.payload !== null && "reject_note" in op.payload,
      );
    expect(update?.payload).toEqual({ reject_note: "award_retry_failed:CUSTOMER_BLACKLISTED" });
  });

  it("warns (not just info) when a genuine race is recovered via the zero-point fallback (M-c)", async () => {
    const supabase = createFakeSupabase({
      awardRpcQueue: [{ data: null, error: { message: "FIXED_PER_VISIT_RACE" } }],
    });

    await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({
        points: 10,
        verifyNoPriorFixedPerVisitEarn: true,
        dedupedFallback: {
          points: 0,
          ruleSnapshot: { engine: "points/v1", base: { fixed_per_visit_deduped: true, points: 0 } },
        },
      }),
    });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(`fixed_per_visit race recovered for receipt ${RECEIPT_ID}`),
    );
  });

  it("falls back to the zero-point path when dedupedFallback is null (defensive: should not happen if verify was true)", async () => {
    const supabase = createFakeSupabase({
      awardRpcQueue: [{ data: null, error: { message: "FIXED_PER_VISIT_RACE" } }],
    });

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({ points: 10, verifyNoPriorFixedPerVisitEarn: true, dedupedFallback: null }),
    });

    expect(supabase.rpcCalls.map((call) => call.name)).toEqual([
      "award_receipt_points",
      "record_receipt_visit",
    ]);
    expect(result).toEqual({ kind: "skipped_zero_points" });
  });
});

// ===========================================================================
// awardPoints: fixed_per_visit dedupe persisted on the zero-point path (C3 fix)
// ===========================================================================

describe("awardPoints: fixed_per_visit dedupe persisted to parse_meta (C3 fix)", () => {
  const dedupedSnapshot = {
    engine: "points/v1",
    base: { rule_type: "fixed_per_visit", fixed_per_visit_deduped: true, points: 0 },
    total_points: 0,
  };

  it("merges an award block into parse_meta when the zero-point path was a fixed_per_visit dedupe", async () => {
    const supabase = createFakeSupabase({ receiptParseMeta: { existing: "field" } });

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({ points: 0, ruleSnapshot: dedupedSnapshot }),
    });

    const read = supabase.opsFor("receipts", "select")[0];
    expect(read?.filters).toEqual([
      { method: "eq", args: ["id", RECEIPT_ID] },
      { method: "single", args: [] },
    ]);

    const update = supabase.opsFor("receipts", "update")[0];
    expect(update?.payload).toEqual({
      parse_meta: { existing: "field", award: { total: 0, fixed_per_visit_deduped: true } },
    });
    expect(result).toEqual({ kind: "skipped_zero_points" });
  });

  it("does NOT write a parse_meta marker for an ordinary zero-price receipt (no active base rule, floor unmet)", async () => {
    const supabase = createFakeSupabase({});

    await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({ points: 0, ruleSnapshot: { engine: "points/v1", total_points: 0, base: null } }),
    });

    expect(supabase.opsFor("receipts", "select")).toHaveLength(0);
    expect(supabase.opsFor("receipts", "update")).toHaveLength(0);
  });

  it("logs and does not throw when the parse_meta read fails", async () => {
    const supabase = createFakeSupabase({ receiptReadError: { message: "boom" } });

    await expect(
      awardPoints({
        deps: createDeps(supabase),
        receiptId: RECEIPT_ID,
        plan: plan({ points: 0, ruleSnapshot: dedupedSnapshot }),
      }),
    ).resolves.toEqual({ kind: "skipped_zero_points" });
    expect(console.error).toHaveBeenCalled();
  });

  it("persists the marker on the C2 recovery zero-point path too", async () => {
    const supabase = createFakeSupabase({
      awardRpcQueue: [{ data: null, error: { message: "FIXED_PER_VISIT_RACE" } }],
      receiptParseMeta: null,
    });

    await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: plan({
        points: 10,
        verifyNoPriorFixedPerVisitEarn: true,
        dedupedFallback: { points: 0, ruleSnapshot: dedupedSnapshot },
      }),
    });

    const update = supabase.opsFor("receipts", "update")[0];
    expect(update?.payload).toEqual({
      parse_meta: { award: { total: 0, fixed_per_visit_deduped: true } },
    });
  });
});

// ===========================================================================
// M4: end-to-end lifecycle - a deduped-to-zero receipt reaches
// record_receipt_visit and completes its normal lifecycle (brief
// requirement 3's happy path), pricing and awarding in one pass.
// ===========================================================================

describe("fixed_per_visit dedupe: end-to-end zero-point lifecycle (M4)", () => {
  it("prices to 0, records the visit, and persists the dedupe marker - never a refusal", async () => {
    const supabase = createFakeSupabase({
      pointsRules: [FIXED_VISIT_RULE],
      fixedPerVisitAlreadyPaid: true,
      receiptParseMeta: {},
    });

    const priced = await priceReceipt({
      deps: createDeps(supabase),
      businessId: BUSINESS_ID,
      receipt: RECEIPT,
      isFirstVisit: false,
    });
    expect(priced.points).toBe(0);

    const result = await awardPoints({
      deps: createDeps(supabase),
      receiptId: RECEIPT_ID,
      plan: priced,
    });

    expect(supabase.rpcCalls.map((call) => call.name)).toEqual([
      "fixed_per_visit_already_paid",
      "record_receipt_visit",
    ]);
    const update = supabase.opsFor("receipts", "update")[0];
    expect(update?.payload).toEqual({
      parse_meta: { award: { total: 0, fixed_per_visit_deduped: true } },
    });
    expect(result).toEqual({ kind: "skipped_zero_points" });
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
  // reuses three of these so both RPCs share one taxonomy. 0037 adds exactly
  // one new message of its own, FIXED_PER_VISIT_RACE (raised only when the
  // caller sets p_verify_no_prior_fixed_visit_earn and the check finds a
  // same-day earn under the lock that the TypeScript pre-check missed).
  const MIGRATION_ERRORS = [
    "AWARD_RECEIPT_ID_REQUIRED",
    "AWARD_POINTS_INVALID",
    "RECEIPT_NOT_AWARDABLE",
    "RECEIPT_ALREADY_AWARDED",
    "CUSTOMER_RECORD_MISSING",
    "CUSTOMER_BLACKLISTED",
    "FIXED_PER_VISIT_RACE",
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

  // FIXED_PER_VISIT_RACE is deliberately excluded from this generic loop: it
  // is the one code that is NOT a simple terminal refusal (see the dedicated
  // "FIXED_PER_VISIT_RACE recovery (C2 fix)" describe block above), so a
  // `plan()` with default flags does not exercise its real path here.
  for (const message of MIGRATION_ERRORS.filter(
    (code) => code !== "RECEIPT_ALREADY_AWARDED" && code !== "FIXED_PER_VISIT_RACE",
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
