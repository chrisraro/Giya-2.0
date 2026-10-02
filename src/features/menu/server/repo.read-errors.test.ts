// The existence pre-checks must not turn a failed read into
// "Product not found." / "Category not found.".
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/businesses/server/resolve-owner-business", () => ({ resolveOwnerBusiness: vi.fn() }));

const mocks = vi.hoisted(() => {
  const state: { result: { data: unknown; error: unknown } } = { result: { data: null, error: null } };
  function builder() {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "order", "limit"]) b[m] = vi.fn(() => b);
    b.maybeSingle = vi.fn(async () => state.result);
    return b;
  }
  return { state, from: vi.fn(() => builder()) };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: mocks.from })) }));

const FAIL = { data: null, error: { message: "connection reset", code: "08006" } };

const repo = await import("./repo");

const variant = { name: "Large", priceDeltaCentavos: 0, sortOrder: 0, isAvailable: true } as never;
const product = {
  name: "Latte",
  description: null,
  basePriceCentavos: 100,
  categoryId: "cat-1",
  status: "active",
  isAvailable: true,
} as never;

beforeEach(() => {
  mocks.state.result = { data: null, error: null };
});

describe("productExistsForBusiness (via addVariant)", () => {
  it("throws when the existence read errors", async () => {
    mocks.state.result = FAIL;
    await expect(repo.addVariant("b1", "p1", variant)).rejects.toThrow("menu existence check failed");
  });

  it("still reports a genuinely missing product as not found", async () => {
    await expect(repo.addVariant("b1", "p1", variant)).resolves.toEqual({
      data: null,
      error: { message: "Product not found." },
    });
  });
});

describe("categoryExistsForBusiness (via insertProduct)", () => {
  it("throws when the existence read errors", async () => {
    mocks.state.result = FAIL;
    await expect(repo.insertProduct("b1", product)).rejects.toThrow("menu existence check failed");
  });

  it("still reports a genuinely missing category as not found", async () => {
    await expect(repo.insertProduct("b1", product)).resolves.toEqual({
      data: null,
      error: { message: "Category not found." },
    });
  });
});
