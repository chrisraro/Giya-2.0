// @vitest-environment node
//
// task-5 review finding I1: `getMyBalanceForBusiness` selected by business_id
// alone. RLS does not save that - `business_customers_staff_select` (0011:57)
// grants owner/manager/marketing staff SELECT over EVERY customer row at
// their own business, not just their own. Without an explicit consumer_id
// filter, an owner viewing their own `/b/[slug]` with exactly one customer
// row gets THAT CUSTOMER's balance rendered as their own; with several rows,
// `.maybeSingle()` errors. The fix mirrors `public-repo.ts`'s documented
// defense-in-depth convention: RLS is the real gate, but a repo-layer filter
// never trusts it alone.
//
// It also separates "no relationship row" (null - a real, common state for a
// consumer who has never earned at this business) from "the query failed"
// (throws) - conflating them previously meant a transient DB error rendered a
// 5,000-point consumer a confidently wrong "cannot afford anything".
// `getClaim` (repo.ts:152) is the in-repo model for this split.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { getMyBalanceForBusiness } from "./repo";

interface StubResult {
  data: { points_balance: number } | null;
  error: { message: string } | null;
}

function stubSupabase(result: StubResult) {
  const filters: Array<{ column: string; value: unknown }> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push({ column, value });
      return builder;
    }),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
  };
  return { client: { from: vi.fn(() => builder) }, filters };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getMyBalanceForBusiness", () => {
  it("filters by both business_id AND consumer_id - never business_id alone", async () => {
    const { client, filters } = stubSupabase({ data: { points_balance: 500 }, error: null });
    mocks.createClient.mockResolvedValue(client);

    const balance = await getMyBalanceForBusiness("biz-1", "user-1");

    expect(balance).toBe(500);
    expect(filters).toEqual([
      { column: "business_id", value: "biz-1" },
      { column: "consumer_id", value: "user-1" },
    ]);
  });

  it("returns null for a genuine 'never visited this business' row", async () => {
    const { client } = stubSupabase({ data: null, error: null });
    mocks.createClient.mockResolvedValue(client);

    expect(await getMyBalanceForBusiness("biz-1", "user-1")).toBeNull();
  });

  it("throws on a query error rather than answering null (a confident '0 points' would be a lie)", async () => {
    const { client } = stubSupabase({ data: null, error: { message: "connection reset" } });
    mocks.createClient.mockResolvedValue(client);

    await expect(getMyBalanceForBusiness("biz-1", "user-1")).rejects.toThrow(/connection reset/);
  });
});
