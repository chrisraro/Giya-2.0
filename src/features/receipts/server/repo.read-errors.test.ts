// A failed receipts read is an error, not an empty history: the /me/receipts
// route and the consumer page would otherwise show "no receipts yet" during an
// outage and the user would think their scans vanished.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  result: { data: null, error: null } as { data: unknown; error: unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "or", "order", "limit"]) b[m] = () => b;
      b.then = (resolve: (v: unknown) => unknown) => resolve(mocks.result);
      return b;
    },
  })),
}));

const { listMyReceipts } = await import("./repo");

describe("listMyReceipts read failures", () => {
  it("throws when the read errors", async () => {
    mocks.result = { data: null, error: { message: "connection reset" } };
    await expect(listMyReceipts({ userId: "u1", limit: 10, cursor: null })).rejects.toThrow("listMyReceipts");
  });

  it("returns no rows for a genuinely empty history", async () => {
    mocks.result = { data: [], error: null };
    await expect(listMyReceipts({ userId: "u1", limit: 10, cursor: null })).resolves.toMatchObject({ rows: [] });
  });
});
