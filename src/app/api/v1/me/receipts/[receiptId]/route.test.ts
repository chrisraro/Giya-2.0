import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReceiptDetailDTO } from "@/features/receipts/types";

// GET /api/v1/me/receipts/{id} - doc 36's "Detail + receipt_line_items", and
// the 5s poll fallback for both Realtime surfaces.
//
// The headline test here is the 404-not-403 one. `receipts` RLS is a UNION of
// the consumer-self policy and the staff-of-the-matched-business policy, so a
// row coming back from a session-scoped read is not proof of ownership; the
// repository re-checks user_id and collapses "absent" and "not yours" into a
// single null. Answering 403 for the second case would confirm that the id
// names a real receipt, which is exactly the id oracle doc 13's rule exists to
// prevent. The reward-claim token route made the same call for the same
// reason, and this test is its counterpart.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getMyReceipt: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

vi.mock("@/features/receipts/server/repo", () => ({
  getMyReceipt: mocks.getMyReceipt,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/redis", () => ({
  redisKey: (...parts: string[]) => `test:${parts.join(":")}`,
}));

const { GET } = await import("./route");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "99999999-9999-4999-8999-999999999999";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";

function detail(overrides: Partial<ReceiptDetailDTO> = {}): ReceiptDetailDTO {
  return {
    receiptId: RECEIPT_ID,
    businessId: "22222222-2222-4222-8222-222222222222",
    businessName: "Kape Diaria",
    status: "approved",
    rejectReason: null,
    merchantName: "KAPE DIARIA",
    receiptNumber: "OR-000412",
    receiptDate: "2026-07-24T04:00:00.000Z",
    totalCentavos: 24500,
    createdAt: "2026-07-25T03:15:00.000Z",
    processedAt: "2026-07-25T03:15:40.000Z",
    pointsAwarded: 245,
    lineItems: [
      {
        id: "line-1",
        rawText: "1 KAPE BARAKO 145.00",
        qty: 1,
        unitPriceCentavos: 14500,
        lineTotalCentavos: 14500,
        sort: 0,
      },
      {
        id: "line-2",
        rawText: "1 PANDESAL 100.00",
        qty: 1,
        unitPriceCentavos: 10000,
        lineTotalCentavos: 10000,
        sort: 1,
      },
    ],
    ...overrides,
  };
}

