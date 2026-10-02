// @vitest-environment node
// listClaimableRewards: a failed read is an error, empty only when genuinely
// empty. Both reads (rewards, campaigns) are covered.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rewards: { data: [], error: null } as { data: unknown; error: unknown },
  campaigns: { data: [], error: null } as { data: unknown; error: unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(table === "rewards" ? mocks.rewards : mocks.campaigns).then(res, rej);
      return b;
    },
  })),
}));

const { listClaimableRewards } = await import("./repo");

beforeEach(() => {
  mocks.rewards = { data: [], error: null };
  mocks.campaigns = { data: [], error: null };
});

describe("listClaimableRewards read failures", () => {
  it("throws when the rewards read errors", async () => {
    mocks.rewards = { data: null, error: { message: "connection reset" } };
    await expect(listClaimableRewards()).rejects.toThrow("rewards read failed");
  });

  it("throws when the campaigns read errors, rather than filtering every reward out", async () => {
    mocks.rewards = {
      data: [{ id: "r1", campaign_id: "c1", business_id: "b1", businesses: { name: "N", slug: "n", status: "active" } }],
      error: null,
    };
    mocks.campaigns = { data: null, error: { message: "connection reset" } };
    await expect(listClaimableRewards()).rejects.toThrow("campaigns read failed");
  });

  it("returns [] when there are genuinely no rewards", async () => {
    await expect(listClaimableRewards()).resolves.toEqual([]);
  });
});
