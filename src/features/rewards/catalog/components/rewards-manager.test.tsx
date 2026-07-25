import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { RewardsManager } from "./rewards-manager";
import * as actions from "../actions";
import type { CampaignOption, RewardCatalogItem } from "../types";

vi.mock("../actions", () => ({
  createReward: vi.fn(),
  updateReward: vi.fn(),
  setRewardActive: vi.fn(),
}));

const liveCampaign: CampaignOption = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Free Drink Friday",
  type: "reward",
  status: "active",
  startsAt: null,
  endsAt: null,
  claimable: true,
  terminal: false,
};

function reward(overrides: Partial<RewardCatalogItem> = {}): RewardCatalogItem {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    campaignId: liveCampaign.id,
    name: "Free iced coffee",
    description: "Any medium size",
    pointsCost: 100,
    claimKind: "points",
    totalInventory: 50,
    remaining: 40,
    perCustomerLimit: 1,
    claimExpiryDays: 30,
    terms: null,
    isActive: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    campaign: liveCampaign,
    ...overrides,
  };
}

function renderManager(props: Partial<React.ComponentProps<typeof RewardsManager>> = {}) {
  return render(
    <RewardsManager
      businessName="Kape Diaria"
      rewards={[reward()]}
      availableCampaigns={[liveCampaign]}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RewardsManager: the list", () => {
  it("renders each reward with its points price, stock and claim rules", () => {
    renderManager();

    expect(screen.getByText("Free iced coffee")).toBeInTheDocument();
    expect(screen.getByText("100 pts")).toBeInTheDocument();
    expect(screen.getByText("40 of 50 left")).toBeInTheDocument();
    expect(screen.getByText("30 days")).toBeInTheDocument();
    expect(screen.getByText("Free Drink Friday")).toBeInTheDocument();
  });

  it("says 'Free claim' rather than '0 pts' for a zero-cost reward", () => {
    renderManager({ rewards: [reward({ pointsCost: 0 })] });

    expect(screen.getByText("Free claim")).toBeInTheDocument();
  });

  it("marks a reward whose stock ran out", () => {
    renderManager({ rewards: [reward({ remaining: 0 })] });

    expect(screen.getByText("Out of stock")).toBeInTheDocument();
  });

  it("marks unlimited stock rather than showing a count of nothing", () => {
    renderManager({ rewards: [reward({ totalInventory: null, remaining: null })] });

    expect(screen.getByText("Unlimited stock")).toBeInTheDocument();
  });

  it("says when the parent campaign is not live, so a dead reward is visibly dead", () => {
    renderManager({
      rewards: [reward({ campaign: { ...liveCampaign, claimable: false, terminal: true } })],
    });

    expect(screen.getByText("Campaign finished")).toBeInTheDocument();
  });

  it("filters to the rewards that are turned off", () => {
    renderManager({
      rewards: [reward(), reward({ id: "other", name: "Free pastry", isActive: false })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Turned off" }));

    expect(screen.getByText("Free pastry")).toBeInTheDocument();
    expect(screen.queryByText("Free iced coffee")).not.toBeInTheDocument();
  });
});

describe("RewardsManager: the empty state", () => {
  it("invites a first reward when the business already has a live campaign", () => {
    renderManager({ rewards: [] });

    expect(screen.getByText("No rewards yet")).toBeInTheDocument();
    expect(screen.getByText(/spend their points on/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New reward" })).toBeEnabled();
  });

  it("sends the merchant to campaigns first when there is nothing to hang a reward off", () => {
    renderManager({ rewards: [], availableCampaigns: [] });

    expect(screen.getByText("Start a campaign first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New reward" })).toBeDisabled();
  });
});

describe("RewardsManager: the create flow", () => {
  function openAndFill() {
    fireEvent.click(screen.getByRole("button", { name: "New reward" }));
    fireEvent.change(screen.getByLabelText("Reward name"), {
      target: { value: "Free pastry" },
    });
    fireEvent.change(screen.getByLabelText("Points cost"), { target: { value: "250" } });
    fireEvent.change(screen.getByLabelText("Stock"), { target: { value: "20" } });
  }

  it("sends the typed reward to createReward and closes on success", async () => {
    vi.mocked(actions.createReward).mockResolvedValue({ ok: true });
    renderManager({ rewards: [] });

    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Create reward" }));

    await waitFor(() => expect(actions.createReward).toHaveBeenCalledTimes(1));
    expect(actions.createReward).toHaveBeenCalledWith({
      campaignId: liveCampaign.id,
      name: "Free pastry",
      pointsCost: 250,
      totalInventory: 20,
      perCustomerLimit: 1,
      claimExpiryDays: 30,
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Create reward" })).not.toBeInTheDocument(),
    );
  });

  it("treats a blank stock field as unlimited, not as zero", async () => {
    vi.mocked(actions.createReward).mockResolvedValue({ ok: true });
    renderManager({ rewards: [] });

    fireEvent.click(screen.getByRole("button", { name: "New reward" }));
    fireEvent.change(screen.getByLabelText("Reward name"), { target: { value: "Free pastry" } });
    fireEvent.change(screen.getByLabelText("Points cost"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Create reward" }));

    await waitFor(() => expect(actions.createReward).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(actions.createReward).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.totalInventory).toBeNull();
  });

  it("refuses stock of zero before it ever reaches the server", async () => {
    renderManager({ rewards: [] });

    openAndFill();
    fireEvent.change(screen.getByLabelText("Stock"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Create reward" }));

    await screen.findByText(/at least 1, or leave this blank for unlimited/i);
    expect(actions.createReward).not.toHaveBeenCalled();
  });

  it("refuses a per-customer limit of zero before it ever reaches the server", async () => {
    renderManager({ rewards: [] });

    openAndFill();
    fireEvent.change(screen.getByLabelText("Per-customer limit"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Create reward" }));

    await screen.findByText("Enter a whole number, at least 1");
    expect(actions.createReward).not.toHaveBeenCalled();
  });

  it("refuses a claim expiry outside 1-365 days before it ever reaches the server", async () => {
    renderManager({ rewards: [] });

    openAndFill();
    fireEvent.change(screen.getByLabelText("Claim expires after (days)"), {
      target: { value: "400" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create reward" }));

    await screen.findByText("Enter a whole number of days, 1 to 365");
    expect(actions.createReward).not.toHaveBeenCalled();
  });

  it("shows the server's refusal without closing the dialog, so the typing survives", async () => {
    vi.mocked(actions.createReward).mockResolvedValue({
      ok: false,
      message: "Set an earning rule on the Campaigns page first.",
    });
    renderManager({ rewards: [] });

    openAndFill();
    fireEvent.click(screen.getByRole("button", { name: "Create reward" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Set an earning rule on the Campaigns page first.",
    );
    expect(screen.getByRole("button", { name: "Create reward" })).toBeInTheDocument();
  });
});

describe("RewardsManager: the edit flow", () => {
  it("opens prefilled and sends only the reward id plus the edited fields", async () => {
    vi.mocked(actions.updateReward).mockResolvedValue({ ok: true });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Reward name")).toHaveValue("Free iced coffee");
    expect(screen.getByLabelText("Points cost")).toHaveValue("100");

    fireEvent.change(screen.getByLabelText("Points cost"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reward" }));

    await waitFor(() => expect(actions.updateReward).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(actions.updateReward).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.rewardId).toBe(reward().id);
    expect(payload.pointsCost).toBe(150);
    expect(payload).not.toHaveProperty("campaignId");
  });

  it("does not offer to re-parent an existing reward onto another campaign", () => {
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.queryByLabelText("Campaign")).not.toBeInTheDocument();
    expect(screen.getByText(/stays with the campaign it was created under/i)).toBeInTheDocument();
  });

  it("turns a reward off through setRewardActive", async () => {
    vi.mocked(actions.setRewardActive).mockResolvedValue({ ok: true });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

    await waitFor(() =>
      expect(actions.setRewardActive).toHaveBeenCalledWith({
        rewardId: reward().id,
        isActive: false,
      }),
    );
  });

  it("shows a failed toggle on the row rather than swallowing it", async () => {
    vi.mocked(actions.setRewardActive).mockResolvedValue({ ok: false, message: "Nope." });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nope.");
  });
});
