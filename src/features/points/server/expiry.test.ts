import { beforeEach, describe, expect, it, vi } from "vitest";

// getNextPointsExpiry/getNextPointsExpiryByBusiness are thin wrappers over
// public.points_next_expiry (0043) - the SAME FIFO primitive the sweep uses.
// These tests pin the wrapper's contract (RPC args, row mapping, fail-soft on
// every error path, per-business independence), not the SQL formula itself
// (covered live by supabase/tests/rpc_points_expiry_smoke.sql).

vi.mock("server-only", () => ({}));

const createServiceRoleClient = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));

const { getNextPointsExpiry, getNextPointsExpiryByBusiness } = await import("./expiry");

function fakeClient(rpcImpl: (name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  return { rpc: rpcImpl };
}

beforeEach(() => {
  createServiceRoleClient.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getNextPointsExpiry", () => {
  it("maps points_next_expiry's row into the DTO", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ points: 500, expires_at: "2027-03-03T00:00:00.000Z" }],
      error: null,
    });
    createServiceRoleClient.mockReturnValue(fakeClient(rpc));

    const result = await getNextPointsExpiry("biz-1", "consumer-1");

    expect(result).toEqual({ points: 500, expiresAt: "2027-03-03T00:00:00.000Z" });
    expect(rpc).toHaveBeenCalledWith("points_next_expiry", {
      p_business_id: "biz-1",
      p_consumer_id: "consumer-1",
    });
  });

  it("returns null when the RPC answers no rows (nothing left to expire)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    createServiceRoleClient.mockReturnValue(fakeClient(rpc));

    expect(await getNextPointsExpiry("biz-1", "consumer-1")).toBeNull();
  });

  it("fails soft (null, not throw) when the RPC errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    createServiceRoleClient.mockReturnValue(fakeClient(rpc));

    expect(await getNextPointsExpiry("biz-1", "consumer-1")).toBeNull();
  });

  it("fails soft (null, not throw) with no service-role client", async () => {
    createServiceRoleClient.mockReturnValue(null);

    expect(await getNextPointsExpiry("biz-1", "consumer-1")).toBeNull();
  });
});

describe("getNextPointsExpiryByBusiness", () => {
  it("maps each business independently, omitting ones with nothing to show", async () => {
    const rpc = vi.fn(async (_name: string, args: unknown) => {
      const { p_business_id } = args as { p_business_id: string };
      if (p_business_id === "biz-1") {
        return { data: [{ points: 500, expires_at: "2027-03-03T00:00:00.000Z" }], error: null };
      }
      if (p_business_id === "biz-2") {
        return { data: [], error: null };
      }
      return { data: null, error: { message: "boom" } };
    });
    createServiceRoleClient.mockReturnValue(fakeClient(rpc));

    const result = await getNextPointsExpiryByBusiness("consumer-1", ["biz-1", "biz-2", "biz-3"]);

    expect(result.get("biz-1")).toEqual({ points: 500, expiresAt: "2027-03-03T00:00:00.000Z" });
    expect(result.has("biz-2")).toBe(false);
    expect(result.has("biz-3")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("returns an empty map for an empty business list", async () => {
    const result = await getNextPointsExpiryByBusiness("consumer-1", []);
    expect(result.size).toBe(0);
  });
});
