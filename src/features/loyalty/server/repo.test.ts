import { describe, expect, it, vi } from "vitest";
import { getLoyaltyCard, listMyLoyaltyCards } from "./repo";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("Loyalty Server Repo", () => {
  it("listMyLoyaltyCards returns list of cards for logged-in user", async () => {
    const mockSupabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [
          {
            id: "card-1",
            business_id: "biz-1",
            stamps_count: 3,
            stamps_target: 10,
            prize_reward_name: "Free Coffee",
            is_completed: false,
            completed_at: null,
            businesses: { name: "Boba Shop" },
          },
        ],
        error: null,
      }),
    };

    (createClient as any).mockResolvedValue(mockSupabase);

    const cards = await listMyLoyaltyCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.businessName).toBe("Boba Shop");
    expect(cards[0]!.stampsCount).toBe(3);
  });
});
