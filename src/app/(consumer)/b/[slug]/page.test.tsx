import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicBusiness, PublicReward } from "@/features/businesses/server/public-repo";

// Doc 03's Key Finding 3 / task-5 brief bullet 3: `/b/[slug]` gets the same
// affordability treatment as `/rewards` (greyed + shortfall) but ONLY for a
// signed-in viewer with a balance context; a signed-out visitor sees the
// catalogue exactly as before - no shortfall, no grey, and (load-bearing)
// no query for a balance that could never resolve for them.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getBusinessBySlug: vi.fn(),
  getPublicMenu: vi.fn(),
  getPublicRewards: vi.fn(),
  getMyBalanceForBusiness: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));

vi.mock("@/features/businesses/server/public-repo", () => ({
  getBusinessBySlug: mocks.getBusinessBySlug,
  getPublicMenu: mocks.getPublicMenu,
  getPublicRewards: mocks.getPublicRewards,
}));

vi.mock("@/features/rewards/server/repo", () => ({
  getMyBalanceForBusiness: mocks.getMyBalanceForBusiness,
}));

const PublicBusinessPage = (await import("./page")).default;

function business(overrides: Partial<PublicBusiness> = {}): PublicBusiness {
  return {
    id: "biz-1",
    slug: "kape-diaria",
    name: "Kape Diaria",
    description: null,
    logoUrl: null,
    coverUrl: null,
    openingHours: null,
    cityName: null,
    businessTypeName: null,
    addressText: null,
    coordinates: null,
    ...overrides,
  };
}

function reward(overrides: Partial<PublicReward> = {}): PublicReward {
  return {
    id: "r1",
    name: "Free latte",
    description: null,
    pointsCost: 500,
    ...overrides,
  };
}

function params() {
  return Promise.resolve({ slug: "kape-diaria" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBusinessBySlug.mockResolvedValue(business());
  mocks.getPublicMenu.mockResolvedValue([]);
});

describe("public business page affordability", () => {
  it("renders the catalogue unchanged for a signed-out visitor - no shortfall, no grey", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    mocks.getPublicRewards.mockResolvedValue([reward({ pointsCost: 1500 })]);

    render(await PublicBusinessPage({ params: params() }));

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
    // Never queries a balance it could not resolve for a signed-out visitor.
    expect(mocks.getMyBalanceForBusiness).not.toHaveBeenCalled();
  });

  it("greys an unaffordable reward and states the shortfall for a signed-in viewer with a balance", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.getPublicRewards.mockResolvedValue([reward({ pointsCost: 1500 })]);
    mocks.getMyBalanceForBusiness.mockResolvedValue(278);

    render(await PublicBusinessPage({ params: params() }));

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface-variant");
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName.toLowerCase() === "p" && element.textContent === "1,222 points to go",
      ),
    ).toBeInTheDocument();
  });

  it("scopes the balance read to the signed-in viewer's own id, not business_id alone (I1)", async () => {
    // business_customers_staff_select grants owner/manager/marketing staff
    // SELECT over every customer row at their own business - RLS alone does
    // not guarantee this only ever returns the VIEWER's own balance.
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.getPublicRewards.mockResolvedValue([reward({ pointsCost: 500 })]);
    mocks.getMyBalanceForBusiness.mockResolvedValue(1000);

    render(await PublicBusinessPage({ params: params() }));

    expect(mocks.getMyBalanceForBusiness).toHaveBeenCalledWith("biz-1", "user-1");
  });

  it("renders an affordable reward unchanged for a signed-in viewer", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.getPublicRewards.mockResolvedValue([reward({ pointsCost: 500 })]);
    mocks.getMyBalanceForBusiness.mockResolvedValue(1000);

    render(await PublicBusinessPage({ params: params() }));

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
  });

  it("treats a signed-in visitor with no business_customers row yet like the signed-out catalogue - no grey, no shortfall", async () => {
    // Product call (task-5 review): a consumer who has never earned at this
    // business has no balance ROW at all, which is different from a real
    // row holding 0 points (see the next test). Rendering every never-
    // visited business as an unaffordable wall of grey is the exact
    // demotivating pattern doc 03's anchoring rule exists to avoid.
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.getPublicRewards.mockResolvedValue([reward({ pointsCost: 500 })]);
    mocks.getMyBalanceForBusiness.mockResolvedValue(null);

    render(await PublicBusinessPage({ params: params() }));

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("still greys a reward when the viewer has a real balance row worth exactly 0 (spent it all, not never visited)", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.getPublicRewards.mockResolvedValue([reward({ pointsCost: 500 })]);
    mocks.getMyBalanceForBusiness.mockResolvedValue(0);

    render(await PublicBusinessPage({ params: params() }));

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface-variant");
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName.toLowerCase() === "p" && element.textContent === "500 points to go",
      ),
    ).toBeInTheDocument();
  });

  it("mutes the unaffordable badge with the orthodox surface-variant pair", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.getPublicRewards.mockResolvedValue([reward({ pointsCost: 1500 })]);
    mocks.getMyBalanceForBusiness.mockResolvedValue(278);

    render(await PublicBusinessPage({ params: params() }));

    const badge = screen.getByText("1500 pts");
    expect(badge).toHaveClass("bg-surface-variant", "text-on-surface-variant");
    expect(badge).not.toHaveClass("bg-surface-container-high");
  });

  it("boundary: balance exactly equal to cost renders affordable", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.getPublicRewards.mockResolvedValue([reward({ pointsCost: 500 })]);
    mocks.getMyBalanceForBusiness.mockResolvedValue(500);

    render(await PublicBusinessPage({ params: params() }));

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
  });

  it("omits the Rewards section entirely, not an empty one, when there are no rewards", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mocks.getPublicRewards.mockResolvedValue([]);

    render(await PublicBusinessPage({ params: params() }));

    expect(screen.queryByText("Rewards")).not.toBeInTheDocument();
  });
});
