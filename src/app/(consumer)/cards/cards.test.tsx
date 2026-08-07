import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CardsPage from "./page";

vi.mock("@/features/loyalty/server/repo", () => ({
  listMyLoyaltyCards: vi.fn().mockResolvedValue([
    {
      id: "card-1",
      businessId: "biz-1",
      businessName: "Milk Tea Spot",
      stampsCount: 7,
      stampsTarget: 10,
      prizeRewardName: "Free Large Milk Tea",
      isCompleted: false,
      completedAt: null,
    },
  ]),
}));

describe("CardsPage", () => {
  it("renders list of loyalty stamp cards", async () => {
    const page = await CardsPage();
    render(page);

    expect(screen.getByText("Loyalty Stamp Cards")).toBeDefined();
    expect(screen.getByText("Milk Tea Spot")).toBeDefined();
    expect(screen.getByText("7 / 10 stamps")).toBeDefined();
  });
});
