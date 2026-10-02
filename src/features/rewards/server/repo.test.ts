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

import { getMyBalances, getMyBalanceForBusiness, listMyClaims, listMyLedger } from "./repo";

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

// ===========================================================================
// getMyBalances - coordinator follow-up on the same review pass. Post-I1,
// `[]` from this function means "no balance rows anywhere" to every caller,
// which now ALSO means "no affordability treatment" (`groupRewardsByBusiness`
// gates on whether a business appears in this list at all). Before that
// meaning existed, failing open on a query error (returning `[]`) merely
// over-greyed - safe, if wrong. After it, failing open renders the WHOLE
// /rewards catalogue plain with every Claim button enabled: a transient DB
// error would silently recreate the exact tap-then-POINTS_INSUFFICIENT defect
// this task exists to remove. So this needs the identical error/no-row split
// `getMyBalanceForBusiness` already got: throw on a genuine query error,
// return `[]` only for the real "no rows" case.
// ===========================================================================

interface BusinessCustomerRow {
  business_id: string;
  points_balance: number;
  lifetime_points: number;
}

function stubBalancesSupabase(result: { data: BusinessCustomerRow[] | null; error: { message: string } | null }) {
  const businessCustomersBuilder = {
    select: vi.fn(() => businessCustomersBuilder),
    eq: vi.fn(() => Promise.resolve(result)),
  };
  const businessesBuilder = {
    select: vi.fn(() => businessesBuilder),
    in: vi.fn(() => Promise.resolve({ data: [] })),
  };
  const from = vi.fn((table: string) => {
    if (table === "business_customers") return businessCustomersBuilder;
    if (table === "businesses") return businessesBuilder;
    throw new Error(`stubBalancesSupabase: unexpected table ${table}`);
  });
  const getUser = vi.fn(() => Promise.resolve({ data: { user: { id: "user-1" } } }));
  return { client: { from, auth: { getUser } } };
}

describe("getMyBalances", () => {
  it("returns [] for a genuine 'no business_customers rows at all' result", async () => {
    const { client } = stubBalancesSupabase({ data: [], error: null });
    mocks.createClient.mockResolvedValue(client);

    expect(await getMyBalances()).toEqual([]);
  });

  it("throws on a query error rather than silently answering [] (which now also means 'no affordability treatment')", async () => {
    const { client } = stubBalancesSupabase({ data: null, error: { message: "connection reset" } });
    mocks.createClient.mockResolvedValue(client);

    await expect(getMyBalances()).rejects.toThrow(/connection reset/);
  });

  it("still returns the real rows on success", async () => {
    const { client } = stubBalancesSupabase({
      data: [{ business_id: "biz-1", points_balance: 500, lifetime_points: 1000 }],
      error: null,
    });
    mocks.createClient.mockResolvedValue(client);

    const balances = await getMyBalances();

    expect(balances).toEqual([
      { businessId: "biz-1", businessName: "", businessSlug: "", pointsBalance: 500, lifetimePoints: 1000 },
    ]);
  });
});

// ===========================================================================
// "My data" reads must be scoped to the signed-in consumer explicitly.
// pt_staff_select, business_customers_staff_select and
// reward_claims_staff_select are PERMISSIVE policies OR-ed with the consumer
// ones, so a business owner who also uses the consumer app would otherwise
// see every customer's ledger rows, balances and claims as their own.
// Same defense-in-depth as getMyBalanceForBusiness above.
// ===========================================================================

type Result = { data: unknown; error: { message: string } | null };

/** Chainable, awaitable query builder that records every filter it receives. */
function stubScoped(userId: string | null, results: Record<string, Result>) {
  const calls: Array<{ table: string; column: string; value: unknown }> = [];
  const from = vi.fn((table: string) => {
    const result = results[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {
      select: vi.fn(() => builder),
      order: vi.fn(() => builder),
      in: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        calls.push({ table, column, value });
        return builder;
      }),
      then: (resolve: (r: Result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return builder;
  });
  const getUser = vi.fn(() => Promise.resolve({ data: { user: userId ? { id: userId } : null } }));
  return { client: { from, auth: { getUser } }, calls, from, getUser };
}

describe("signed-in consumer scoping", () => {
  it("listMyClaims filters reward_claims by consumer_id", async () => {
    const stub = stubScoped("user-1", { reward_claims: { data: [], error: null } });
    mocks.createClient.mockResolvedValue(stub.client);

    await listMyClaims();

    expect(stub.calls).toContainEqual({ table: "reward_claims", column: "consumer_id", value: "user-1" });
  });

  it("listMyClaims returns [] without querying when signed out", async () => {
    const stub = stubScoped(null, {});
    mocks.createClient.mockResolvedValue(stub.client);

    expect(await listMyClaims()).toEqual([]);
    expect(stub.from).not.toHaveBeenCalled();
  });

  it("getMyBalances filters business_customers by consumer_id", async () => {
    const stub = stubScoped("user-1", { business_customers: { data: [], error: null } });
    mocks.createClient.mockResolvedValue(stub.client);

    await getMyBalances();

    expect(stub.calls).toContainEqual({ table: "business_customers", column: "consumer_id", value: "user-1" });
  });

  it("getMyBalances returns [] without querying when signed out", async () => {
    const stub = stubScoped(null, {});
    mocks.createClient.mockResolvedValue(stub.client);

    expect(await getMyBalances()).toEqual([]);
    expect(stub.from).not.toHaveBeenCalled();
  });

  it("listMyLedger filters points_transactions by consumer_id", async () => {
    const stub = stubScoped("user-1", { points_transactions: { data: [], error: null } });
    mocks.createClient.mockResolvedValue(stub.client);

    await listMyLedger();

    expect(stub.calls).toEqual([{ table: "points_transactions", column: "consumer_id", value: "user-1" }]);
  });

  it("listMyLedger keeps the consumer_id filter alongside the business filter", async () => {
    const stub = stubScoped("user-1", { points_transactions: { data: [], error: null } });
    mocks.createClient.mockResolvedValue(stub.client);

    await listMyLedger("biz-1");

    expect(stub.calls).toEqual([
      { table: "points_transactions", column: "consumer_id", value: "user-1" },
      { table: "points_transactions", column: "business_id", value: "biz-1" },
    ]);
  });

  it("listMyLedger returns [] without querying when signed out", async () => {
    const stub = stubScoped(null, {});
    mocks.createClient.mockResolvedValue(stub.client);

    expect(await listMyLedger()).toEqual([]);
    expect(stub.from).not.toHaveBeenCalled();
  });
});
