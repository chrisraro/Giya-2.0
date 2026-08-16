import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CardsPage from "./page";

vi.mock("@/features/loyalty/server/repo", () => ({
  listMyLoyaltyCards: vi.fn().mockResolvedValue([
    {
      id: "card-1",
      businessId: "biz-1",
      businessName: "Milk Tea Spot",
      programId: "prog-1",
      programType: "visit_count",
      stampsCount: 7,
      stampsTarget: 10,
      prizeRewardName: "Free Large Milk Tea",
      completedCount: 0,
      isCompleted: false,
      lastStampAt: "2026-09-10T16:00:00.000Z",
      stampIcon: null,
    },
    {
      id: "card-2",
      businessId: "biz-2",
      businessName: "Corner Bakery",
      programId: "prog-2",
      programType: "points_target",
      stampsCount: 320,
      stampsTarget: 500,
      prizeRewardName: "Free Ensaymada",
      completedCount: 2,
      isCompleted: false,
      lastStampAt: null,
      stampIcon: null,
    },
  ]),
}));

describe("CardsPage", () => {
  it("renders a stamp card in stamps and a points card in points", async () => {
    const page = await CardsPage();
    render(page);

    expect(screen.getByText("Loyalty Stamp Cards")).toBeDefined();
    expect(screen.getByText("Milk Tea Spot")).toBeDefined();
    expect(screen.getByText("7 / 10 stamps")).toBeDefined();

    // A points_target program measures progress in points, not stamps: the
    // 0012 schema knows the program type, the 0066 columns never did.
    expect(screen.getByText("Corner Bakery")).toBeDefined();
    expect(screen.getByText("320 / 500 points")).toBeDefined();
  });

  it("tells a returning consumer how many times they have already finished a card", async () => {
    const page = await CardsPage();
    render(page);

    expect(screen.getByText("Completed 2 times")).toBeDefined();
  });
});
