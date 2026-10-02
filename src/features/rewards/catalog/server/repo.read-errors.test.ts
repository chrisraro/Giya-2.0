// A null from these makes the catalog service answer "not found"; an outage
// must not produce that. (The service's base-rule read is campaigns/server/repo
// getBaseRule, covered in that folder.)
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const repo = await import("./repo");

beforeEach(() => {
  mocks.state.result = { data: null, error: null };
});

describe.each([
  ["getCampaign", () => repo.getCampaign("b1", "c1")],
  ["getReward", () => repo.getReward("b1", "r1")],
])("catalog %s", (name, call) => {
  it("throws when the read errors", async () => {
    mocks.state.result = { data: null, error: { message: "connection reset" } };
    await expect(call()).rejects.toThrow(name);
  });

  it("returns null for a genuine no-row", async () => {
    await expect(call()).resolves.toBeNull();
  });

  it("returns the row when present", async () => {
    mocks.state.result = { data: { id: "x" }, error: null };
    await expect(call()).resolves.toMatchObject({ id: "x" });
  });
});
