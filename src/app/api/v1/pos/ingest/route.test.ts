import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POS Ingest API Endpoint", () => {
  it("processes direct POS transaction webhook ingest", async () => {
    const req = new Request("http://localhost/api/v1/pos/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        store_id: "branch-cebu-01",
        transaction_id: "pos-998811",
        grand_total_cents: 25000,
        items: [{ name: "Matcha Latte", qty: 1, price_cents: 25000 }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.transactionId).toBe("pos-998811");
  });
});
