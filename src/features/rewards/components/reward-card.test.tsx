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

  // `/b/[slug]` is a real, working public page that nothing in the consumer
  // app linked to. "300 pts for a free latte" raises the question "where, and
  // what else do they have?", and this is the answer.
  it("links the business name to its public page", () => {
    render(<RewardCard reward={baseReward()} />);

    expect(screen.getByRole("link", { name: "Kape Diaria" })).toHaveAttribute(
      "href",
      "/b/kape-diaria",
    );
  });

  it("stays plain text when the slug did not resolve, rather than linking to /b/", () => {
    render(<RewardCard reward={baseReward({ businessSlug: "" })} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Affordability (doc 03 Key Finding 3 / doc 16's binding disabled treatment):
// an unaffordable reward renders greyed, states the numeric shortfall, and its
// Claim button is inert - never tappable-then-erroring with POINTS_INSUFFICIENT.
// ---------------------------------------------------------------------------

describe("RewardCard affordability", () => {
  it("renders an affordable card exactly as before when no affordability prop is passed", () => {
    render(<RewardCard reward={baseReward()} />);

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Claim" })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("renders an affordable card unchanged when affordability says affordable", () => {
    render(
      <RewardCard
        reward={baseReward({ pointsCost: 500 })}
        affordability={{ rewardId: "reward-1", affordable: true, shortfall: 0 }}
      />,
    );

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface");
    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).not.toBeDisabled();
  });

  it("treats balance exactly equal to cost as affordable at the card level (the boundary)", () => {
    render(
      <RewardCard
        reward={baseReward({ pointsCost: 500 })}
        affordability={{ rewardId: "reward-1", affordable: true, shortfall: 0 }}
      />,
    );

    expect(screen.queryByText(/points to go/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim" })).not.toBeDisabled();
  });

  it("greys the card, states the shortfall, and makes the button inert when unaffordable", () => {
    render(
      <RewardCard
        reward={baseReward({ pointsCost: 1500 })}
        affordability={{ rewardId: "reward-1", affordable: false, shortfall: 1222 }}
      />,
    );

    expect(screen.getByText("Free latte")).toHaveClass("text-on-surface-variant");
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName.toLowerCase() === "p" && element.textContent === "1,222 points to go",
      ),
    ).toBeInTheDocument();

    const button = screen.getByRole("button", { name: "Claim" });
    expect(button).toBeDisabled();
  });

  it("never accuses or uses the qualitative refusal copy on an unaffordable card", () => {
    render(
      <RewardCard
        reward={baseReward({ pointsCost: 1500 })}
        affordability={{ rewardId: "reward-1", affordable: false, shortfall: 1222 }}
      />,
    );

    expect(screen.queryByText(/insufficient/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not enough/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/while supplies last/i)).not.toBeInTheDocument();
  });

  it("marks the card aria-disabled when unaffordable so assistive tech does not announce it as tappable", () => {
    const { container } = render(
      <RewardCard
        reward={baseReward({ pointsCost: 1500 })}
        affordability={{ rewardId: "reward-1", affordable: false, shortfall: 1222 }}
      />,
    );

    expect(container.querySelector('[aria-disabled="true"]')).not.toBeNull();
  });

  it("does not tap-then-error: clicking never calls claimReward on an unaffordable card", () => {
    render(
      <RewardCard
        reward={baseReward({ pointsCost: 1500 })}
        affordability={{ rewardId: "reward-1", affordable: false, shortfall: 1222 }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claim" }));

    expect(mocks.claimReward).not.toHaveBeenCalled();
  });
});
