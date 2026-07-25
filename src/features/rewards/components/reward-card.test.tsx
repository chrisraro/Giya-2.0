import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ClaimableRewardDTO } from "../types";

// claimReward is a "use server" action; RewardCard imports and calls it
// directly (per the task-5 brief: "a small client component calling the
// claimReward action"). Mocking the module lets this test drive the
// component's pending/error/success states without a real Supabase/RPC call.
const mocks = vi.hoisted(() => ({
  claimReward: vi.fn(),
}));

vi.mock("../actions", () => ({
  claimReward: mocks.claimReward,
}));

const { RewardCard } = await import("./reward-card");

function baseReward(overrides: Partial<ClaimableRewardDTO> = {}): ClaimableRewardDTO {
  return {
    rewardId: "reward-1",
    campaignId: "campaign-1",
    name: "Free latte",
    description: null,
    pointsCost: 500,
    remaining: 3,
    perCustomerLimit: 1,
    businessId: "biz-1",
    businessName: "Kape Diaria",
    businessSlug: "kape-diaria",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RewardCard", () => {
  it("renders name, business, points cost, and a remaining-stock hint", () => {
    render(<RewardCard reward={baseReward({ remaining: 3 })} />);

    expect(screen.getByText("Free latte")).toBeInTheDocument();
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
    expect(screen.getByText("500 pts")).toBeInTheDocument();
    expect(screen.getByText("3 left")).toBeInTheDocument();
  });

  it("shows the mapped error message inline when claimReward returns ok:false", async () => {
    mocks.claimReward.mockResolvedValue({
      ok: false,
      message: "You do not have enough points for this reward yet.",
      code: "POINTS_INSUFFICIENT",
    });

    render(<RewardCard reward={baseReward()} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));

    expect(
      await screen.findByText("You do not have enough points for this reward yet."),
    ).toBeInTheDocument();
    expect(mocks.claimReward).toHaveBeenCalledWith({ rewardId: "reward-1" });
    // The button must not be stuck disabled/claimed after a failed claim.
    expect(screen.getByRole("button", { name: "Claim" })).not.toBeDisabled();
  });

  it("shows a claimed confirmation and disables the button on success", async () => {
    mocks.claimReward.mockResolvedValue({ ok: true, data: { claimId: "claim-1" } });

    render(<RewardCard reward={baseReward()} />);
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Claimed" })).toBeDisabled());
  });

  it("disables the Claim button and shows 'None left' when remaining is 0", () => {
    render(<RewardCard reward={baseReward({ remaining: 0 })} />);

    expect(screen.getByText("None left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).toBeDisabled();
  });

  it("omits the remaining-stock hint when remaining is null (unlimited)", () => {
    render(<RewardCard reward={baseReward({ remaining: null })} />);

    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });
});
