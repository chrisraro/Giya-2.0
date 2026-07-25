// @vitest-environment node
//
// The receipts slice's notification adapter.
//
// Two things are pinned here and they matter for different reasons.
//
//   1. EACH OUTCOME RAISES THE RIGHT KIND, with the right payload. That is the
//      doc 36 Stage 10 contract, and it is what the inbox switches its icon,
//      its tone and its deep link on.
//
//   2. NOTHING FROM THE FRAUD STAGE REACHES THE MESSAGE. The last describe
//      block re-runs the SAME forbidden-vocabulary list that
//      ../components/receipt-copy.test.ts sweeps the copy matrix with, over
//      every string this module composes. The list is duplicated verbatim
//      rather than imported because that file does not export it, and because a
//      shared list quietly narrowed in one place would weaken both sweeps at
//      once - the duplication is the point, and the comment above each entry in
//      receipt-copy.test.ts explains where the words come from (doc 37's signal
//      catalog, doc 36's Stage 9 confidence model, the columns 0017 withholds).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => ({}) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => null }));

import type { Database } from "@/lib/supabase/types";

import type { ReceiptRejectReason } from "../types";
import type { AwardResult } from "./award";
import { notifyReceiptOutcome } from "./notify";
import type { ReceiptNotifyOutcome } from "./notify";

const USER_ID = "01980000-0000-7000-8000-0000000000c1";
const BUSINESS_ID = "01980000-0000-7000-8000-0000000000b1";
const RECEIPT_ID = "01980000-0000-7000-8000-000000000001";
const SHOP_NAME = "Kape Diaria";

interface Raised {
  user_id: string;
  business_id: string | null;
  kind: string;
  title: string;
  body: string;
  data: { route?: string; params?: Record<string, unknown> };
}

interface Harness {
  deps: { supabase: SupabaseClient<Database> };
  raised: Raised[];
  businessReads: number;
}

