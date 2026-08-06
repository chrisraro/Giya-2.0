import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BalanceDTO, ClaimableRewardDTO } from "@/features/rewards/types";

// Doc 03's Key Finding 3: `/rewards` used to never read a balance, so an
// unaffordable reward rendered identically to an affordable one and failed
// on tap. These tests hold the fix: the page groups the catalogue by
// business, joins each group to that business's own balance, and renders the
// greyed/shortfall/progress treatment - or nothing extra at all when no
// balance context can be wired up.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  listClaimableRewards: vi.fn(),
  listMyClaims: vi.fn(),
  getMyBalances: vi.fn(),
  claimReward: vi.fn(),
}));

vi.mock("@/features/rewards/server/repo", () => ({
  listClaimableRewards: mocks.listClaimableRewards,
  listMyClaims: mocks.listMyClaims,
  getMyBalances: mocks.getMyBalances,
}));

// RewardCard imports claimReward directly (a "use server" action); stub it so
// this file is purely about server-side wiring, not the claim flow itself
// (already covered by reward-card.test.tsx).
vi.mock("@/features/rewards/actions", () => ({
  claimReward: mocks.claimReward,
}));

const RewardsPage = (await import("./page")).default;

function reward(overrides: Partial<ClaimableRewardDTO> = {}): ClaimableRewardDTO {
  return {
    rewardId: "r1",
    campaignId: "c1",
    name: "Free latte",
    description: null,
    pointsCost: 500,
    remaining: null,
    perCustomerLimit: 1,
    businessId: "biz-1",
    businessName: "Kape Diaria",
    businessSlug: "kape-diaria",
    ...overrides,
  };
}

function balance(overrides: Partial<BalanceDTO> = {}): BalanceDTO {
  return {
    businessId: "biz-1",
    businessName: "Kape Diaria",
    businessSlug: "kape-diaria",
    pointsBalance: 1000,
    lifetimePoints: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMyClaims.mockResolvedValue([]);
});

describe("RewardsPage affordability wiring", () => {
  it("greys an unaffordable reward and states its shortfall using the caller's real balance", async () => {
    mocks.listClaimableRewards.mockResolvedValue([reward({ pointsCost: 1500 })]);
    mocks.getMyBalances.mockResolvedValue([balance({ pointsBalance: 278 })]);

    render(await RewardsPage());

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface-variant");
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName.toLowerCase() === "p" && element.textContent === "1,222 points to go",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).toBeDisabled();
  });

  it("renders an affordable reward with no shortfall and a tappable Claim button", async () => {
    mocks.listClaimableRewards.mockResolvedValue([reward({ pointsCost: 500 })]);
    mocks.getMyBalances.mockResolvedValue([balance({ pointsBalance: 1000 })]);

    render(await RewardsPage());

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).not.toBeDisabled();
  });

  it("shows a business the caller has never earned at as plain catalogue - no grey, no shortfall, no progress", async () => {
    // Product call from the task-5 review: listClaimableRewards() is the
    // WHOLE public catalogue, so without this a brand-new consumer with zero
    // business_customers rows would see every business on the platform
    // rendered as an unaffordable wall of grey. There is no balance row here
    // at all (not even a 0 one), so this business gets no affordability
    // treatment whatsoever - the same as before this task existed.
    mocks.listClaimableRewards.mockResolvedValue([reward({ businessId: "biz-2", pointsCost: 500 })]);
    mocks.getMyBalances.mockResolvedValue([]);

    render(await RewardsPage());

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).not.toBeDisabled();
  });

  it("still greys a reward at a business where the caller's real balance is exactly 0 (spent it all, not never visited)", async () => {
    mocks.listClaimableRewards.mockResolvedValue([reward({ pointsCost: 500 })]);
    mocks.getMyBalances.mockResolvedValue([balance({ pointsBalance: 0 })]);

    render(await RewardsPage());

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface-variant");
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName.toLowerCase() === "p" && element.textContent === "500 points to go",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).toBeDisabled();
  });

  it("omits the business heading rather than rendering an empty one when the business name did not resolve", async () => {
    mocks.listClaimableRewards.mockResolvedValue([reward({ businessName: "" })]);
    mocks.getMyBalances.mockResolvedValue([balance({ pointsBalance: 1000 })]);

    render(await RewardsPage());

    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it("anchors the progress indicator to the cheapest unaffordable reward at that business, not the maximum", async () => {
    mocks.listClaimableRewards.mockResolvedValue([
      reward({ rewardId: "expensive", name: "Combo meal", pointsCost: 6000 }),
      reward({ rewardId: "cheap", name: "Iced tea", pointsCost: 900 }),
    ]);
    mocks.getMyBalances.mockResolvedValue([balance({ pointsBalance: 850 })]);

    render(await RewardsPage());

    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName.toLowerCase() === "p" && element.textContent === "850 / 900 pts to Iced tea",
      ),
    ).toBeInTheDocument();
  });

  it("skips the progress indicator when everything at a business is already affordable", async () => {
    mocks.listClaimableRewards.mockResolvedValue([reward({ pointsCost: 300 })]);
    mocks.getMyBalances.mockResolvedValue([balance({ pointsBalance: 5000 })]);

    render(await RewardsPage());

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("renders the empty state, not a crash, when there are no rewards at all", async () => {
    mocks.listClaimableRewards.mockResolvedValue([]);
    mocks.getMyBalances.mockResolvedValue([]);

    render(await RewardsPage());

    expect(screen.getByText("No rewards yet")).toBeInTheDocument();
  });

  it("degrades to the plain catalogue and logs, rather than crashing the page, when getMyBalances fails", async () => {
    // Coordinator follow-up: getMyBalances() now THROWS on a real query error
    // (post-I1, [] means "no affordability treatment" too, so failing open
    // would silently recreate tap-then-POINTS_INSUFFICIENT). Fail-soft at the
    // call site, never fabricate a shortfall from a failed read.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listClaimableRewards.mockResolvedValue([reward({ pointsCost: 1500 })]);
    mocks.getMyBalances.mockRejectedValue(new Error("connection reset"));

    render(await RewardsPage());

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).not.toBeDisabled();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
