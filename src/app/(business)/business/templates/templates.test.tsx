import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TemplatesPage from "./page";

vi.mock("@/features/businesses/server/portal-context", () => ({
  resolvePortalContext: vi.fn().mockResolvedValue({
    business: { id: "biz-1", name: "Grand Cafe" },
    role: "owner",
  }),
}));

describe("TemplatesPage", () => {
  it("renders receipt template management dashboard", async () => {
    const page = await TemplatesPage();
    render(page);

    expect(screen.getByText("Receipt Templates")).toBeDefined();
    expect(screen.getByText("Upload Sample Receipt")).toBeDefined();
  });
});
