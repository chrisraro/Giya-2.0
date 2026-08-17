// @vitest-environment node
//
// ===========================================================================
// `/rewards` MUST NOT SHOW AN UNAPPROVED MERCHANT'S REWARDS.
//
// This is the same approval boundary as
// src/features/businesses/server/storefront-visibility.test.ts, on the one
// consumer surface that did not route through a gated read.
//
// The two policies behind this read, verified live 2026-08-17:
//
//   rewards_public_select    -> (is_active = true) AND (deleted_at IS NULL)
//   campaigns_public_select  -> (status = 'active') AND (deleted_at IS NULL)
//
// NEITHER LOOKS AT THE OWNING BUSINESS. And `campaigns_staff_insert` carries no
// activation precondition, so a `draft` business can create an active campaign
// with rewards from the portal G1 deliberately opened to it, and those rewards
// reached `/rewards` - described in reward-groups.ts as "the WHOLE public
// catalogue".
//
// It did not even present as a clean leak. The old implementation resolved shop
// names with a separate `.in("id", businessIds)` read, whose own RLS returned
// nothing for an unapproved business, so the group heading vanished and the
// cards rendered HEADLESS: reward name, description and points cost, no shop.
// Redacted identity, published offer.
//
// The real gate is `businesses!inner`, which makes PostgREST apply
// `businesses_public_select` to the joined row server-side - the construct
// `listPublicPromotions` already uses. A unit test cannot exercise a PostgREST
// join, so this file pins the two halves it CAN reach: the query is built with
// the inner join and the status filter (structural), and a row that arrives
// without an approved business is dropped (behavioural). Together with the
// live policy, that is the whole fence.
// ===========================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { listClaimableRewards } from "./repo";

type Row = Record<string, unknown>;

interface Recorded {
  selects: string[];
  eqs: Array<{ column: string; value: unknown }>;
}

/**
 * Serves `rewards` then `campaigns`, recording what was asked for. Deliberately
 * NOT a filtering double: what is under test is what the repo does with rows
 * PostgREST hands back, plus the shape of the query it sent.
 */
function stubSupabase(rewardRows: Row[], campaignRows: Row[]) {
  const recorded: Recorded = { selects: [], eqs: [] };

  function builder(rows: Row[]) {
    const self: Record<string, unknown> = {
      select: vi.fn((columns: string) => {
        recorded.selects.push(columns);
        return self;
      }),
      eq: vi.fn((column: string, value: unknown) => {
        recorded.eqs.push({ column, value });
        return self;
      }),
      is: vi.fn(() => self),
      in: vi.fn(() => self),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    };
    return self;
  }

  const client = {
    from: vi.fn((table: string) =>
      table === "rewards" ? builder(rewardRows) : builder(campaignRows),
    ),
  };
  return { client, recorded };
}

const LIVE_CAMPAIGN = { id: "camp-1", starts_at: null, ends_at: null };

function reward(overrides: Row = {}): Row {
  return {
    id: "reward-1",
    campaign_id: "camp-1",
    name: "Free Kapeng Barako",
    description: "One free cup",
    points_cost: 100,
    remaining: 50,
    per_customer_limit: 1,
    business_id: "biz-1",
    businesses: { name: "Kape Diaria", slug: "kape-diaria", status: "active" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the query listClaimableRewards actually sends", () => {
  it("CRITICAL: joins businesses with !inner, so RLS drops unapproved rows server-side", async () => {
    const { client, recorded } = stubSupabase([reward()], [LIVE_CAMPAIGN]);
    mocks.createClient.mockResolvedValue(client);

    await listClaimableRewards();

    const rewardsSelect = recorded.selects[0] ?? "";
    // `!inner` and not a plain embed: an outer join returns the reward with a
    // null business rather than omitting it, which is precisely the headless
    // card this leak produced.
    expect(rewardsSelect).toContain("businesses!inner");
  });

  it("CRITICAL: also filters the joined business to active, as defense-in-depth", async () => {
    const { client, recorded } = stubSupabase([reward()], [LIVE_CAMPAIGN]);
    mocks.createClient.mockResolvedValue(client);

    await listClaimableRewards();

    expect(recorded.eqs).toContainEqual({ column: "businesses.status", value: "active" });
  });

  it("still filters the reward's own is_active", async () => {
    const { client, recorded } = stubSupabase([reward()], [LIVE_CAMPAIGN]);
    mocks.createClient.mockResolvedValue(client);

    await listClaimableRewards();

    expect(recorded.eqs).toContainEqual({ column: "is_active", value: true });
  });
});

describe("what it does with the rows that come back", () => {
  it("returns an approved business's live reward (the fence is a fence, not a wall)", async () => {
    const { client } = stubSupabase([reward()], [LIVE_CAMPAIGN]);
    mocks.createClient.mockResolvedValue(client);

    const result = await listClaimableRewards();

    expect(result).toHaveLength(1);
    expect(result[0]?.businessName).toBe("Kape Diaria");
    expect(result[0]?.businessSlug).toBe("kape-diaria");
  });

  for (const status of ["draft", "pending_verification", "suspended", "closed"]) {
    it(`CRITICAL: drops a reward whose business is ${status}`, async () => {
      const { client } = stubSupabase(
        [reward({ businesses: { name: "Not Yet Cafe", slug: "not-yet", status } })],
        [LIVE_CAMPAIGN],
      );
      mocks.createClient.mockResolvedValue(client);

      expect(await listClaimableRewards()).toEqual([]);
    });
  }

  it("CRITICAL: drops a reward that arrives with no business attached at all", async () => {
    // What an outer join returns for an unapproved shop. Rendering it is the
    // headless card: a real offer with its merchant redacted.
    const { client } = stubSupabase([reward({ businesses: null })], [LIVE_CAMPAIGN]);
    mocks.createClient.mockResolvedValue(client);

    expect(await listClaimableRewards()).toEqual([]);
  });

  it("CRITICAL: never renders a reward with an empty business name", async () => {
    // The property behind the two assertions above, stated directly: whatever
    // arrives, nothing ships with a blank shop. This is what the old
    // implementation did on every unapproved row.
    const { client } = stubSupabase(
      [
        reward(),
        reward({ id: "reward-2", businesses: null }),
        reward({ id: "reward-3", businesses: { name: "X", slug: "x", status: "draft" } }),
      ],
      [LIVE_CAMPAIGN],
    );
    mocks.createClient.mockResolvedValue(client);

    const result = await listClaimableRewards();

    expect(result.every((r) => r.businessName !== "")).toBe(true);
    expect(result.map((r) => r.rewardId)).toEqual(["reward-1"]);
  });

  it("still drops a reward whose campaign is outside its schedule window", async () => {
    // The pre-existing app-layer check, kept green: RLS enforces campaign
    // status but not starts_at/ends_at.
    const { client } = stubSupabase(
      [reward()],
      [{ id: "camp-1", starts_at: null, ends_at: "2000-01-01T00:00:00Z" }],
    );
    mocks.createClient.mockResolvedValue(client);

    expect(await listClaimableRewards()).toEqual([]);
  });
});