async function callRoute(receiptId = RECEIPT_ID): Promise<Response> {
  const request = new NextRequest(`https://giya.test/api/v1/me/receipts/${receiptId}`, {
    method: "GET",
  });
  return GET(request, { params: Promise.resolve({ receiptId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
  mocks.checkRateLimit.mockResolvedValue({ ok: true, remaining: 119, resetSeconds: 60 });
});

describe("auth and ownership", () => {
  it("returns 401 with no session", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    const response = await callRoute();

    expect(response.status).toBe(401);
    expect(mocks.getMyReceipt).not.toHaveBeenCalled();
  });

  it("asks the repository for the receipt scoped to the CALLER's id", async () => {
    mocks.getMyReceipt.mockResolvedValue(detail());

    await callRoute();

    expect(mocks.getMyReceipt).toHaveBeenCalledWith(RECEIPT_ID, USER_ID);
  });

  it("returns 404 NOT_FOUND when the receipt does not exist", async () => {
    mocks.getMyReceipt.mockResolvedValue(null);

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("CRITICAL: another user's receipt 404s, it does not 403", async () => {
    // The repository collapses "not yours" to null exactly as it does
    // "absent", so the two are indistinguishable from outside. A 403 here
    // would confirm the id names a real receipt.
    mocks.getUser.mockResolvedValue({ data: { user: { id: OTHER_USER_ID } } });
    mocks.getMyReceipt.mockResolvedValue(null);

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.code).not.toBe("FORBIDDEN");
  });

  it("gives the identical message for absent and for not-yours", async () => {
    mocks.getMyReceipt.mockResolvedValue(null);
    const absent = await (await callRoute()).json();

    mocks.getUser.mockResolvedValue({ data: { user: { id: OTHER_USER_ID } } });
    mocks.getMyReceipt.mockResolvedValue(null);
    const notYours = await (await callRoute()).json();

    expect(absent.error.message).toBe(notYours.error.message);
    expect(absent.error.code).toBe(notYours.error.code);
  });
});

describe("validation", () => {
  it("rejects a non-uuid receipt id before touching the repository", async () => {
    const response = await callRoute("not-a-uuid");
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(mocks.getMyReceipt).not.toHaveBeenCalled();
  });
});

describe("the detail body", () => {
  it("returns the receipt plus its line items in snake_case", async () => {
    mocks.getMyReceipt.mockResolvedValue(detail());

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      receipt_id: RECEIPT_ID,
      status: "approved",
      total_centavos: 24500,
      points_awarded: 245,
    });
    expect(body.data.line_items).toEqual([
      {
        id: "line-1",
        raw_text: "1 KAPE BARAKO 145.00",
        qty: 1,
        unit_price_centavos: 14500,
        line_total_centavos: 14500,
        sort: 0,
      },
      {
        id: "line-2",
        raw_text: "1 PANDESAL 100.00",
        qty: 1,
        unit_price_centavos: 10000,
        line_total_centavos: 10000,
        sort: 1,
      },
    ]);
  });

  it("returns an empty line_items array for a receipt that never parsed any", async () => {
    mocks.getMyReceipt.mockResolvedValue(detail({ lineItems: [] }));

    const body = await (await callRoute()).json();

    expect(body.data.line_items).toEqual([]);
  });

  it("carries the rejection reason but never a reviewer note", async () => {
    mocks.getMyReceipt.mockResolvedValue(
      detail({
        status: "rejected",
        rejectReason: "fraud_suspected",
        pointsAwarded: null,
        lineItems: [],
      }),
    );

    const raw = await (await callRoute()).text();
    const body = JSON.parse(raw);

    expect(body.data.reject_reason).toBe("fraud_suspected");
    expect(body.data.points_awarded).toBeNull();
    expect(raw).not.toContain("reject_note");
  });

  it("distinguishes points_awarded null from zero", async () => {
    mocks.getMyReceipt.mockResolvedValue(detail({ pointsAwarded: null }));
    expect((await (await callRoute()).json()).data.points_awarded).toBeNull();

    mocks.getMyReceipt.mockResolvedValue(detail({ pointsAwarded: 0 }));
    expect((await (await callRoute()).json()).data.points_awarded).toBe(0);
  });

  it("is never cached", async () => {
    mocks.getMyReceipt.mockResolvedValue(detail());

    const response = await callRoute();

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("no fraud internals in the response body", () => {
  it("emits exactly the granted fields, whatever the repository hands over", async () => {
    mocks.getMyReceipt.mockResolvedValue({
      ...detail({ status: "rejected", rejectReason: "fraud_suspected", lineItems: [] }),
      ...({
        rejectNote: "same image as receipt 8f21 submitted by Ana Cruz",
        reject_note: "same image as receipt 8f21 submitted by Ana Cruz",
        parseMeta: { total: { tier: "llm", conf: 0.41 } },
        matchConfidence: 0.62,
        parseConfidence: 0.44,
        sha256: "9f86d081884c7d659a2feaa0c55ad015a",
        imageHash: "c0ffee1234567890",
        imagePath: `${USER_ID}/abc.jpg`,
        fraudSignals: [{ signal: "image_hash_dup", score: 0.9, severity: "block" }],
      } as Record<string, unknown>),
    });

    const raw = await (await callRoute()).text();
    const body = JSON.parse(raw);

    expect(Object.keys(body.data).sort()).toEqual([
      "business_id",
      "business_name",
      "created_at",
      "line_items",
      "merchant_name",
      "points_awarded",
      "processed_at",
      "receipt_date",
      "receipt_id",
      "receipt_number",
      "reject_reason",
      "status",
      "total_centavos",
    ]);

    expect(raw).not.toContain("Ana Cruz");
    expect(raw).not.toContain("8f21");
    expect(raw).not.toContain("9f86d081");
    expect(raw).not.toContain("c0ffee");
    expect(raw).not.toContain("image_hash_dup");
    expect(raw).not.toContain("confidence");
    expect(raw).not.toContain("severity");
    expect(raw).not.toContain("image_path");
  });

  it("also strips parser internals from line items (product_id, match_score)", async () => {
    mocks.getMyReceipt.mockResolvedValue(
      detail({
        lineItems: [
          {
            ...detail().lineItems[0]!,
            ...({ productId: "prod-1", matchScore: 0.83 } as Record<string, unknown>),
          },
        ],
      }),
    );

    const raw = await (await callRoute()).text();
    const body = JSON.parse(raw);

    expect(Object.keys(body.data.line_items[0]).sort()).toEqual([
      "id",
      "line_total_centavos",
      "qty",
      "raw_text",
      "sort",
      "unit_price_centavos",
    ]);
    expect(raw).not.toContain("prod-1");
    expect(raw).not.toContain("match_score");
  });
});

describe("rate limiting", () => {
  it("applies doc 13's general authenticated ceiling of 120/min per user", async () => {
    mocks.getMyReceipt.mockResolvedValue(detail());

    await callRoute();

    expect(mocks.checkRateLimit).toHaveBeenCalledWith({
      key: `test:rl:me.receipts.detail:user:${USER_ID}`,
      limit: 120,
      windowSeconds: 60,
    });
  });

  it("returns 429 with Retry-After when the limiter blocks a polling client", async () => {
    mocks.checkRateLimit.mockResolvedValue({ ok: false, remaining: 0, resetSeconds: 9 });

    const response = await callRoute();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("9");
    expect(mocks.getMyReceipt).not.toHaveBeenCalled();
  });
});
