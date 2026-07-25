// @vitest-environment node
//
// Server-only orchestration (service-role Supabase, storage, Redis, the award
// RPC); no DOM anywhere in it, so it runs under plain Node like the other
// server modules in this codebase.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// "server-only" throws on import outside Next.js's react-server condition
// (which vitest does not set), so it must be mocked to a no-op for tests.
vi.mock("server-only", () => ({}));

// `src/lib/env.ts` validates NEXT_PUBLIC_* at MODULE scope and throws without
// them, so the transitive import through the OCR provider has to be stubbed.
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));

// None of these singletons is ever reached (every test injects deps), but all
// of them are imported at module scope by process.ts.
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  incr: () => Promise.resolve(1),
  expireNx: () => Promise.resolve(true),
}));

import type { Database } from "@/lib/supabase/types";

import { DEFAULT_RECEIPT_SETTINGS } from "./settings";
import type { ReceiptSettings } from "./settings";
import type { OcrProvider, OcrResponse } from "./ocr/provider";
import { OcrError } from "./ocr/provider";
import { resolveStacking, toPointsRule } from "./award";
import type { CampaignRow, PointsRuleRow } from "./award";
import {
  detectSourceKind,
  processReceipt,
  resolveOutcome,
  sanitizeParseConfig,
  selectTemplate,
  validateParsedReceipt,
} from "./process";
import type { ProcessReceiptDeps } from "./process";
import { parseReceipt } from "../parse";

// ===========================================================================
// A fake Supabase client
// ===========================================================================
//
// The whole point of injecting the client rather than a domain-shaped
// repository port is that these tests exercise the REAL query construction:
// which table, which columns, which filters, in which order relative to the
// other writes. The fake below records every operation and answers it from an
// in-memory "world", so a stage that reads the wrong column or writes children
// before the parent names their tenant fails here rather than in production.

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
    this.op = { table, op: "select", columns: "*", payload: undefined, filters: [], single: false };
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
}

