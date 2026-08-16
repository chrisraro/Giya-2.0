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
    progress: 3,
    completed_count: 0,
    businesses: { name: "Boba Shop" },
    loyalty_programs: {
      program_type: "visit_count",
      target_value: 10,
      stamp_icon: "local_cafe",
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

  it("actually asks PostgREST for the program embed", async () => {
    // The mock answers whatever the select string says, so every assertion
    // above passes with the `loyalty_programs ( ... )` block DELETED from
    // CARD_SELECT - the fixture would still supply it. Only the request text
    // pins that the join is really being asked for.
    const eq = vi.fn().mockResolvedValue({ data: [rowFor()], error: null });
    const select = vi.fn().mockReturnValue({ eq });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({ select }),
    });

    await listMyLoyaltyCards();

    const requested = select.mock.calls[0]![0] as string;
    expect(requested).toContain("loyalty_programs (");
    expect(requested).toContain("rewards (");
    expect(requested).toContain("businesses (");
    expect(requested).toContain("target_value");
    expect(requested).toContain("program_type");
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

  // -------------------------------------------------------------------
  // Failing loud. `[]` renders as "No stamp cards yet. Scan receipts at
  // participating shops to start collecting stamps." - a consumer whose read
  // FAILED would be told, in copy, that they have no cards. This module now
  // takes the same posture `src/features/rewards/server/repo.ts` already
  // settled on for the identical defect class on the same money path.
  // -------------------------------------------------------------------

  it("throws when the card query fails instead of reporting an empty wallet", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "connection reset by peer" },
    });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) }),
    });

    await expect(listMyLoyaltyCards()).rejects.toThrow(/connection reset by peer/);
  });

  it("throws even when the failed query also handed back a row array", async () => {
    // PostgREST can return a non-null `data` alongside an error; keying the
    // refusal on `error` and not on `!data` is the property.
    const eq = vi.fn().mockResolvedValue({
      data: [],
      error: { message: "statement timeout" },
    });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) }),
    });

    await expect(listMyLoyaltyCards()).rejects.toThrow(/statement timeout/);
  });

  it("still returns an empty list when the consumer genuinely holds no cards", async () => {
    // The other half of the split: no cards is a real, common state and must
    // NOT throw, or the refusal above would just be "this function always
    // throws".
    const eq = vi.fn().mockResolvedValue({ data: [], error: null });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) }),
    });

    await expect(listMyLoyaltyCards()).resolves.toEqual([]);
  });

  it("getLoyaltyCard throws on a query failure but returns null for a genuine miss", async () => {
    const failing = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "connection reset by peer" },
    });
    const chain = (maybeSingle: unknown) => ({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) }),
        }),
      }),
    });

    mockClient(chain(failing));
    await expect(getLoyaltyCard("card-1")).rejects.toThrow(/connection reset by peer/);

    mockClient(chain(vi.fn().mockResolvedValue({ data: null, error: null })));
    await expect(getLoyaltyCard("card-1")).resolves.toBeNull();
  });

  // -------------------------------------------------------------------
  // The paused-campaign path. `loyalty_programs_cardholder_select` (0078) is
  // what normally keeps the embed populated after a merchant pauses the
  // campaign; if it is ever dropped or a program is soft-deleted, the embed
  // comes back null and there is no target to render against.
  // -------------------------------------------------------------------

  it("drops a card whose program embed came back empty rather than rendering a broken one", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [rowFor({ id: "card-visible" }), rowFor({ id: "card-orphan", loyalty_programs: null })],
      error: null,
    });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq }) }),
    });

    const cards = await listMyLoyaltyCards();

    // The orphan is gone AND the healthy sibling in the same response
    // survived - without the second half, "length 1" is equally satisfied by
    // a filter that dropped everything.
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe("card-visible");
  });

  it("getLoyaltyCard returns null when the program embed came back empty", async () => {
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: rowFor({ loyalty_programs: null }), error: null });
    mockClient({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } } }) },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) }),
        }),
      }),
    });

    await expect(getLoyaltyCard("card-1")).resolves.toBeNull();
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
