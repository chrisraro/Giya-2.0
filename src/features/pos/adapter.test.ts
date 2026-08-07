import { describe, expect, it } from "vitest";
import { parsePosPayload } from "./adapter";

describe("POS Payload Adapter", () => {
  it("parses generic POS webhook JSON into standardized receipt payload", () => {
    const rawPos = {
      store_id: "store-99",
      transaction_id: "tx-100200",
      timestamp: "2026-08-07T12:00:00Z",
      grand_total_cents: 45000,
      items: [
        { name: "Iced Latte", qty: 2, price_cents: 15000 },
        { name: "Croissant", qty: 1, price_cents: 15000 },
      ],
    };

    const parsed = parsePosPayload(rawPos);
    expect(parsed.storeId).toBe("store-99");
    expect(parsed.transactionId).toBe("tx-100200");
    expect(parsed.totalCentavos).toBe(45000);
    expect(parsed.items).toHaveLength(2);
  });
});
