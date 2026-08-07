import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("PayMongo Webhook Route Handler", () => {
  it("handles checkout.session.payment.paid event and updates business plan", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const req = new Request("http://localhost/api/webhooks/paymongo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        data: {
          attributes: {
            type: "checkout_session.payment.paid",
            data: {
              attributes: {
                metadata: {
                  business_id: "biz-1",
                  plan: "growth",
                },
              },
            },
          },
        },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
  });
});
