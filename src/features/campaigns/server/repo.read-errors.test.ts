// A failed read is an error, not "no such row": callers map null to 404 /
// "not found", so swallowing the error turns an outage into a lie.
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

beforeEach(() => {
  mocks.state.result = { data: null, error: null };
});

describe.each([
  ["getCampaignRow", () => repo.getCampaignRow("b1", "c1")],
  ["getBusinessStatus", () => repo.getBusinessStatus("b1")],
  ["getBaseRule", () => repo.getBaseRule("b1")],
])("%s", (name, call) => {
  it("throws when the read errors", async () => {
    mocks.state.result = FAIL;
    await expect(call()).rejects.toThrow(name);
  });

  it("returns null for a genuine no-row", async () => {
    await expect(call()).resolves.toBeNull();
  });

  it("returns the row when present", async () => {
    mocks.state.result = { data: { id: "x", status: "active" }, error: null };
    await expect(call()).resolves.toMatchObject({ id: "x" });
  });
});
