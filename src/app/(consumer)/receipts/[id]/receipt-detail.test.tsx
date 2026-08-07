import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ReceiptDetailPage from "./page";

vi.mock("@/features/identity/server/repo", () => ({
  getMyConsumerProfile: vi.fn().mockResolvedValue({ id: "user-1", displayName: "Alex" }),
}));

vi.mock("@/features/receipts/server/repo", () => ({
  getMyReceipt: vi.fn().mockResolvedValue({
    receiptId: "rec-1",
    businessId: "biz-1",
    businessName: "Cafe Barista",
    status: "approved",
    rejectReason: null,
    merchantName: "Cafe Barista",
    receiptNumber: "REC-999",
    receiptDate: "2026-08-05",
    totalCentavos: 45000,
    createdAt: "2026-08-05T12:00:00Z",
    processedAt: "2026-08-05T12:01:00Z",
    pointsAwarded: 450,
    lineItems: [
      {
        id: "item-1",
        rawText: "Cold Brew Coffee",
        qty: 2,
        unitPriceCentavos: 15000,
        lineTotalCentavos: 30000,
        sort: 0,
      },
    ],
  }),
}));

describe("ReceiptDetailPage", () => {
  it("renders receipt details and line items", async () => {
    const page = await ReceiptDetailPage({
      params: Promise.resolve({ id: "rec-1" }),
    });

    render(page);

    expect(screen.getByText("Receipt Details")).toBeDefined();
    expect(screen.getByText("Cafe Barista")).toBeDefined();
    expect(screen.getByText("+450 pts")).toBeDefined();
    expect(screen.getByText("Cold Brew Coffee")).toBeDefined();
  });
});
