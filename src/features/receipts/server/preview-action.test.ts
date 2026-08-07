import { describe, expect, it, vi } from "vitest";
import { previewReceiptPointsAction } from "./preview-action";

vi.mock("./repo", () => ({
  listActiveBusinesses: vi.fn(),
}));

describe("previewReceiptPointsAction", () => {
  it("calculates estimated points for an amount in centavos", async () => {
    const res = await previewReceiptPointsAction({
      amountCentavos: 15000,
      businessTimezone: "Asia/Manila",
      baseRateCentavosPerPoint: 100, // 1pt per 1 PHP (100 centavos)
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.points).toBe(150);
    }
  });
});
