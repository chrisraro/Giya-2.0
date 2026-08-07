import { describe, expect, it, vi } from "vitest";
import { getActivePromotionsForBusiness, listPublicPromotions } from "./repo";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("Promotions Public Repo", () => {
  it("getActivePromotionsForBusiness queries active promotion campaigns for a business", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
    };

    // mock resolve
    (mockSupabase.is as any).mockResolvedValue({
      data: [
        {
          id: "promo-1",
          campaign_id: "camp-1",
          business_id: "biz-1",
          offer_kind: "percent_off",
          percent_off: 15,
          amount_off_centavos: null,
          freebie_text: null,
          terms: "Min spend 500",
          redemption_hint: "Flash QR at counter",
          campaigns: {
            name: "15% Off Summer Deal",
            description: "Get 15% off all drinks",
            starts_at: "2026-08-01T00:00:00Z",
            ends_at: null,
          },
        },
      ],
      error: null,
    });

    (createClient as any).mockResolvedValue(mockSupabase);

    const result = await getActivePromotionsForBusiness("biz-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "promo-1",
      campaignId: "camp-1",
      businessId: "biz-1",
      name: "15% Off Summer Deal",
      description: "Get 15% off all drinks",
      offerKind: "percent_off",
      percentOff: 15,
      amountOffCentavos: null,
      freebieText: null,
      terms: "Min spend 500",
      redemptionHint: "Flash QR at counter",
      startsAt: "2026-08-01T00:00:00Z",
      endsAt: null,
    });
  });

  it("listPublicPromotions lists active promotions with business info", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    };

    (mockSupabase.limit as any).mockResolvedValue({
      data: [],
      error: null,
    });

    (createClient as any).mockResolvedValue(mockSupabase);

    const result = await listPublicPromotions(5);
    expect(result).toEqual([]);
  });
});