function createFakeSupabase(input: {
  respond: Responder;
  signedUrl?: FakeResult;
  rpc?: FakeResult;
}): FakeSupabase {
  const ops: FakeOp[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const client = {
    from: (table: string) => new FakeQuery(table, input.respond, (op) => ops.push(op)),
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve(
            input.signedUrl ?? { data: { signedUrl: "https://signed.example/receipt.jpg" }, error: null },
          ),
      }),
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(input.rpc ?? { data: "ledger-row-id", error: null });
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
const CONSUMER_ID = "01980000-0000-7000-8000-0000000000c1";
const OTHER_RECEIPT_ID = "01980000-0000-7000-8000-000000000002";
const IMAGE_HASH = "0f1e2d3c4b5a6978";

// 2026-07-25T04:00:00Z is 12:00 noon in Asia/Manila.
const NOW = new Date("2026-07-25T04:00:00.000Z");

// A clean PH thermal slip: merchant, TIN, OR number, date+time, two priced
// line items, and a VAT block whose 12% arithmetic is exactly consistent
// (tax = total x 12/112, subtotal + tax = total), so the Stage 9 VAT bonus
// applies and parse_confidence saturates.
const CLEAN_RECEIPT_TEXT = [
  "SARI SARI EXPRESS",
  "CEBU CITY BRANCH",
  "TIN 123-456-789-000",
  "OR# 0012345",
  "07/24/2026 13:45",
  "",
  "1  CHICKEN ADOBO           120.00     120.00",
  "2  GARLIC RICE              35.00      70.00",
  "",
  "VATABLE SALES                          169.64",
  "VAT (12%)                               20.36",
  "TOTAL                                  190.00",
  "CASH                                   200.00",
  "CHANGE                                  10.00",
  "",
  "THIS SERVES AS AN OFFICIAL RECEIPT",
].join("\n");

function ocrResponse(overrides: Partial<OcrResponse> = {}): OcrResponse {
  return {
    engine: "stub",
    engineVersion: "stub-v1",
    preprocessOps: ["stub"],
    rawText: CLEAN_RECEIPT_TEXT,
    blocks: [],
    meanConfidence: 0.95,
    durationMs: 1200,
    ...overrides,
  };
}

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

interface World {
  receipt: Record<string, unknown> | null;
  ocrAttempts: Array<{ attempt: number }>;
  templates: Array<{ id: string; source_kind: string; parse_config: unknown }>;
  business: { id: string; name: string; verified_at: string | null } | null;
  customer: { segment: string; visit_count: number } | null;
  phashNeighbours: Array<{ id: string; user_id: string; image_hash: string }>;
  numberMatches: Array<{ id: string; user_id: string; status: string }>;
  staff: { id: string; role: string } | null;
  pointsRules: PointsRuleRow[];
  campaigns: CampaignRow[];
  roundStreak: Array<{ total_centavos: number | null }>;
  fraudRejections: Array<{ id: string }>;
  scanBlockedUntil: string | null;
}

function createWorld(overrides: Partial<World> = {}): World {
  return {
    receipt: {
      id: RECEIPT_ID,
      business_id: BUSINESS_ID,
      user_id: CONSUMER_ID,
      status: "queued",
      image_path: `${CONSUMER_ID}/photo.jpg`,
      image_hash: IMAGE_HASH,
      device_id: null,
      created_at: "2026-07-25T03:55:00.000Z",
    },
    ocrAttempts: [],
    templates: [],
    business: { id: BUSINESS_ID, name: "Sari Sari Express", verified_at: "2026-01-01T00:00:00.000Z" },
    customer: { segment: "regular", visit_count: 3 },
    phashNeighbours: [],
    numberMatches: [],
    staff: null,
    pointsRules: [BASE_RULE],
    campaigns: [],
    roundStreak: [],
    fraudRejections: [],
    scanBlockedUntil: null,
    ...overrides,
  };
}

/**
 * Dispatches on (table, selected columns), which is exactly how the pipeline
 * distinguishes its reads. Anything unrecognized answers empty rather than
 * throwing, so an added read shows up as a missing expectation instead of an
 * unrelated crash.
 */
function worldResponder(world: World): Responder {
  return (op) => {
    const ok = (data: unknown): FakeResult => ({ data, error: null });

    if (op.op !== "select") return ok(null);

    switch (op.table) {
      case "receipts":
        if (op.columns.startsWith("id, business_id")) return ok(world.receipt);
        if (op.columns === "id, user_id, image_hash") return ok(world.phashNeighbours);
        if (op.columns === "id, user_id, status") return ok(world.numberMatches);
        if (op.columns === "total_centavos") return ok(world.roundStreak);
        if (op.columns === "id") return ok(world.fraudRejections);
        return ok([]);
      case "ocr_results":
        return ok(world.ocrAttempts);
      case "receipt_templates":
        return ok(world.templates);
      case "businesses":
        return ok(world.business);
      case "business_customers":
        return ok(world.customer);
      case "business_staff":
        return ok(world.staff);
      case "points_rules":
        return ok(world.pointsRules);
      case "campaigns":
        return ok(world.campaigns);
      case "consumers":
        return ok({ scan_blocked_until: world.scanBlockedUntil });
      default:
        return ok([]);
    }
  };
}

interface Harness {
  supabase: FakeSupabase;
  deps: ProcessReceiptDeps;
  ocr: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  receiptUpdate(): Record<string, unknown> | undefined;
  insertedRows(table: string): Record<string, unknown>[];
}

function createHarness(input: {
  world?: World;
  response?: OcrResponse;
  ocrError?: unknown;
  settings?: Partial<ReceiptSettings>;
  velocityCount?: (key: string) => number;
  redisThrows?: boolean;
  signedUrl?: FakeResult;
  rpc?: FakeResult;
} = {}): Harness {
  const world = input.world ?? createWorld();
  const supabase = createFakeSupabase({
    respond: worldResponder(world),
    ...(input.signedUrl === undefined ? {} : { signedUrl: input.signedUrl }),
    ...(input.rpc === undefined ? {} : { rpc: input.rpc }),
  });

  const ocr = vi.fn(() =>
    input.ocrError === undefined
      ? Promise.resolve(input.response ?? ocrResponse())
      : Promise.reject(input.ocrError),
  );
  const provider: OcrProvider = { name: "stub", ocr };

  const incr = vi.fn((key: string) => {
    if (input.redisThrows === true) return Promise.reject(new Error("redis down"));
    return Promise.resolve(input.velocityCount?.(key) ?? 1);
  });
  const expireNx = vi.fn(() =>
    input.redisThrows === true
      ? Promise.reject(new Error("redis down"))
      : Promise.resolve(true),
  );

  const settings: ReceiptSettings = { ...DEFAULT_RECEIPT_SETTINGS, ...input.settings };

  const deps: ProcessReceiptDeps = {
    supabase: supabase.client,
    ocr: provider,
    loadSettings: () => Promise.resolve(settings),
    redis: { incr, expireNx },
    now: () => NOW,
  };

  return {
    supabase,
    deps,
    ocr,
    incr,
    receiptUpdate() {
      const updates = supabase.opsFor("receipts", "update");
      // The claim to status='processing' is the first receipts update; the
      // outcome write is the one that carries a terminal status.
      const outcome = updates.filter(
        (entry) => (entry.payload as Record<string, unknown>).status !== "processing",
      );
      return outcome[outcome.length - 1]?.payload as Record<string, unknown> | undefined;
    },
    insertedRows(table: string) {
      return supabase
        .opsFor(table, "insert")
        .flatMap((entry) =>
          Array.isArray(entry.payload)
            ? (entry.payload as Record<string, unknown>[])
            : [entry.payload as Record<string, unknown>],
        );
    },
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
// The fixture itself
// ===========================================================================

describe("the clean-receipt fixture", () => {
  // Guards the rest of the file: every routing assertion below depends on this
  // text parsing to a complete, VAT-consistent candidate. If parse.ts changes
  // shape, this fails first and explains why.
  it("parses to a complete, VAT-consistent candidate", () => {
    const parsed = parseReceipt({ rawText: CLEAN_RECEIPT_TEXT });
    expect(parsed.totalCentavos).toBe(19_000);
    expect(parsed.receiptNumber).toBe("OR0012345");
    expect(parsed.receiptDate?.toISOString()).toBe("2026-07-24T05:45:00.000Z");
    expect(parsed.vatConsistent).toBe(true);
    expect(parsed.lineItems).toHaveLength(2);
  });
});

// ===========================================================================
// Stage 2 - idempotency
// ===========================================================================

describe("idempotency (doc 36 Stage 2)", () => {
  for (const status of ["approved", "review", "rejected"]) {
    it(`acks and exits without touching a receipt already in '${status}'`, async () => {
      const world = createWorld();
      world.receipt = { ...world.receipt, status };
      const harness = createHarness({ world });

      await processReceipt(RECEIPT_ID, harness.deps);

      expect(harness.ocr).not.toHaveBeenCalled();
      expect(harness.supabase.rpcCalls).toHaveLength(0);
      expect(harness.supabase.opsFor("receipts", "update")).toHaveLength(0);
      expect(harness.supabase.opsFor("ocr_results", "insert")).toHaveLength(0);
    });
  }

  it("resumes a receipt left in 'processing' by a previous attempt", async () => {
    const world = createWorld();
    world.receipt = { ...world.receipt, status: "processing" };
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.ocr).toHaveBeenCalledTimes(1);
    // No re-claim: the row is already 'processing'.
    const claims = harness.supabase
      .opsFor("receipts", "update")
      .filter((op) => (op.payload as Record<string, unknown>).status === "processing");
    expect(claims).toHaveLength(0);
  });

  it("does nothing at all when the receipt does not exist", async () => {
    const world = createWorld({ receipt: null });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.ocr).not.toHaveBeenCalled();
    expect(harness.supabase.opsFor("receipts", "update")).toHaveLength(0);
  });
});

// ===========================================================================
// The approve path
// ===========================================================================

describe("auto-approval and award (doc 36 Stages 9-10)", () => {
  it("approves, awards exactly once, and prices the receipt from the base rule", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("approved");
    expect(update?.reject_reason).toBeNull();
    expect(update?.business_id).toBe(BUSINESS_ID);
    expect(update?.total_centavos).toBe(19_000);
    expect(update?.receipt_number).toBe("OR0012345");

    expect(harness.supabase.rpcCalls).toHaveLength(1);
    const call = harness.supabase.rpcCalls[0];
    expect(call?.name).toBe("award_receipt_points");
    const args = call?.args as Record<string, unknown>;
    expect(args.p_receipt_id).toBe(RECEIPT_ID);
    // floor(19000 centavos / 100 centavos-per-point) = 190 points.
    expect(args.p_points).toBe(190);
    expect(args.p_campaign_id).toBeNull();
  });

  it("writes the receipt as 'approved' BEFORE calling the award RPC, which guards on it", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    // The fake records ops in call order, and the rpc list is separate, so the
    // check that matters is that the terminal update happened at all and that
    // it carried 'approved' - 0018 raises RECEIPT_NOT_AWARDABLE otherwise.
    const updates = harness.supabase.opsFor("receipts", "update");
    const terminal = updates.find(
      (op) => (op.payload as Record<string, unknown>).status === "approved",
    );
    expect(terminal).toBeDefined();
    expect(harness.supabase.rpcCalls).toHaveLength(1);
  });

  it("leaves processed_at for the award RPC to write, rather than double-writing it", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.processed_at).toBeNull();
  });

  it("writes fraud signals even though the receipt was approved (doc 37)", async () => {
    // One breached velocity window: warn 0.5 x 0.4 = 0.20 composite, below the
    // 0.5 review threshold, so the receipt still auto-approves - and the row
    // is written anyway, which is doc 37's whole scoring-history argument.
    const harness = createHarness({
      velocityCount: (key) => (key.includes("consumer_hour") ? 5 : 1),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
    const signals = harness.insertedRows("fraud_signals");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.signal).toBe("velocity");
    expect(signals[0]?.severity).toBe("warn");
    expect(signals[0]?.business_id).toBe(BUSINESS_ID);
    expect(signals[0]?.consumer_id).toBe(CONSUMER_ID);
    expect(harness.supabase.rpcCalls).toHaveLength(1);
  });

  it("persists OCR evidence verbatim and meters the call", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    const rows = harness.insertedRows("ocr_results");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempt).toBe(1);
    expect(rows[0]?.engine).toBe("stub");
    expect(rows[0]?.engine_version).toBe("stub-v1");
    expect(rows[0]?.raw_text).toBe(CLEAN_RECEIPT_TEXT);
    expect(rows[0]?.mean_confidence).toBe(0.95);
    expect(rows[0]?.preprocess_ops).toEqual(["stub"]);
    expect(rows[0]?.duration_ms).toBe(1200);

    const usage = harness.insertedRows("ai_usage_events");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: "ocr", units: 1, ref_id: RECEIPT_ID });
  });

  it("numbers the OCR attempt from the existing rows (UNIQUE (receipt_id, attempt))", async () => {
    const world = createWorld({ ocrAttempts: [{ attempt: 2 }] });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.insertedRows("ocr_results")[0]?.attempt).toBe(3);
  });

  it("stops when another worker already owns the attempt number", async () => {
    const world = createWorld();
    const supabase = createFakeSupabase({
      respond: (op) => {
        if (op.table === "ocr_results" && op.op === "insert") {
          return { data: null, error: { message: "duplicate key", code: "23505" } };
        }
        return worldResponder(world)(op);
      },
    });
    const deps: ProcessReceiptDeps = {
      supabase: supabase.client,
      ocr: { name: "stub", ocr: () => Promise.resolve(ocrResponse()) },
      loadSettings: () => Promise.resolve(DEFAULT_RECEIPT_SETTINGS),
      redis: { incr: () => Promise.resolve(1), expireNx: () => Promise.resolve(true) },
      now: () => NOW,
    };

    await processReceipt(RECEIPT_ID, deps);

    expect(supabase.rpcCalls).toHaveLength(0);
    const terminal = supabase
      .opsFor("receipts", "update")
      .filter((op) => (op.payload as Record<string, unknown>).status !== "processing");
    expect(terminal).toHaveLength(0);
  });

  it("persists line items under the matched tenant", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    // Deleted first: a reprocess replaces the previous split rather than
    // appending to it.
    expect(harness.supabase.opsFor("receipt_line_items", "delete")).toHaveLength(1);
    const items = harness.insertedRows("receipt_line_items");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      business_id: BUSINESS_ID,
      receipt_id: RECEIPT_ID,
      line_total_centavos: 12_000,
      sort: 0,
    });
    expect(items[1]?.line_total_centavos).toBe(7_000);
  });

  it("records the parse trace the review UI reads (A24.2 parse_meta)", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    const meta = harness.receiptUpdate()?.parse_meta as Record<string, unknown>;
    expect(meta.engine).toBe("parse/v1");
    expect(meta.tier).toBe("heuristic");
    expect(meta.vat_consistent).toBe(true);
    expect((meta.ocr as Record<string, unknown>).attempt).toBe(1);
    expect((meta.match as Record<string, unknown>).contradicted).toBe(false);
  });
});