function createHarness(shopName: string | null = SHOP_NAME): Harness {
  const raised: Raised[] = [];
  const harness: Harness = {
    deps: { supabase: null as unknown as SupabaseClient<Database> },
    raised,
    businessReads: 0,
  };

  const client = {
    from: (table: string) => {
      if (table === "notifications") {
        return {
          insert: (payload: Raised) => {
            raised.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      }
      // businesses: the shop-name read, only reached when the caller did not
      // already have the name.
      harness.businessReads += 1;
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: () =>
          Promise.resolve({
            data: shopName === null ? null : { name: shopName },
            error: null,
          }),
      };
      return query;
    },
  };

  harness.deps = { supabase: client as unknown as SupabaseClient<Database> };
  return harness;
}

async function notify(
  outcome: ReceiptNotifyOutcome,
  overrides: { businessName?: string | null; harness?: Harness } = {},
): Promise<Harness> {
  const harness = overrides.harness ?? createHarness();
  await notifyReceiptOutcome({
    deps: harness.deps,
    userId: USER_ID,
    receiptId: RECEIPT_ID,
    businessId: BUSINESS_ID,
    ...(overrides.businessName === undefined
      ? {}
      : { businessName: overrides.businessName }),
    outcome,
  });
  return harness;
}

const AWARDED: AwardResult = { kind: "awarded", points: 120, transactionId: "t1" };

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ===========================================================================
// One outcome, one kind
// ===========================================================================

describe("approved and points awarded", () => {
  it("raises points_awarded carrying the points and the shop name", async () => {
    const harness = await notify(
      { status: "approved", award: AWARDED },
      { businessName: SHOP_NAME },
    );

    expect(harness.raised).toHaveLength(1);
    const row = harness.raised[0];
    expect(row?.kind).toBe("points_awarded");
    expect(row?.body).toContain("120");
    expect(row?.body).toContain(SHOP_NAME);
    expect(row?.user_id).toBe(USER_ID);
    expect(row?.business_id).toBe(BUSINESS_ID);
  });

  it("deep-links to the receipt status screen, which renders the same copy", async () => {
    const harness = await notify(
      { status: "approved", award: AWARDED },
      { businessName: SHOP_NAME },
    );

    expect(harness.raised[0]?.data.route).toBe(`/scan/${RECEIPT_ID}`);
    expect(harness.raised[0]?.data.params).toMatchObject({
      receipt_id: RECEIPT_ID,
      business_id: BUSINESS_ID,
      points: 120,
    });
  });

  it("reads the shop name itself when the caller does not have it", async () => {
    const harness = await notify({ status: "approved", award: AWARDED });

    expect(harness.businessReads).toBe(1);
    expect(harness.raised[0]?.body).toContain(SHOP_NAME);
  });

  it("does not read the shop name when the caller supplied one", async () => {
    const harness = await notify(
      { status: "approved", award: AWARDED },
      { businessName: SHOP_NAME },
    );

    expect(harness.businessReads).toBe(0);
  });

  it("degrades to a plainer sentence rather than no message when the name is unknown", async () => {
    const harness = await notify(
      { status: "approved", award: AWARDED },
      { businessName: null },
    );

    expect(harness.raised).toHaveLength(1);
    expect(harness.raised[0]?.body).toContain("your wallet");
  });

  it("promises no number when the ledger write was refused", async () => {
    const refused: AwardResult = { kind: "refused", code: "CUSTOMER_BLACKLISTED", severity: "warn" };
    const harness = await notify(
      { status: "approved", award: refused },
      { businessName: SHOP_NAME },
    );

    expect(harness.raised[0]?.kind).toBe("points_awarded");
    expect(harness.raised[0]?.body).not.toMatch(/\d/);
    expect(harness.raised[0]?.data.params).toMatchObject({ points: null });
  });

  it("CRITICAL: raises nothing at all for a zero-point approval", async () => {
    // "0 points are now in your wallet" reads as a failure and tells the
    // consumer nothing their receipt history does not already show.
    const harness = await notify(
      { status: "approved", award: { kind: "skipped_zero_points" } },
      { businessName: SHOP_NAME },
    );

    expect(harness.raised).toHaveLength(0);
  });
});

describe("routed to a human", () => {
  it("raises receipt_in_review", async () => {
    const harness = await notify({ status: "review" }, { businessName: SHOP_NAME });

    expect(harness.raised).toHaveLength(1);
    expect(harness.raised[0]?.kind).toBe("receipt_in_review");
    expect(harness.raised[0]?.title).toBe("The store is checking this");
  });

  it("does not read the shop name: the review copy does not name one", async () => {
    const harness = await notify({ status: "review" });

    expect(harness.businessReads).toBe(0);
  });
});

describe("rejected", () => {
  const REASONS: readonly ReceiptRejectReason[] = [
    "duplicate",
    "unreadable",
    "wrong_business",
    "too_old",
    "fraud_suspected",
    "manual",
  ];

  it.each(REASONS)("raises receipt_rejected for %s", async (reason) => {
    const harness = await notify(
      { status: "rejected", reason },
      { businessName: SHOP_NAME },
    );

    expect(harness.raised).toHaveLength(1);
    expect(harness.raised[0]?.kind).toBe("receipt_rejected");
    expect(harness.raised[0]?.data.params).toMatchObject({ reject_reason: reason });
  });

  it("still renders an explanation for a null reason", async () => {
    const harness = await notify({ status: "rejected", reason: null });

    expect(harness.raised[0]?.title.length).toBeGreaterThan(0);
    expect(harness.raised[0]?.body.length).toBeGreaterThan(0);
  });

  it("CRITICAL: uses the copy matrix verbatim, not a second set of strings", async () => {
    // The tested matrix says exactly this for a duplicate. If this assertion
    // ever fails because the string moved, the fix is to update
    // receipt-copy.ts, never to write the string here.
    const harness = await notify({ status: "rejected", reason: "duplicate" });

    expect(harness.raised[0]?.title).toBe("Already scanned");
    expect(harness.raised[0]?.body).toBe(
      "This receipt is already on your account. Each receipt can earn points once.",
    );
  });
});

// ===========================================================================
// The leak sweep
// ===========================================================================

describe("CRITICAL: no fraud internals reach a notification", () => {
  // Verbatim from ../components/receipt-copy.test.ts. See that file's header
  // for where each word comes from.
  const FORBIDDEN = [
    /\bfraud\b/i,
    /\bsignal\b/i,
    /\bscore\b/i,
    /\bconfidence\b/i,
    /\bthreshold\b/i,
    /\bvelocity\b/i,
    /\bhash\b/i,
    /\bphash\b/i,
    /\bsha256\b/i,
    /\bhamming\b/i,
    /\bduplicate of\b/i,
    /\bmatched receipt\b/i,
    /\banother (user|consumer|customer|account)\b/i,
    /\breject_note\b/i,
    /\bparse_meta\b/i,
    /\bocr\b/i,
    /\bparse[_ ]confidence\b/i,
    /\bmatch[_ ]confidence\b/i,
    /\bgps\b/i,
    /\bdevice\b/i,
    /\bsuspicious\b/i,
    /\bblocked\b/i,
    /\bbanned\b/i,
  ];

  /** Every message this module can compose, across every outcome. */
  async function everyMessage(): Promise<{ where: string; text: string }[]> {
    const outcomes: { where: string; outcome: ReceiptNotifyOutcome }[] = [
      { where: "approved(awarded)", outcome: { status: "approved", award: AWARDED } },
      {
        where: "approved(refused)",
        outcome: {
          status: "approved",
          award: { kind: "refused", code: "RECEIPT_NOT_AWARDABLE", severity: "warn" },
        },
      },
      { where: "approved(no award)", outcome: { status: "approved", award: null } },
      { where: "review", outcome: { status: "review" } },
      { where: "rejected(null)", outcome: { status: "rejected", reason: null } },
    ];
    for (const reason of [
      "duplicate",
      "unreadable",
      "wrong_business",
      "too_old",
      "fraud_suspected",
      "manual",
    ] as const) {
      outcomes.push({
        where: `rejected(${reason})`,
        outcome: { status: "rejected", reason },
      });
    }

    const entries: { where: string; text: string }[] = [];
    for (const { where, outcome } of outcomes) {
      const harness = await notify(outcome, { businessName: SHOP_NAME });
      for (const row of harness.raised) {
        entries.push({ where: `${where}.title`, text: row.title });
        entries.push({ where: `${where}.body`, text: row.body });
      }
    }
    return entries;
  }

  it("contains no fraud or parser vocabulary in any composed message", async () => {
    const messages = await everyMessage();
    expect(messages.length).toBeGreaterThan(0);

    for (const { where, text } of messages) {
      for (const pattern of FORBIDDEN) {
        expect(text, `${where} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("uses no em-dash in any composed message", async () => {
    for (const { text } of await everyMessage()) {
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
    }
  });

  it("CRITICAL: has no parameter that could carry the reviewer's free-text note", async () => {
    // 0017 makes reject_note unreadable by the client and receipt-copy.ts has
    // no parameter for it. This asserts the same at this layer: the payload the
    // adapter builds carries the enum reason and nothing else about the
    // decision.
    const harness = await notify({ status: "rejected", reason: "fraud_suspected" });
    const params = harness.raised[0]?.data.params ?? {};

    expect(Object.keys(params).sort()).toEqual(["receipt_id", "reject_reason"]);
  });
});

describe("the adapter never throws", () => {
  it("swallows a database failure, because the receipt is already decided", async () => {
    const client = {
      from: () => ({
        insert: () => Promise.reject(new Error("socket hang up")),
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.reject(new Error("x")) }) }),
      }),
    };

    await expect(
      notifyReceiptOutcome({
        deps: { supabase: client as unknown as SupabaseClient<Database> },
        userId: USER_ID,
        receiptId: RECEIPT_ID,
        businessId: BUSINESS_ID,
        outcome: { status: "approved", award: AWARDED },
      }),
    ).resolves.toBeUndefined();
  });
});
