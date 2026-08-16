import { describe, expect, it, vi } from "vitest";
import { getLoyaltyCard, listMyLoyaltyCards } from "./repo";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

// One cast, in one place: `createClient` is a vi.fn() here, and typing it as
// its real signature would mean building a whole SupabaseClient per test.
const mockClient = (client: unknown) =>
  (createClient as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(client);

// The shape PostgREST returns for the 0012 schema: the card's own columns
// plus the two embeds that carry everything the 0066 columns used to
// duplicate in denormalized form (target, prize name, card art).
function rowFor(overrides: Record<string, unknown> = {}) {
  return {
    id: "card-1",
    business_id: "biz-1",
    program_id: "prog-1",
    progress: 3,
    completed_count: 0,
    last_stamp_at: "2026-09-10T16:00:00.000Z",
    businesses: { name: "Boba Shop" },
    loyalty_programs: {
      program_type: "visit_count",
      target_value: 10,
      stamp_icon: "local_cafe",
      resets_on_completion: true,
      rewards: { name: "Free Boba" },
    },
    ...overrides,
  };
}

describe("Loyalty Server Repo", () => {
  it("listMyLoyaltyCards reads the doc 35 columns and joins the program for target and prize", async () => {
    const eq = vi.fn().mockResolvedValue({ data: [rowFor()], error: null });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from,
    });

    const cards = await listMyLoyaltyCards();

    expect(cards).toHaveLength(1);
    expect(cards[0]!.businessName).toBe("Boba Shop");
    // progress, not the dropped stamps_count
    expect(cards[0]!.stampsCount).toBe(3);
    // loyalty_programs.target_value, not the dropped stamps_target default of 10
    expect(cards[0]!.stampsTarget).toBe(10);
    // rewards.name, not the dropped free-text prize_reward_name
    expect(cards[0]!.prizeRewardName).toBe("Free Boba");
    expect(cards[0]!.programType).toBe("visit_count");
    expect(cards[0]!.stampIcon).toBe("local_cafe");
    expect(cards[0]!.completedCount).toBe(0);
  });

  it("listMyLoyaltyCards scopes the read to the caller's consumer_id", async () => {
    const eq = vi.fn().mockResolvedValue({ data: [], error: null });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from,
    });

    await listMyLoyaltyCards();

    // 0066's `user_id` is gone with the column; the surviving identity column
    // is `consumer_id`, and this is the only filter in the chain.
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith("consumer_id", "u-1");
  });

  it("marks a card completed when progress has reached the program target", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [
        rowFor({
          progress: 10,
          completed_count: 1,
          loyalty_programs: {
            program_type: "visit_count",
            target_value: 10,
            stamp_icon: null,
            resets_on_completion: false,
            rewards: { name: "Free Boba" },
          },
        }),
      ],
      error: null,
    });
    const select = vi.fn().mockReturnValue({ eq });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({ select }),
    });

    const cards = await listMyLoyaltyCards();
    expect(cards[0]!.isCompleted).toBe(true);
  });

  it("a card one stamp short of the target is not completed", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [rowFor({ progress: 9 })],
      error: null,
    });
    const select = vi.fn().mockReturnValue({ eq });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({ select }),
    });

    const cards = await listMyLoyaltyCards();
    expect(cards[0]!.isCompleted).toBe(false);
  });

  it("getLoyaltyCard pins BOTH the card id and the caller's consumer_id", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: rowFor(), error: null });
    const eqConsumer = vi.fn().mockReturnValue({ maybeSingle });
    const eqId = vi.fn().mockReturnValue({ eq: eqConsumer });
    const select = vi.fn().mockReturnValue({ eq: eqId });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({ select }),
    });

    const card = await getLoyaltyCard("card-1");

    expect(eqId).toHaveBeenCalledWith("id", "card-1");
    expect(eqConsumer).toHaveBeenCalledWith("consumer_id", "u-1");
    expect(card!.stampsTarget).toBe(10);
    expect(card!.prizeRewardName).toBe("Free Boba");
  });

  it("returns nothing when there is no signed-in user", async () => {
    const from = vi.fn();
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
      from,
    });

    expect(await listMyLoyaltyCards()).toEqual([]);
    expect(await getLoyaltyCard("card-1")).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
});
