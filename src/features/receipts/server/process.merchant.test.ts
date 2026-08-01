// @vitest-environment node
//
// The foreign-receipt defence, end to end through the real pipeline.
//
// A SEPARATE FILE FROM process.test.ts, deliberately. That suite pins the
// pipeline's existing behaviour and none of it changes here; this one is about
// a single question - does the name printed on the paper belong to the shop
// the consumer tapped - and every fixture in it is built to make that question
// the only variable.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));
vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
  incr: () => Promise.resolve(1),
  expireNx: () => Promise.resolve(true),
}));

import type { Database } from "@/lib/supabase/types";

import type { RivalMerchant } from "../matching";
import { DEFAULT_RECEIPT_SETTINGS } from "./settings";
import type { OcrProvider, OcrResponse } from "./ocr/provider";
import { processReceipt } from "./process";
import type { ProcessReceiptDeps } from "./process";
import type { PointsRuleRow } from "./award";

// ===========================================================================
// A fake Supabase client, same shape as the one process.test.ts uses: it
// records every operation and answers it from an in-memory world, so the tests
// exercise the REAL query construction rather than a repository port.
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
  or(filter: string): this {
    return this.filter("or", filter);
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

// ===========================================================================
// Fixtures
// ===========================================================================

const RECEIPT_ID = "01980000-0000-7000-8000-0000000000f1";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b9";
const RIVAL_BUSINESS_ID = "01980000-0000-7000-8000-0000000000b8";
const CONSUMER_ID = "01980000-0000-7000-8000-0000000000c9";

/** The shop the consumer tapped in the app. */
const SHOP_NAME = "Kape Bicolandia";

const NOW = new Date("2026-07-25T04:00:00.000Z");

const BASE_RULE: PointsRuleRow = {
  id: "01980000-0000-7000-8000-0000000000r9",
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

/**
 * A clean, honest PH thermal slip with a swappable header.
 *
 * Everything below the first line is identical across every test in this file
 * and is deliberately PERFECT: a readable total, a fresh date, an OR number, a
 * consistent 12% VAT block. That is the point. Freshness, uniqueness and the
 * amount ceiling all pass, parse confidence saturates, and the receipt routes
 * on its own merits - so the ONLY thing that can change the outcome is the
 * name on the top line, which is exactly the variable under test and exactly
 * what made the attack work before this check existed.
 */
function slip(header: string): string {
  return [
    header,
    "NAGA CITY BRANCH",
    "TIN 123-456-789-000",
    "OR# 0012345",
    "07/24/2026 13:45",
    "",
    "1  KAPE BARAKO             120.00     120.00",
    "2  PANDESAL                 35.00      70.00",
    "",
    "VATABLE SALES                          169.64",
    "VAT (12%)                               20.36",
    "TOTAL                                  190.00",
    "",
    "THIS SERVES AS AN OFFICIAL RECEIPT",
  ].join("\n");
}

/**
 * The same purchase, photographed with the top of the slip creased away.
 *
 * The trading name and the branch line are both gone; what survives above the
 * items is BIR metadata and the timestamp, none of which is a shop name and
 * none of which the parser will mistake for one. This is the ordinary failure,
 * not an exotic one: the top of a receipt is the part that creases, fades and
 * gets cropped by a hurried photograph, so a check that treated a null header
 * as a pass would be silently disabled on a large slice of real traffic.
 */
const UNREADABLE_SLIP = [
  "~~~~ ~~~~",
  "~~~~~~~~",
  "TIN 123-456-789-000",
  "VAT REG TIN 123-456-789-000",
  "MIN 12345678901234",
  "SERIAL SN 0123456789",
  "07/24/2026 13:45",
  "OR# 0012345",
  "",
  "1  KAPE BARAKO             120.00     120.00",
  "2  PANDESAL                 35.00      70.00",
  "",
  "VATABLE SALES                          169.64",
  "VAT (12%)                               20.36",
  "TOTAL                                  190.00",
  "",
  "THIS SERVES AS AN OFFICIAL RECEIPT",
].join("\n");

interface World {
  businessName: string;
  aliases: Array<{ alias: string }>;
  rivals: RivalMerchant[];
  customerSegment: string;
}

interface Harness {
  deps: ProcessReceiptDeps;
  ops: FakeOp[];
  rpcCalls: Array<{ name: string; args: unknown }>;
  receiptUpdate(): Record<string, unknown> | undefined;
  parseMeta(): Record<string, unknown>;
  merchantCheck(): Record<string, unknown> | null;
  reviewReasons(): string[];
}

function createHarness(
  input: {
    header?: string;
    rawText?: string;
    world?: Partial<World>;
    withRivalProbe?: boolean;
  } = {},
): Harness {
  const world: World = {
    businessName: SHOP_NAME,
    aliases: [],
    rivals: [],
    customerSegment: "regular",
    ...input.world,
  };

  const ops: FakeOp[] = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const respond: Responder = (op) => {
    const ok = (data: unknown): FakeResult => ({ data, error: null });
    if (op.op !== "select") return ok(null);

    switch (op.table) {
      case "receipts":
        if (op.columns.startsWith("id, business_id")) {
          return ok({
            id: RECEIPT_ID,
            business_id: BUSINESS_ID,
            user_id: CONSUMER_ID,
            status: "queued",
            image_path: `${CONSUMER_ID}/photo.jpg`,
            image_hash: "0f1e2d3c4b5a6978",
            device_id: null,
            created_at: "2026-07-25T03:55:00.000Z",
          });
        }
        return ok([]);
      case "ocr_results":
        return ok([]);
      case "receipt_templates":
        return ok([]);
      case "business_merchant_aliases":
        return ok(world.aliases);
      case "businesses":
        return ok({
          id: BUSINESS_ID,
          name: world.businessName,
          verified_at: "2026-01-01T00:00:00.000Z",
        });
      case "business_customers":
        return ok({ segment: world.customerSegment, visit_count: 3 });
      case "business_staff":
        return ok(null);
      case "points_rules":
        return ok([BASE_RULE]);
      case "campaigns":
        return ok([]);
      case "consumers":
        return ok({ scan_blocked_until: null });
      default:
        return ok([]);
    }
  };

  const client = {
    from: (table: string) => new FakeQuery(table, respond, (op) => ops.push(op)),
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve({
            data: { signedUrl: "https://signed.example/receipt.jpg" },
            error: null,
          }),
      }),
    },
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: "ledger-row-id", error: null });
    },
  };

  const response: OcrResponse = {
    engine: "stub",
    engineVersion: "stub-v1",
    preprocessOps: ["stub"],
    rawText: input.rawText ?? slip(input.header ?? SHOP_NAME.toUpperCase()),
    blocks: [],
    meanConfidence: 0.95,
    durationMs: 1200,
  };
  const ocr: OcrProvider = { name: "stub", ocr: () => Promise.resolve(response) };

  const deps: ProcessReceiptDeps = {
    supabase: client as unknown as SupabaseClient<Database>,
    ocr,
    loadSettings: () => Promise.resolve(DEFAULT_RECEIPT_SETTINGS),
    redis: { incr: () => Promise.resolve(1), expireNx: () => Promise.resolve(true) },
    now: () => NOW,
    ...(input.withRivalProbe === false
      ? {}
      : { findRivalMerchants: () => Promise.resolve(world.rivals) }),
  };

  const receiptUpdate = (): Record<string, unknown> | undefined =>
    ops
      .filter((op) => op.table === "receipts" && op.op === "update")
      .map((op) => op.payload as Record<string, unknown>)
      .find((payload) => payload.status !== "processing");

  const parseMeta = (): Record<string, unknown> =>
    (receiptUpdate()?.parse_meta ?? {}) as Record<string, unknown>;

  return {
    deps,
    ops,
    rpcCalls,
    receiptUpdate,
    parseMeta,
    merchantCheck: () =>
      (parseMeta().merchant_check ?? null) as Record<string, unknown> | null,
    reviewReasons: () => (parseMeta().review_reasons ?? []) as string[],
  };
}

