// A failed business read must not look like "no membership" (which sends
// owners to onboarding); a genuine miss still returns null.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  membership: { data: { business_id: "b1", role: "owner" }, error: null } as { data: unknown; error: unknown },
  business: { data: null, error: null } as { data: unknown; error: unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => (table === "business_staff" ? mocks.membership : mocks.business);
      return b;
    },
  })),
}));

const { resolveOwnerBusiness } = await import("./resolve-owner-business");

beforeEach(() => {
  mocks.membership = { data: { business_id: "b1", role: "owner" }, error: null };
  mocks.business = { data: null, error: null };
});

describe("resolveOwnerBusiness read failures", () => {
  it("throws when the business read errors", async () => {
    mocks.business = { data: null, error: { message: "connection reset" } };
    await expect(resolveOwnerBusiness()).rejects.toThrow("readBusiness");
  });

  it("returns null when the business row genuinely does not exist", async () => {
    await expect(resolveOwnerBusiness()).resolves.toBeNull();
  });

  it("returns the business when present", async () => {
    mocks.business = { data: { id: "b1", slug: "s", name: "N", status: "active" }, error: null };
    await expect(resolveOwnerBusiness()).resolves.toMatchObject({ id: "b1" });
  });
});
