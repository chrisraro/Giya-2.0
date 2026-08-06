import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Doc 30 section 2.8 + review finding I2: a suspended business's staff must
// not be able to reach the review money paths (approveReceiptAction /
// rejectReceiptAction both mint points) by calling them directly, bypassing
// the portal layout's redirect. resolveReviewerContext is the ONE tenancy
// anchor those actions use (its own header: "review/access.ts ... is that
// fence's only anchor"), so the suspension gate lives here.

const mocks = vi.hoisted(() => {
  const state = {
    user: { id: "reviewer-1" } as { id: string } | null,
    membership: { business_id: "biz-1", role: "owner" } as
      | { business_id: string; role: string }
      | null,
    membershipError: null as unknown,
    business: { id: "biz-1", name: "Kape Diaria", status: "active" } as
      | { id: string; name: string; status: string }
      | null,
  };
  return { state, getUser: vi.fn(async () => ({ data: { user: state.user } })) };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from(table: string) {
      if (table === "business_staff") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: mocks.state.membership,
                        error: mocks.state.membershipError,
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "businesses") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: mocks.state.business, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table read: ${table}`);
    },
  })),
}));

const { resolveReviewerContext } = await import("./access");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.user = { id: "reviewer-1" };
  mocks.state.membership = { business_id: "biz-1", role: "owner" };
  mocks.state.membershipError = null;
  mocks.state.business = { id: "biz-1", name: "Kape Diaria", status: "active" };
});

describe("resolveReviewerContext: suspension gate (doc 30 section 2.8)", () => {
  it("CRITICAL: returns null for a suspended business's reviewer", async () => {
    mocks.state.business = { id: "biz-1", name: "Kape Diaria", status: "suspended" };
    await expect(resolveReviewerContext()).resolves.toBeNull();
  });

  it("does not affect an active business's reviewer (the negative case)", async () => {
    mocks.state.business = { id: "biz-1", name: "Kape Diaria", status: "active" };
    const context = await resolveReviewerContext();
    expect(context).not.toBeNull();
    expect(context?.businessId).toBe("biz-1");
  });

  it("does not affect a pending_verification business's reviewer", async () => {
    mocks.state.business = { id: "biz-1", name: "Kape Diaria", status: "pending_verification" };
    const context = await resolveReviewerContext();
    expect(context).not.toBeNull();
  });
});
