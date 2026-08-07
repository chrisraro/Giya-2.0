import { describe, expect, it, vi } from "vitest";
import { generateCampaignSuggestions } from "./suggestions";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("AI Campaign Suggestions", () => {
  it("generates draft campaign suggestions with human-in-the-loop rationale", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            business_id: "biz-1",
            date: "2026-08-01",
            total_receipts_count: 50,
            approved_receipts_count: 45,
            total_gmv_centavos: 2500000,
            points_awarded: 25000,
            points_redeemed: 5000,
          },
        ],
        error: null,
      }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const result = await generateCampaignSuggestions("biz-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]?.status).toBe("draft");
      expect(result.suggestions[0]?.rationale).toContain("receipt volume");
    }
  });
});