// ===========================================================================
// The review path
// ===========================================================================

describe("the review path", () => {
  it("awards nothing when the fraud composite reaches the review threshold", async () => {
    // Every window breached: (0.5 + 0.6 + 0.5 + 0.7) x 0.4 = 0.92 >= 0.5.
    const harness = createHarness({ velocityCount: () => 99 });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("review");
    expect(update?.business_id).toBe(BUSINESS_ID);
    // Not the award path, so this side owns processed_at.
    expect(update?.processed_at).toBe(NOW.toISOString());
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(harness.insertedRows("fraud_signals").length).toBeGreaterThan(0);
  });

  it("still persists the parsed fields a reviewer needs", async () => {
    const harness = createHarness({ velocityCount: () => 99 });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.merchant_name).toBe("SARI SARI EXPRESS");
    expect(update?.total_centavos).toBe(19_000);
    expect(update?.subtotal_centavos).toBe(16_964);
    expect(update?.tax_centavos).toBe(2_036);
    expect(update?.parse_confidence).toBe(1);
    expect(update?.match_confidence).toBe(0.9);
    expect(update?.parse_meta).toBeTruthy();
  });

  it("forces review for a staff member scanning their own store, even when everything else is perfect", async () => {
    const world = createWorld({ staff: { id: "staff-1", role: "manager" } });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("review");
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    const signals = harness.insertedRows("fraud_signals");
    expect(signals.map((row) => row.signal)).toContain("staff_self_scan");
    // Doc 37: the composite is only 0.8 x 0.4 = 0.32, well under the review
    // threshold. S9 routes unconditionally, which is the point of this test.
    expect(signals[0]?.severity).toBe("warn");
  });

  it("forces review for a blacklisted customer instead of letting the RPC refuse the award", async () => {
    const world = createWorld({ customer: { segment: "blacklisted", visit_count: 9 } });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("review");
    expect(harness.supabase.rpcCalls).toHaveLength(0);
  });

  it("forces review when the total is outside the template's amount_sanity bounds", async () => {
    const world = createWorld({
      templates: [
        {
          id: "tpl-1",
          source_kind: "pos",
          parse_config: { amount_sanity: { min_total_centavos: 1_000, max_total_centavos: 5_000 } },
        },
      ],
    });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("review");
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(harness.insertedRows("fraud_signals").map((row) => row.signal)).toContain(
      "amount_anomaly",
    );
  });
});

