import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CardDetailPage from "./page";

const getLoyaltyCard = vi.fn();

vi.mock("@/features/loyalty/server/repo", () => ({
  getLoyaltyCard: (...args: unknown[]) => getLoyaltyCard(...args),
}));

const stampCard = {
  id: "card-1",
  businessId: "biz-1",
  businessName: "Boba Haven",
  programId: "prog-1",
  programType: "visit_count",
  stampsCount: 5,
  stampsTarget: 10,
  prizeRewardName: "Free Boba Milk Tea",
  completedCount: 0,
  isCompleted: false,
  lastStampAt: "2026-09-10T16:00:00.000Z",
  stampIcon: null,
};

describe("CardDetailPage", () => {
  beforeEach(() => {
    getLoyaltyCard.mockReset();
  });

  it("renders a stamp grid with one slot per target stamp", async () => {
    getLoyaltyCard.mockResolvedValue(stampCard);

    render(await CardDetailPage({ params: Promise.resolve({ cardId: "card-1" }) }));

    expect(screen.getByText("Boba Haven")).toBeDefined();
    expect(screen.getByText("5 / 10 stamps collected")).toBeDefined();
    expect(screen.getByText("Free Boba Milk Tea")).toBeDefined();
    expect(screen.getAllByTestId("stamp-slot")).toHaveLength(10);
  });

  it("uses the program's own stamp icon for a collected slot", async () => {
    getLoyaltyCard.mockResolvedValue({ ...stampCard, stampIcon: "local_cafe" });

    render(await CardDetailPage({ params: Promise.resolve({ cardId: "card-1" }) }));

    const filled = screen
      .getAllByTestId("stamp-slot")
      .filter((slot) => slot.textContent === "local_cafe");
    expect(filled).toHaveLength(5);
  });

  it("does NOT draw one slot per unit for a points program", async () => {
    // 500 stamp circles is not a stamp card. A points_target program gets a
    // progress readout instead - the 0012 schema is what makes the program
    // type knowable at all.
    getLoyaltyCard.mockResolvedValue({
      ...stampCard,
      programType: "points_target",
      stampsCount: 320,
      stampsTarget: 500,
    });

    render(await CardDetailPage({ params: Promise.resolve({ cardId: "card-1" }) }));

    expect(screen.queryAllByTestId("stamp-slot")).toHaveLength(0);
    expect(screen.getByText("320 / 500 points collected")).toBeDefined();
  });

  it("says the prize is ready once progress has reached the target", async () => {
    getLoyaltyCard.mockResolvedValue({
      ...stampCard,
      stampsCount: 10,
      isCompleted: true,
      completedCount: 1,
    });

    render(await CardDetailPage({ params: Promise.resolve({ cardId: "card-1" }) }));

    expect(screen.getByText(/prize is ready/i)).toBeDefined();
  });
});
