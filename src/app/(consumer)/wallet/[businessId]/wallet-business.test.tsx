import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import WalletBusinessPage from "./page";

vi.mock("@/features/rewards/server/repo", () => ({
  listMyLedger: vi.fn().mockResolvedValue([
    {
      id: "tx-1",
      businessId: "biz-1",
      type: "earn",
      points: 100,
      balanceAfter: 100,
      createdAt: "2026-08-01T10:00:00Z",
      claimId: null,
      campaignId: null,
    },
  ]),
  getMyBalanceForBusiness: vi.fn().mockResolvedValue(100),
}));

vi.mock("@/features/businesses/server/public-repo", () => ({
  getBusinessBySlug: vi.fn(),
  listActiveBusinesses: vi.fn().mockResolvedValue([
    { id: "biz-1", name: "Cafe Mocha", slug: "cafe-mocha" },
  ]),
}));

describe("WalletBusinessPage", () => {
  it("renders transaction history for a business", async () => {
    const page = await WalletBusinessPage({
      params: Promise.resolve({ businessId: "biz-1" }),
    });

    render(page);

    expect(screen.getByText("Ledger History")).toBeDefined();
    expect(screen.getByText("+100 pts")).toBeDefined();
  });
});
