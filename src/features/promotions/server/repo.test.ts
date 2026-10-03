import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActivePromotionsForBusiness, listPublicPromotions } from "./repo";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

const NOW = new Date("2026-08-10T00:00:00.000Z");

// Chainable, awaitable PostgREST stand-in: every filter returns the builder,
// awaiting it yields the canned result, and calls are recorded for assertions.
function mockQuery(rows: unknown[]) {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "select", "eq", "is", "or", "limit"]) {
    builder[method] = vi.fn((...args: unknown[]) => {
      (calls[method] ??= []).push(args);
      return builder;
    });
  }
  builder.then = (resolve: (value: unknown) => unknown) =>
    resolve({ data: rows, error: null });
  // Wrapped: the builder is thenable, and resolving it directly from the async
  // createClient() would make `await` unwrap it into the canned result.
  (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ from: builder.from });
  return calls;
}

function row(id: string, campaign: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    campaign_id: `camp-${id}`,
    business_id: "biz-1",
    offer_kind: "percent_off",
    percent_off: 15,
    amount_off_centavos: null,
    freebie_text: null,
    terms: null,
    redemption_hint: null,
    deleted_at: null,
    campaigns: {
      name: `Deal ${id}`,
      description: null,
      starts_at: null,
      ends_at: null,
      status: "active",
      deleted_at: null,
      ...campaign,
    },
    businesses: { name: "Shop", slug: "shop" },
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getActivePromotionsForBusiness", () => {
  it("maps a live promotion", async () => {
    mockQuery([
      row("p1", {
        name: "15% Off Summer Deal",
        description: "Get 15% off all drinks",
        starts_at: "2026-08-01T00:00:00Z",
      }),
    ]);

    const result = await getActivePromotionsForBusiness("biz-1");

    expect(result).toEqual([
      {
        id: "p1",
        campaignId: "camp-p1",
        businessId: "biz-1",
        name: "15% Off Summer Deal",
        description: "Get 15% off all drinks",
        offerKind: "percent_off",
        percentOff: 15,
        amountOffCentavos: null,
        freebieText: null,
        terms: null,
        redemptionHint: null,
        startsAt: "2026-08-01T00:00:00Z",
        endsAt: null,
      },
    ]);
  });

  it("excludes scheduled (future starts_at) and expired promotions", async () => {
    mockQuery([
      row("live", {}),
      row("scheduled", { starts_at: "2026-08-10T00:00:01Z" }),
      row("expired", { ends_at: "2026-08-09T00:00:00Z" }),
    ]);

    const result = await getActivePromotionsForBusiness("biz-1");

    expect(result.map((p) => p.id)).toEqual(["live"]);
  });

  it("applies the boundary rule: starts inclusive, ends exclusive", async () => {
    mockQuery([
      row("starts-now", { starts_at: "2026-08-10T00:00:00Z" }),
      row("ends-now", { ends_at: "2026-08-10T00:00:00Z" }),
      row("ends-next-second", { ends_at: "2026-08-10T00:00:01Z" }),
    ]);

    const result = await getActivePromotionsForBusiness("biz-1");

    expect(result.map((p) => p.id)).toEqual(["starts-now", "ends-next-second"]);
  });

  it("excludes a soft-deleted promotion and filters deleted_at in SQL", async () => {
    const calls = mockQuery([
      row("live", {}),
      row("gone", {}, { deleted_at: "2026-08-01T00:00:00Z" }),
    ]);

    const result = await getActivePromotionsForBusiness("biz-1");

    expect(result.map((p) => p.id)).toEqual(["live"]);
    expect(calls.is).toContainEqual(["deleted_at", null]);
  });

  it("returns [] on a query error", async () => {
    (createClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              is: () => ({ is: () => Promise.resolve({ data: null, error: { message: "x" } }) }),
            }),
          }),
        }),
      }),
    });

    expect(await getActivePromotionsForBusiness("biz-1")).toEqual([]);
  });
});

describe("listPublicPromotions", () => {
  it("lists live promotions with business info", async () => {
    mockQuery([row("p1", {})]);

    const result = await listPublicPromotions(5);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "p1", businessName: "Shop", businessSlug: "shop" });
  });

  it("excludes scheduled, expired and soft-deleted promotions", async () => {
    mockQuery([
      row("live", {}),
      row("scheduled", { starts_at: "2026-09-01T00:00:00Z" }),
      row("expired", { ends_at: "2026-08-10T00:00:00Z" }),
      row("gone", {}, { deleted_at: "2026-08-01T00:00:00Z" }),
    ]);

    const result = await listPublicPromotions(10);

    expect(result.map((p) => p.id)).toEqual(["live"]);
  });

  it("pushes the window and the soft-delete filter into SQL so limit counts live rows", async () => {
    const calls = mockQuery([]);

    await listPublicPromotions(5);

    const iso = NOW.toISOString();
    expect(calls.is).toContainEqual(["deleted_at", null]);
    expect(calls.or).toContainEqual([
      `starts_at.is.null,starts_at.lte.${iso}`,
      { referencedTable: "campaigns" },
    ]);
    expect(calls.or).toContainEqual([
      `ends_at.is.null,ends_at.gt.${iso}`,
      { referencedTable: "campaigns" },
    ]);
    expect(calls.limit).toContainEqual([5]);
  });
});
