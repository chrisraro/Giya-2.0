// A failed membership read must not look like "no membership": the portal
// layout sends a null resolution to onboarding, so an outage would bounce a
// working owner out of their shop. Throwing still fails closed (nothing is
// granted) and lets error.tsx / guardReadFailure answer honestly.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  membership: { data: null, error: null } as { data: unknown; error: unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => mocks.membership;
      return b;
    },
  })),
}));

const { resolveOwnerBusiness, resolveStaffAccess, resolveStaffContext } = await import(
  "./resolve-owner-business"
);

beforeEach(() => {
  mocks.membership = { data: null, error: null };
});

describe("membership read failures", () => {
  it("resolveOwnerBusiness throws when the membership read errors", async () => {
    mocks.membership = { data: null, error: { message: "connection reset" } };
    await expect(resolveOwnerBusiness()).rejects.toThrow("readMembership");
  });

  it("resolveStaffAccess throws when the membership read errors", async () => {
    mocks.membership = { data: null, error: { message: "connection reset" } };
    await expect(resolveStaffAccess(["owner"])).rejects.toThrow("readMembership");
  });

  it("resolveStaffContext throws when the membership read errors", async () => {
    mocks.membership = { data: null, error: { message: "connection reset" } };
    await expect(resolveStaffContext(["manager"])).rejects.toThrow("readMembership");
  });

  it("still returns null / no_access for a genuine no-membership", async () => {
    await expect(resolveOwnerBusiness()).resolves.toBeNull();
    await expect(resolveStaffAccess(["staff"])).resolves.toEqual({ ok: false, reason: "no_access" });
  });
});
