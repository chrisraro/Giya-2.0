// A failed presence read must throw, not report "nothing attached" (which
// blocks activation with a misleading message).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/businesses/server/resolve-owner-business", () => ({ resolveOwnerBusiness: vi.fn() }));

const mocks = vi.hoisted(() => ({ result: { data: null, error: null } as { data: unknown; error: unknown } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => mocks.result;
      b.then = (resolve: (v: unknown) => unknown) => resolve(mocks.result);
      return b;
    },
  })),
}));

const repo = await import("./repo");

describe("getCampaignPayloadPresence read failures", () => {
  it("throws when a read errors", async () => {
    mocks.result = { data: null, error: { message: "connection reset" } };
    await expect(repo.getCampaignPayloadPresence("b1", "c1")).rejects.toThrow("getCampaignPayloadPresence");
  });

  it("reports nothing attached for genuinely empty reads", async () => {
    mocks.result = { data: null, error: null };
    await expect(repo.getCampaignPayloadPresence("b1", "c1")).resolves.toMatchObject({ hasPromotion: false });
  });
});
