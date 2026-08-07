import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CardDetailPage from "./page";

vi.mock("@/features/loyalty/server/repo", () => ({
  getLoyaltyCard: vi.fn().mockResolvedValue({
    id: "card-1",
    businessId: "biz-1",
    businessName: "Boba Haven",
    stampsCount: 5,
    stampsTarget: 10,
    prizeRewardName: "Free Boba Milk Tea",
    isCompleted: false,
    completedAt: null,
  }),
}));

describe("CardDetailPage", () => {
  it("renders visual stamp grid and card status", async () => {
    const page = await CardDetailPage({
      params: Promise.resolve({ cardId: "card-1" }),
    });

    render(page);

    expect(screen.getByText("Boba Haven")).toBeDefined();
    expect(screen.getByText("5 / 10 Stamps Collected")).toBeDefined();
    expect(screen.getByText("Free Boba Milk Tea")).toBeDefined();
  });
});
