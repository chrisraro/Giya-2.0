import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import QrHubPage from "./page";

vi.mock("@/features/businesses/server/portal-context", () => ({
  resolvePortalContext: vi.fn().mockResolvedValue({
    business: { id: "biz-1", name: "Star Cafe", slug: "star-cafe" },
    role: "owner",
  }),
}));

describe("QrHubPage", () => {
  it("renders merchant QR code hub", async () => {
    const page = await QrHubPage();
    render(page);

    expect(screen.getByText("QR Code Hub")).toBeDefined();
    expect(screen.getByText("Storefront QR Code")).toBeDefined();
  });
});
