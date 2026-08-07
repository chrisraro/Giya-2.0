import { describe, expect, it, vi } from "vitest";
import { getVectorRecommendations } from "./recommendations";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("Vector Recommendation Engine v2", () => {
  it("fetches vector embedding-based recommendations for consumer discovery", async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            id: "biz-1",
            slug: "boba-haven",
            name: "Boba Haven",
            logo_url: null,
            city_id: "city-1",
            business_type_id: "type-1",
          },
        ],
        error: null,
      }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const recs = await getVectorRecommendations("user-1", "Matcha Milk Tea");
    expect(recs).toHaveLength(1);
    expect(recs[0]?.name).toBe("Boba Haven");
  });
});