// ===========================================================================
// The attack
// ===========================================================================

describe("the Jollibee-receipt-at-Kape-Bicolandia attack", () => {
  it("routes to review and awards nothing", async () => {
    // THE WHOLE POINT OF THIS SLICE. Buy PHP 190 of food at Jollibee, open
    // Giya, tap Kape Bicolandia, scan the Jollibee slip. Every other defence
    // holds - the receipt is fresh, unique and under the ceiling - so before
    // this check the pre-bound floor of 0.85 was the match confidence, 0.85 is
    // exactly matchAccept, and 190 of Kape Bicolandia's points were minted
    // from a purchase made at a competitor.
    const harness = createHarness({ header: "JOLLIBEE" });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("review");
    // No award RPC of any kind: not the points ledger, not the zero-point
    // visit path either.
    expect(harness.rpcCalls).toHaveLength(0);
  });

  it("does NOT reject the receipt, whatever the header says", async () => {
    // D1. A rejection would punish a real customer for our own OCR on the day
    // this fires on a genuine receipt, and a rejection in the fraud family
    // would advance their cooldown strike count on top of it.
    const harness = createHarness({ header: "JOLLIBEE" });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.status).not.toBe("rejected");
    expect(update?.reject_reason).toBeNull();
  });

  it("leaves match_confidence at the pre-bound floor, which is the hole itself", async () => {
    // THE MECHANISM, AND THE PROOF THE HOLE WAS REAL. `matchBusiness` still
    // hands back 0.85 for this receipt - the pre-bound floor, because a
    // pre-bound scan has exactly one candidate and nothing can contradict it -
    // and 0.85 is exactly `matchAccept`, so `routeReceipt` would still accept
    // the binding on its own. The check deliberately does NOT push that number
    // down: below `matchReview` it would become a `wrong_business` REJECTION,
    // and a rejection would punish a real customer on the day this fires on a
    // genuine receipt. It reaches the router through `forceReview` instead.
    const attack = createHarness({ header: "JOLLIBEE" });

    await processReceipt(RECEIPT_ID, attack.deps);

    expect(attack.receiptUpdate()?.match_confidence).toBe(0.85);
    expect(attack.receiptUpdate()?.match_confidence).toBeGreaterThanOrEqual(
      DEFAULT_RECEIPT_SETTINGS.routing.matchAccept,
    );
    // And the receipt is still routed to a human, on the strength of the name
    // check alone.
    expect(attack.receiptUpdate()?.status).toBe("review");
  });

  it("still persists every parsed field, so the reviewer has something to work with", async () => {
    const harness = createHarness({ header: "JOLLIBEE" });

    await processReceipt(RECEIPT_ID, harness.deps);

    const update = harness.receiptUpdate();
    expect(update?.merchant_name).toBe("JOLLIBEE");
    expect(update?.total_centavos).toBe(19_000);
    expect(update?.business_id).toBe(BUSINESS_ID);
  });
});

