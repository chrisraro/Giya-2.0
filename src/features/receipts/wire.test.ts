import { describe, expect, it } from "vitest";

import type { ReceiptDetailDTO } from "./types";
import { fromReceiptWire, toReceiptDetailWire, toReceiptWire } from "./wire";

// The single seam between camelCase DTOs and doc 13's snake_case HTTP body.
// Its whole value is that the list endpoint, the detail endpoint and the poll
// fallback cannot drift into three slightly different receipt shapes, so the
// round trip is pinned here.

function detail(overrides: Partial<ReceiptDetailDTO> = {}): ReceiptDetailDTO {
  return {
    receiptId: "11111111-1111-4111-8111-111111111111",
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
    escalatedAt: null,
    lineItems: [
      {
        id: "line-1",
        rawText: "1 KAPE BARAKO 145.00",
        qty: 1,
        unitPriceCentavos: 14500,
        lineTotalCentavos: 14500,
        sort: 0,
      },
    ],
    ...overrides,
  };
}

describe("toReceiptWire", () => {
  it("emits only snake_case keys", () => {
    for (const key of Object.keys(toReceiptWire(detail()))) {
      expect(key, key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("emits exactly the granted field set and nothing else", () => {
    expect(Object.keys(toReceiptWire(detail())).sort()).toEqual([
      "business_id",
      "business_name",
      "created_at",
      "escalated_at",
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
  });

  it("does not spread the source object, so an extra DTO field cannot leak", () => {
    const polluted = {
      ...detail(),
      ...({ rejectNote: "leak", sha256: "leak", matchConfidence: 0.6 } as Record<string, unknown>),
    } as ReceiptDetailDTO;

    expect(JSON.stringify(toReceiptWire(polluted))).not.toContain("leak");
    expect(JSON.stringify(toReceiptWire(polluted))).not.toContain("0.6");
  });
});

describe("toReceiptDetailWire", () => {
  it("adds line_items to the list shape", () => {
    const wire = toReceiptDetailWire(detail());

    expect(wire.receipt_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(wire.line_items).toEqual([
      {
        id: "line-1",
        raw_text: "1 KAPE BARAKO 145.00",
        qty: 1,
        unit_price_centavos: 14500,
        line_total_centavos: 14500,
        sort: 0,
      },
    ]);
  });
});

describe("fromReceiptWire", () => {
  it("round-trips a receipt back to its DTO", () => {
    const source = detail();
    const listShape = { ...source };
    delete (listShape as Partial<ReceiptDetailDTO>).lineItems;

    expect(fromReceiptWire(toReceiptWire(source))).toEqual(listShape);
  });

  it("preserves the null / zero distinction on points_awarded across the round trip", () => {
    expect(fromReceiptWire(toReceiptWire(detail({ pointsAwarded: null }))).pointsAwarded).toBeNull();
    expect(fromReceiptWire(toReceiptWire(detail({ pointsAwarded: 0 }))).pointsAwarded).toBe(0);
  });

  it("round-trips a rejection reason", () => {
    const source = detail({ status: "rejected", rejectReason: "too_old", pointsAwarded: null });
    const back = fromReceiptWire(toReceiptWire(source));

    expect(back.status).toBe("rejected");
    expect(back.rejectReason).toBe("too_old");
  });
});
