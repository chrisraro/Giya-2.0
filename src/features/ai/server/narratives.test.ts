import { describe, expect, it, vi } from "vitest";
import { generateTrendNarrative } from "./narratives";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("AI Trend Narrative Generator", () => {
  it("generates natural language performance summary in Taglish/English", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            date: "2026-08-07",
            total_receipts_count: 30,
            approved_receipts_count: 28,
            total_gmv_centavos: 1500000,
            points_awarded: 15000,
          },
          {
            date: "2026-08-06",
            total_receipts_count: 20,
            approved_receipts_count: 18,
            total_gmv_centavos: 1000000,
            points_awarded: 10000,
          },
        ],
        error: null,
      }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const narrative = await generateTrendNarrative("biz-1", "taglish");
    expect(narrative.headline).toBeDefined();
    expect(narrative.summary).toContain("Ang total spend");
  });
});