// ===========================================================================
// The two review reasons, kept apart
// ===========================================================================

describe("an unreadable header", () => {
  it("routes to review rather than passing", async () => {
    // D3. Null must not mean pass: "the check failed to run" silently becoming
    // "the check passed" is how points get minted, and the top of a receipt is
    // the most damaged part of it, so this is common.
    const harness = createHarness({ rawText: UNREADABLE_SLIP });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("review");
    expect(harness.rpcCalls).toHaveLength(0);
  });

  it("is recorded as a DIFFERENT reason from a mismatch", async () => {
    // The two prompt completely different human decisions - one is a photo
    // problem, the other is a foreign receipt - so a queue that renders them
    // identically makes every reviewer re-derive the difference from the image.
    const unreadable = createHarness({ rawText: UNREADABLE_SLIP });
    const mismatch = createHarness({ header: "JOLLIBEE" });

    await processReceipt(RECEIPT_ID, unreadable.deps);
    await processReceipt(RECEIPT_ID, mismatch.deps);

    expect(unreadable.reviewReasons()).toEqual(["merchant_name_unreadable"]);
    expect(mismatch.reviewReasons()).toEqual(["merchant_name_mismatch"]);
    expect(unreadable.merchantCheck()?.verdict).toBe("unreadable");
    expect(mismatch.merchantCheck()?.verdict).toBe("mismatch");
  });

  it("records no header text, so the queue has nothing to offer to learn", async () => {
    const harness = createHarness({ rawText: UNREADABLE_SLIP });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.merchantCheck()?.header_text).toBeNull();
  });

  it("records the header verbatim on a mismatch, which is what a reviewer reads", async () => {
    const harness = createHarness({ header: "JOLLIBEE" });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.merchantCheck()?.header_text).toBe("JOLLIBEE");
  });
});