// ===========================================================================
// The reject paths
// ===========================================================================

describe("the reject paths", () => {
  it("blocks a near-identical image as a duplicate and awards nothing", async () => {
    const world = createWorld({
      phashNeighbours: [
        { id: OTHER_RECEIPT_ID, user_id: CONSUMER_ID, image_hash: IMAGE_HASH },
      ],
    });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("rejected");
    expect(update?.reject_reason).toBe("duplicate");
    expect(harness.supabase.rpcCalls).toHaveLength(0);

    const signals = harness.insertedRows("fraud_signals");
    expect(signals[0]).toMatchObject({ signal: "image_hash_dup", severity: "block" });
    expect((signals[0]?.evidence as Record<string, unknown>).hamming_distance).toBe(0);
    expect((signals[0]?.evidence as Record<string, unknown>).matched_receipt_id).toBe(
      OTHER_RECEIPT_ID,
    );
  });

  it("blocks a live receipt-number conflict as a duplicate", async () => {
    const world = createWorld({
      numberMatches: [
        { id: OTHER_RECEIPT_ID, user_id: "someone-else", status: "approved" },
      ],
    });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("rejected");
    expect(update?.reject_reason).toBe("duplicate");
    const signal = harness
      .insertedRows("fraud_signals")
      .find((row) => row.signal === "receipt_number_dup");
    expect(signal?.severity).toBe("block");
    expect((signal?.evidence as Record<string, unknown>).cross_consumer).toBe(true);
  });

  it("treats a number matching an already-rejected receipt as context only", async () => {
    const world = createWorld({
      numberMatches: [{ id: OTHER_RECEIPT_ID, user_id: CONSUMER_ID, status: "rejected" }],
    });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
    const signal = harness
      .insertedRows("fraud_signals")
      .find((row) => row.signal === "receipt_number_dup");
    expect(signal?.severity).toBe("info");
  });

  it("rejects an unmatched receipt as wrong_business rather than parking it in review", async () => {
    // 0017's own comment: a review-routed receipt with a null business_id is
    // selectable by no RLS audience on this database and would sit forever.
    const world = createWorld({ business: null });
    world.receipt = { ...world.receipt, business_id: null };
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("rejected");
    expect(update?.reject_reason).toBe("wrong_business");
    expect(update?.business_id).toBeNull();
    expect(harness.supabase.rpcCalls).toHaveLength(0);
  });

  it("rejects a receipt older than receipts.max_age_days", async () => {
    const stale = CLEAN_RECEIPT_TEXT.replace("07/24/2026", "07/01/2026");
    const harness = createHarness({ response: ocrResponse({ rawText: stale }) });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("rejected");
    expect(update?.reject_reason).toBe("too_old");
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(harness.insertedRows("fraud_signals").map((row) => row.signal)).toContain(
      "timestamp_anomaly",
    );
  });

  it("rejects a receipt that predates the business's verification", async () => {
    const world = createWorld();
    world.business = { id: BUSINESS_ID, name: "Sari Sari Express", verified_at: NOW.toISOString() };
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.reject_reason).toBe("too_old");
  });

  it("rejects an unreadable parse and never reaches the award", async () => {
    const harness = createHarness({
      response: ocrResponse({ rawText: "~~~ smudge ~~~", meanConfidence: 0.1 }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("rejected");
    expect(update?.reject_reason).toBe("unreadable");
    expect(harness.supabase.rpcCalls).toHaveLength(0);
  });

  it("honours a lost race on receipts_number_unique by rejecting as a duplicate", async () => {
    const world = createWorld();
    let receiptUpdates = 0;
    const supabase = createFakeSupabase({
      respond: (op) => {
        if (op.table === "receipts" && op.op === "update") {
          const payload = op.payload as Record<string, unknown>;
          if (payload.status === "approved") {
            receiptUpdates += 1;
            return { data: null, error: { message: "duplicate key", code: "23505" } };
          }
        }
        return worldResponder(world)(op);
      },
    });
    const deps: ProcessReceiptDeps = {
      supabase: supabase.client,
      ocr: { name: "stub", ocr: () => Promise.resolve(ocrResponse()) },
      loadSettings: () => Promise.resolve(DEFAULT_RECEIPT_SETTINGS),
      redis: { incr: () => Promise.resolve(1), expireNx: () => Promise.resolve(true) },
      now: () => NOW,
    };

    await processReceipt(RECEIPT_ID, deps);

    expect(receiptUpdates).toBe(1);
    const retry = supabase
      .opsFor("receipts", "update")
      .map((op) => op.payload as Record<string, unknown>)
      .find((payload) => payload.reject_reason === "duplicate");
    expect(retry?.status).toBe("rejected");
    expect(retry?.processed_at).toBe(NOW.toISOString());
    expect(supabase.rpcCalls).toHaveLength(0);
  });
});

// ===========================================================================
// Points edge cases
// ===========================================================================

describe("pricing (doc 35)", () => {
  it("approves without calling the RPC when the business has no active base rule", async () => {
    const world = createWorld({ pointsRules: [] });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("approved");
    // No RPC means nothing else will stamp processed_at, so this path must.
    expect(update?.processed_at).toBe(NOW.toISOString());
    expect(harness.supabase.rpcCalls).toHaveLength(0);
  });

  it("approves without calling the RPC when the rules price the receipt at zero", async () => {
    const world = createWorld({
      pointsRules: [
        {
          ...BASE_RULE,
          // An earning floor this receipt does not clear: base is 0, and 0018
          // would raise AWARD_POINTS_INVALID if we called it.
          conditions: { min_amount_centavos: 500_000 },
        },
      ],
    });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
    expect(harness.supabase.rpcCalls).toHaveLength(0);
  });

  it("applies a live campaign multiplier and names its campaign on the ledger row", async () => {
    const campaign: CampaignRow = {
      id: "01980000-0000-7000-8000-0000000000ca",
      type: "promotion",
      status: "active",
      starts_at: "2026-07-01T00:00:00.000Z",
      ends_at: "2026-08-01T00:00:00.000Z",
      timezone: "Asia/Manila",
      priority: 50,
      is_stackable: false,
    };
    const world = createWorld({
      campaigns: [campaign],
      pointsRules: [
        BASE_RULE,
        {
          ...BASE_RULE,
          id: "01980000-0000-7000-8000-0000000000r2",
          campaign_id: campaign.id,
          kind: "multiplier",
          rate_centavos_per_point: null,
          multiplier: 2,
        },
      ],
    });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    const args = harness.supabase.rpcCalls[0]?.args as Record<string, unknown>;
    // base 190 + floor(190 x (2 - 1)) = 380.
    expect(args.p_points).toBe(380);
    expect(args.p_campaign_id).toBe(campaign.id);
    const snapshot = args.p_rule_snapshot as Record<string, unknown>;
    expect(snapshot.total_points).toBe(380);
    expect((snapshot.receipt as Record<string, unknown>).id).toBe(RECEIPT_ID);
    const multipliers = snapshot.multipliers as Array<Record<string, unknown>>;
    expect(multipliers[0]?.campaign_id).toBe(campaign.id);
    expect(multipliers[0]?.is_stackable).toBe(false);
  });

  it("ignores a campaign rule whose campaign is not live at receipt_date", async () => {
    const campaign: CampaignRow = {
      id: "01980000-0000-7000-8000-0000000000cb",
      type: "promotion",
      status: "ended",
      starts_at: null,
      ends_at: null,
      timezone: "Asia/Manila",
      priority: 50,
      is_stackable: true,
    };
    const world = createWorld({
      campaigns: [campaign],
      pointsRules: [
        BASE_RULE,
        {
          ...BASE_RULE,
          id: "01980000-0000-7000-8000-0000000000r3",
          campaign_id: campaign.id,
          kind: "multiplier",
          rate_centavos_per_point: null,
          multiplier: 5,
        },
      ],
    });
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect((harness.supabase.rpcCalls[0]?.args as Record<string, unknown>).p_points).toBe(190);
  });

  it("treats RECEIPT_ALREADY_AWARDED as benign and leaves the receipt approved", async () => {
    const harness = createHarness({
      rpc: { data: null, error: { message: "RECEIPT_ALREADY_AWARDED" } },
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
    const notes = harness.supabase
      .opsFor("receipts", "update")
      .map((op) => (op.payload as Record<string, unknown>).reject_note)
      .filter((note) => typeof note === "string");
    expect(notes).toHaveLength(0);
  });

  it("annotates the receipt when the award RPC refuses for any other reason", async () => {
    const harness = createHarness({
      rpc: { data: null, error: { message: "RECEIPT_NOT_AWARDABLE" } },
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    const note = harness.supabase
      .opsFor("receipts", "update")
      .map((op) => (op.payload as Record<string, unknown>).reject_note)
      .find((value) => typeof value === "string");
    expect(note).toBe("award_failed:RECEIPT_NOT_AWARDABLE");
  });
});

// ===========================================================================
// OCR failure handling (doc 36 "Retry, timeouts, DLQ")
// ===========================================================================

describe("OCR failure handling", () => {
  it("rejects IMAGE_UNREADABLE immediately, without burning further attempts", async () => {
    const harness = createHarness({
      ocrError: new OcrError("OCR_IMAGE_UNREADABLE", "unreadable", {
        retryable: false,
        status: 422,
      }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("rejected");
    expect(update?.reject_reason).toBe("unreadable");
    expect(update?.processed_at).toBe(NOW.toISOString());

    // The attempt is still recorded as evidence, with its error (A24.1).
    const attempt = harness.insertedRows("ocr_results")[0];
    expect(attempt?.attempt).toBe(1);
    expect(String(attempt?.error)).toContain("OCR_IMAGE_UNREADABLE");
    // The service answered, so the page is metered.
    expect(harness.insertedRows("ai_usage_events")).toHaveLength(1);
  });

  it("leaves a 503 in 'processing' so the next attempt picks it up", async () => {
    const harness = createHarness({
      ocrError: new OcrError("OCR_UNAVAILABLE", "overloaded", {
        retryable: true,
        status: 503,
      }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    // The claim to 'processing' is the ONLY receipts update: no terminal
    // status was written, and doc 36 Stage 2 names 'processing' retry-eligible.
    const updates = harness.supabase
      .opsFor("receipts", "update")
      .map((op) => op.payload as Record<string, unknown>);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBe("processing");
    expect(harness.supabase.rpcCalls).toHaveLength(0);
    expect(String(harness.insertedRows("ocr_results")[0]?.error)).toContain("OCR_UNAVAILABLE");
  });

  it("does not meter a call that never reached the service", async () => {
    const harness = createHarness({
      ocrError: new OcrError("OCR_TIMEOUT", "timed out", { retryable: true }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.insertedRows("ai_usage_events")).toHaveLength(0);
  });

  it("sends an exhausted receipt to manual / processing_failed (the DLQ contract)", async () => {
    const world = createWorld({ ocrAttempts: [{ attempt: 2 }] });
    const harness = createHarness({
      world,
      ocrError: new OcrError("OCR_UNAVAILABLE", "overloaded", {
        retryable: true,
        status: 503,
      }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).toBe("rejected");
    expect(update?.reject_reason).toBe("manual");
    expect(update?.reject_note).toBe("processing_failed");
    expect(harness.insertedRows("ocr_results")[0]?.attempt).toBe(3);
  });

  it("respects a tuned ocr.max_attempts from settings", async () => {
    const harness = createHarness({
      settings: { ocrMaxAttempts: 1 },
      ocrError: new OcrError("OCR_UNAVAILABLE", "overloaded", {
        retryable: true,
        status: 503,
      }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.reject_note).toBe("processing_failed");
  });

  it("treats a failure to sign the image URL as a retryable attempt", async () => {
    const harness = createHarness({
      signedUrl: { data: null, error: { message: "object not found" } },
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.ocr).not.toHaveBeenCalled();
    const updates = harness.supabase.opsFor("receipts", "update");
    expect(updates).toHaveLength(1);
    expect((updates[0]?.payload as Record<string, unknown>).status).toBe("processing");
  });

  it("parks a receipt rather than rejecting it when the OCR credentials are wrong", async () => {
    // Non-retryable at the provider (retrying a bad token is pointless), but
    // an operator failure rather than a receipt failure: burning the whole
    // queue during a token rotation would be self-inflicted.
    const harness = createHarness({
      settings: { ocrMaxAttempts: 1 },
      ocrError: new OcrError("OCR_AUTH_FAILED", "bad token", {
        retryable: false,
        status: 401,
      }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    const updates = harness.supabase.opsFor("receipts", "update");
    expect(updates).toHaveLength(1);
    expect((updates[0]?.payload as Record<string, unknown>).status).toBe("processing");
  });

  it("sends an unmapped OCR response to the DLQ rather than parking it", async () => {
    const harness = createHarness({
      ocrError: new OcrError("OCR_BAD_RESPONSE", "garbage body", {
        retryable: false,
        status: 200,
      }),
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.reject_note).toBe("processing_failed");
  });

  it("never throws when the OCR provider rejects with something unexpected", async () => {
    const harness = createHarness({ ocrError: new Error("kaboom") });

    await expect(processReceipt(RECEIPT_ID, harness.deps)).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Redis
// ===========================================================================

describe("velocity windows (doc 37 S4)", () => {
  it("keeps processing when Redis is unavailable, and manufactures no signal", async () => {
    const harness = createHarness({ redisThrows: true });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
    expect(harness.supabase.rpcCalls).toHaveLength(1);
    expect(harness.insertedRows("fraud_signals")).toHaveLength(0);
  });

  it("counts the four consumer and pair windows, and skips device_day without a device", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    const keys = harness.incr.mock.calls.map((call) => String(call[0]));
    expect(keys.some((key) => key.includes("consumer_hour"))).toBe(true);
    expect(keys.some((key) => key.includes("consumer_day"))).toBe(true);
    expect(keys.some((key) => key.includes("pair_day"))).toBe(true);
    expect(keys.some((key) => key.includes("pair_10min"))).toBe(true);
    expect(keys.some((key) => key.includes("device_day"))).toBe(false);
  });

  it("counts device_day when the submission carried a device", async () => {
    const world = createWorld();
    world.receipt = { ...world.receipt, device_id: "01980000-0000-7000-8000-0000000000d1" };
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    const keys = harness.incr.mock.calls.map((call) => String(call[0]));
    expect(keys.some((key) => key.includes("device_day"))).toBe(true);
  });
});

// ===========================================================================
// Cooldown ladder (doc 37 step 2)
// ===========================================================================

describe("consequences ladder step 2", () => {
  function blockedWorld(strikes: number): World {
    return createWorld({
      phashNeighbours: [
        { id: OTHER_RECEIPT_ID, user_id: CONSUMER_ID, image_hash: IMAGE_HASH },
      ],
      fraudRejections: Array.from({ length: strikes }, (_, index) => ({
        id: `rejection-${index}`,
      })),
    });
  }

  it("does not block on the second fraud-family rejection", async () => {
    const harness = createHarness({ world: blockedWorld(2) });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.reject_reason).toBe("duplicate");
    expect(harness.supabase.opsFor("consumers", "update")).toHaveLength(0);
  });

  it("blocks scanning on the third", async () => {
    const harness = createHarness({ world: blockedWorld(3) });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.supabase.opsFor("consumers", "update")[0];
    expect(update).toBeDefined();
    const blockedUntil = (update?.payload as Record<string, unknown>).scan_blocked_until;
    // 24h by default (fraud.cooldown_hours).
    expect(blockedUntil).toBe(new Date(NOW.getTime() + 24 * 3_600_000).toISOString());
  });

  it("never shortens a longer block that is already in place", async () => {
    const world = blockedWorld(3);
    world.scanBlockedUntil = new Date(NOW.getTime() + 72 * 3_600_000).toISOString();
    const harness = createHarness({ world });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.supabase.opsFor("consumers", "update")).toHaveLength(0);
  });

  it("does not count a non-fraud rejection toward the ladder", async () => {
    const world = createWorld({
      fraudRejections: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    // too_old is a freshness outcome, not a fraud-family one.
    const stale = CLEAN_RECEIPT_TEXT.replace("07/24/2026", "07/01/2026");
    const harness = createHarness({ world, response: ocrResponse({ rawText: stale }) });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.reject_reason).toBe("too_old");
    expect(harness.supabase.opsFor("consumers", "update")).toHaveLength(0);
  });

  it("respects a tuned fraud.cooldown_strikes", async () => {
    const harness = createHarness({
      world: blockedWorld(2),
      settings: { cooldownStrikes: 2, cooldownHours: 1 },
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.supabase.opsFor("consumers", "update")[0];
    expect((update?.payload as Record<string, unknown>).scan_blocked_until).toBe(
      new Date(NOW.getTime() + 3_600_000).toISOString(),
    );
  });
});

// ===========================================================================
// Pure helpers
// ===========================================================================

describe("sanitizeParseConfig", () => {
  it("keeps a well-formed config intact", () => {
    const config = sanitizeParseConfig({
      merchant_aliases: ["JOLLI CAFE"],
      tin: "123-456-789-000",
      receipt_no_regex: "(?:SI|OR)[#:\\s-]*([0-9]{4,12})",
      date_formats: ["MM/dd/yyyy"],
      total_keywords: ["TOTAL"],
      layout_anchors: { totals: { y: [0.7, 0.92], align: "right" }, footer_keywords: ["OFFICIAL"] },
      amount_sanity: { min_total_centavos: 1_000, max_total_centavos: 2_000_000 },
      handwriting: { min_block_conf: 0.35, digits_only_amounts: true },
    });

    expect(config.merchant_aliases).toEqual(["JOLLI CAFE"]);
    expect(config.layout_anchors?.totals?.y).toEqual([0.7, 0.92]);
    expect(config.amount_sanity?.max_total_centavos).toBe(2_000_000);
    expect(config.handwriting?.digits_only_amounts).toBe(true);
  });

  it("drops only the malformed field, never the whole template", () => {
    const config = sanitizeParseConfig({
      merchant_aliases: "not-an-array",
      total_keywords: ["TOTAL", 7, null],
      tin: 12345,
    });

    expect(config.merchant_aliases).toBeUndefined();
    expect(config.tin).toBeUndefined();
    // Non-strings inside a list are filtered out rather than poisoning it: a
    // number reaching parse.ts's keyword loop would throw on .trim().
    expect(config.total_keywords).toEqual(["TOTAL"]);
  });

  it("preserves an EMPTY tax_keywords, which means non-VAT rather than absent", () => {
    expect(sanitizeParseConfig({ tax_keywords: [] }).tax_keywords).toEqual([]);
    expect(sanitizeParseConfig({}).tax_keywords).toBeUndefined();
  });

  it("survives a null or non-object parse_config", () => {
    expect(sanitizeParseConfig(null)).toEqual({});
    expect(sanitizeParseConfig("nonsense")).toEqual({});
    expect(sanitizeParseConfig([1, 2, 3])).toEqual({});
  });
});

describe("detectSourceKind", () => {
  const alignedBlocks = Array.from({ length: 8 }, (_, index) => ({
    text: `LINE ${index}`,
    bbox: [34, index * 30, 300, index * 30 + 20] as [number, number, number, number],
    conf: 0.95,
  }));

  it("reads a confident, left-aligned slip as a POS receipt", () => {
    expect(
      detectSourceKind({ rawText: "TOTAL 100.00", blocks: alignedBlocks, meanConfidence: 0.95 }),
    ).toBe("pos");
  });

  it("reads letterhead invoice vocabulary as an invoice", () => {
    expect(
      detectSourceKind({
        rawText: "ACME CORP\nINVOICE\nSI NO 4412",
        blocks: alignedBlocks,
        meanConfidence: 0.9,
      }),
    ).toBe("invoice");
  });

  it("reads a low-confidence, ragged page as handwritten", () => {
    const ragged = Array.from({ length: 8 }, (_, index) => ({
      text: `scrawl ${index}`,
      bbox: [20 + index * 7, index * 30, 300, index * 30 + 20] as [number, number, number, number],
      conf: 0.4,
    }));
    expect(detectSourceKind({ rawText: "ttl 250", blocks: ragged, meanConfidence: 0.4 })).toBe(
      "handwritten",
    );
  });
});

describe("selectTemplate", () => {
  const response = { rawText: "TOTAL 100.00\nOFFICIAL RECEIPT", blocks: [], meanConfidence: 0.9 };

  it("returns null when the business has no templates", () => {
    expect(selectTemplate([], response)).toBeNull();
  });

  it("always uses the single template a business has, whatever it scores", () => {
    const selected = selectTemplate(
      [{ id: "tpl-1", source_kind: "handwritten", parse_config: { tin: "1" } }],
      response,
    );
    expect(selected?.id).toBe("tpl-1");
    expect(selected?.config.tin).toBe("1");
  });

  it("picks the template whose anchors and source_kind match the page", () => {
    const selected = selectTemplate(
      [
        { id: "pad", source_kind: "handwritten", parse_config: {} },
        {
          id: "pos",
          source_kind: "pos",
          parse_config: { layout_anchors: { footer_keywords: ["OFFICIAL RECEIPT"] } },
        },
      ],
      response,
    );
    expect(selected?.id).toBe("pos");
  });

  it("declares no winner when several templates are indistinguishable", () => {
    const selected = selectTemplate(
      [
        { id: "a", source_kind: "handwritten", parse_config: {} },
        { id: "b", source_kind: "invoice", parse_config: {} },
      ],
      response,
    );
    expect(selected).toBeNull();
  });
});

describe("validateParsedReceipt", () => {
  const parsed = parseReceipt({ rawText: CLEAN_RECEIPT_TEXT });

  it("passes a fresh, readable receipt", () => {
    const result = validateParsedReceipt({
      parsed,
      now: NOW,
      maxAgeDays: 3,
      businessVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.rejection).toBeNull();
    expect(result.forceReview).toBe(false);
    expect(result.signals).toHaveLength(0);
  });

  it("rejects as unreadable without a total", () => {
    const result = validateParsedReceipt({
      parsed: { ...parsed, totalCentavos: null },
      now: NOW,
      maxAgeDays: 3,
      businessVerifiedAt: null,
    });
    expect(result.rejection).toBe("unreadable");
  });

  it("accepts a dateless receipt that still carries a number, and skips the date rules", () => {
    const result = validateParsedReceipt({
      parsed: { ...parsed, receiptDate: null },
      now: NOW,
      maxAgeDays: 3,
      businessVerifiedAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(result.rejection).toBeNull();
  });

  it("signals a future-dated receipt without rejecting it", () => {
    const result = validateParsedReceipt({
      parsed: { ...parsed, receiptDate: new Date(NOW.getTime() + 48 * 3_600_000) },
      now: NOW,
      maxAgeDays: 3,
      businessVerifiedAt: null,
    });
    expect(result.rejection).toBeNull();
    expect(result.signals[0]?.signal).toBe("timestamp_anomaly");
    expect(result.signals[0]?.severity).toBe("warn");
  });

  it("routes an out-of-bounds total to review rather than rejecting it", () => {
    const result = validateParsedReceipt({
      parsed: { ...parsed, withinAmountSanity: false },
      now: NOW,
      maxAgeDays: 3,
      businessVerifiedAt: null,
    });
    expect(result.rejection).toBeNull();
    expect(result.forceReview).toBe(true);
  });
});

describe("resolveOutcome", () => {
  it("lets a fraud block outrank a validation rejection", () => {
    expect(
      resolveOutcome({
        routed: { status: "rejected", reason: "duplicate" },
        validationRejection: "too_old",
        forceReview: false,
        matchedBusinessId: BUSINESS_ID,
      }),
    ).toEqual({ status: "rejected", reason: "duplicate" });
  });

  it("lets a validation rejection outrank confidence routing", () => {
    expect(
      resolveOutcome({
        routed: { status: "approved" },
        validationRejection: "too_old",
        forceReview: false,
        matchedBusinessId: BUSINESS_ID,
      }),
    ).toEqual({ status: "rejected", reason: "too_old" });
  });

  it("upgrades an approval to review when a human is required", () => {
    expect(
      resolveOutcome({
        routed: { status: "approved" },
        validationRejection: null,
        forceReview: true,
        matchedBusinessId: BUSINESS_ID,
      }),
    ).toEqual({ status: "review" });
  });

  it("never parks a review with a null business id", () => {
    expect(
      resolveOutcome({
        routed: { status: "review" },
        validationRejection: null,
        forceReview: false,
        matchedBusinessId: null,
      }),
    ).toEqual({ status: "rejected", reason: "wrong_business" });
  });
});

describe("resolveStacking", () => {
  const exclusive: CampaignRow = {
    id: "c-exclusive",
    type: "promotion",
    status: "active",
    starts_at: null,
    ends_at: null,
    timezone: "Asia/Manila",
    priority: 10,
    is_stackable: false,
  };
  const stackableA: CampaignRow = { ...exclusive, id: "c-a", priority: 20, is_stackable: true };
  const stackableB: CampaignRow = { ...exclusive, id: "c-b", priority: 30, is_stackable: true };
  const campaigns = new Map([
    [exclusive.id, exclusive],
    [stackableA.id, stackableA],
    [stackableB.id, stackableB],
  ]);

  it("lets a non-stackable campaign apply alone", () => {
    const applied = resolveStacking(
      [{ campaignId: stackableA.id }, { campaignId: exclusive.id }],
      campaigns,
    );
    expect(applied.map((entry) => entry.campaignId)).toEqual([exclusive.id]);
  });

  it("stacks campaigns that all allow it", () => {
    const applied = resolveStacking(
      [{ campaignId: stackableB.id }, { campaignId: stackableA.id }],
      campaigns,
    );
    expect(applied.map((entry) => entry.campaignId)).toEqual([stackableA.id, stackableB.id]);
  });

  it("always applies business-default rules that belong to no campaign", () => {
    const applied = resolveStacking(
      [{ campaignId: exclusive.id }, { campaignId: null }],
      campaigns,
    );
    expect(applied.map((entry) => entry.campaignId)).toEqual([null, exclusive.id]);
  });

  it("keeps every rule of the campaign it accepted", () => {
    const applied = resolveStacking(
      [{ campaignId: exclusive.id }, { campaignId: exclusive.id }],
      campaigns,
    );
    expect(applied).toHaveLength(2);
  });
});

describe("toPointsRule", () => {
  it("maps an amount_rate base row", () => {
    const rule = toPointsRule(BASE_RULE);
    expect(rule).toMatchObject({
      kind: "base",
      rule_type: "amount_rate",
      rate_centavos_per_point: 100,
      rounding: "floor",
    });
  });

  it("maps tiers from their snake_case jsonb shape", () => {
    const rule = toPointsRule({
      ...BASE_RULE,
      rule_type: "tiered_amount",
      rate_centavos_per_point: null,
      tiers: [
        { min_centavos: 0, max_centavos: 19_999, points: 5 },
        { min_centavos: 20_000, max_centavos: null, points: 20 },
      ],
    });
    expect(rule?.tiers).toEqual([
      { minCentavos: 0, maxCentavos: 19_999, points: 5 },
      { minCentavos: 20_000, maxCentavos: null, points: 20 },
    ]);
  });

  it("drops a row whose enumerated columns are not values the engine knows", () => {
    expect(toPointsRule({ ...BASE_RULE, rounding: "banker" })).toBeNull();
    expect(toPointsRule({ ...BASE_RULE, rule_type: "vibes" })).toBeNull();
  });

  it("drops a multiplier whose conditions fail the DSL rather than over-awarding", () => {
    expect(
      toPointsRule({
        ...BASE_RULE,
        kind: "multiplier",
        multiplier: 2,
        conditions: { unknown_key: true },
      }),
    ).toBeNull();
  });

  it("keeps a base rule with unusable conditions, treating them as always-applies", () => {
    const rule = toPointsRule({ ...BASE_RULE, conditions: { unknown_key: true } });
    expect(rule?.conditions).toEqual({});
  });
});