// ===========================================================================
// Honest receipts still pass
// ===========================================================================

describe("a genuine receipt at the shop it was scanned against", () => {
  it("still auto-approves and awards", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
    expect(harness.rpcCalls.map((call) => call.name)).toEqual(["award_receipt_points"]);
    expect(harness.reviewReasons()).toEqual([]);
    expect(harness.merchantCheck()?.verdict).toBe("match");
  });

  it("auto-approves through OCR mangling of the shop's own name", async () => {
    // "KAPE 8IC0LANDIA" is what a worn thermal head produces: a B read as an 8
    // and an O as a zero. It scores 0.45 against the registered name, which
    // clears 0.35 comfortably - and this is the entire argument for a generous
    // threshold. This customer made a real purchase and must not be queued for
    // our reading error.
    const harness = createHarness({ header: "KAPE 8IC0LANDIA" });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
    const check = harness.merchantCheck();
    expect(check?.verdict).toBe("match");
    expect(check?.score as number).toBeGreaterThanOrEqual(0.35);
  });

  it("auto-approves a branch suffix the registered name does not carry", async () => {
    const harness = createHarness({ header: "KAPE BICOLANDIA NAGA" });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
  });
});

// ===========================================================================
// The rival check
// ===========================================================================

describe("a header matching a different Giya merchant", () => {
  it("routes to review even when it is similar enough to the bound shop to pass alone", async () => {
    // D4's high-signal case. "KAPE BICOL EXPRESS" scores 0.40 against "Kape
    // Bicolandia" and would have auto-approved on that alone - but it is an
    // exact hit on another live Giya merchant, which is a far better
    // explanation for this piece of paper.
    const alone = createHarness({ header: "KAPE BICOL EXPRESS" });
    await processReceipt(RECEIPT_ID, alone.deps);
    expect(alone.receiptUpdate()?.status).toBe("approved");

    const withRival = createHarness({
      header: "KAPE BICOL EXPRESS",
      world: {
        rivals: [{ businessId: RIVAL_BUSINESS_ID, name: "Kape Bicol Express" }],
      },
    });

    await processReceipt(RECEIPT_ID, withRival.deps);

    expect(withRival.receiptUpdate()?.status).toBe("review");
    expect(withRival.rpcCalls).toHaveLength(0);
    expect(withRival.reviewReasons()).toEqual(["merchant_name_mismatch"]);
    expect(withRival.merchantCheck()?.rival).toMatchObject({
      business_id: RIVAL_BUSINESS_ID,
      name: "Kape Bicol Express",
    });
  });

  it("does not fire on a rival the header resembles less than the bound shop", async () => {
    const harness = createHarness({
      world: { rivals: [{ businessId: RIVAL_BUSINESS_ID, name: "Kape Bicol" }] },
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("approved");
    expect(harness.merchantCheck()?.rival).toBeNull();
  });

  it("still catches the attack with the rival probe entirely absent", async () => {
    // The probe is attribution, never safety: a deployment without it, or a
    // shop that is simply not on Giya, changes nothing about the defence.
    const harness = createHarness({ header: "JOLLIBEE", withRivalProbe: false });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("review");
    expect(harness.merchantCheck()?.rival).toBeNull();
  });
});

// ===========================================================================
// The alias, taught and then honoured
// ===========================================================================

describe("a learned alias", () => {
  it("makes an identical receipt auto-approve on the next scan", async () => {
    // The self-tuning loop, from the pipeline's side. The merchant's slips are
    // headed with a trading name that shares nothing with their registered
    // Giya name, so the first receipt goes to review; the reviewer taps "this
    // is my receipt header, always accept it"; the alias lands in
    // business_merchant_aliases; the next identical receipt approves.
    const before = createHarness({ header: "KB COFFEE HOUSE" });
    await processReceipt(RECEIPT_ID, before.deps);
    expect(before.receiptUpdate()?.status).toBe("review");

    const after = createHarness({
      header: "KB COFFEE HOUSE",
      world: { aliases: [{ alias: "KB Coffee House" }] },
    });

    await processReceipt(RECEIPT_ID, after.deps);

    expect(after.receiptUpdate()?.status).toBe("approved");
    expect(after.merchantCheck()).toMatchObject({
      verdict: "match",
      score: 1,
      matched_alias: "KB Coffee House",
    });
  });

  it("reads the business's aliases even though the shop has no template at all", async () => {
    // The design problem this table was created for: a brand new merchant has
    // no receipt_templates row, so `parse_config.merchant_aliases` has nowhere
    // to live, and the exact case this feature exists for would have been the
    // one with no storage.
    const harness = createHarness({
      header: "KB COFFEE HOUSE",
      world: { aliases: [{ alias: "KB Coffee House" }] },
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    const templateReads = harness.ops.filter((op) => op.table === "receipt_templates");
    expect(templateReads.length).toBeGreaterThan(0);
    expect(harness.receiptUpdate()?.template_id).toBeNull();
    expect(harness.receiptUpdate()?.status).toBe("approved");
  });

  it("is read with a business_id predicate, so one shop's aliases never widen another's", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    const read = harness.ops.find((op) => op.table === "business_merchant_aliases");
    expect(read?.filters).toContainEqual({ method: "eq", args: ["business_id", BUSINESS_ID] });
  });
});

// ===========================================================================
// Legibility
// ===========================================================================

describe("the recorded reason", () => {
  it("is written on a passing receipt too, so a silent regression is visible", async () => {
    const harness = createHarness();

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.merchantCheck()).toMatchObject({ verdict: "match", threshold: 0.35 });
    expect(harness.reviewReasons()).toEqual([]);
  });

  it("keeps the pre-existing forceReview causes working, now under their own names", async () => {
    // The refactor from one boolean to a list must not change what the four
    // existing causes DO, only what they SAY. A blacklisted customer still
    // forces review (doc 37's ladder step 3), and now says why.
    const harness = createHarness({ world: { customerSegment: "blacklisted" } });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.receiptUpdate()?.status).toBe("review");
    expect(harness.reviewReasons()).toEqual(["customer_blacklisted"]);
  });

  it("lists every reason when more than one fired", async () => {
    const harness = createHarness({
      header: "JOLLIBEE",
      world: { customerSegment: "blacklisted" },
    });

    await processReceipt(RECEIPT_ID, harness.deps);

    expect(harness.reviewReasons()).toEqual([
      "customer_blacklisted",
      "merchant_name_mismatch",
    ]);
  });
});
