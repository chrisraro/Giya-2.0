import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminConsumersPage from "./page";

vi.mock("@/features/admin/access", () => ({
  resolveAdminContext: vi.fn().mockResolvedValue({ userId: "admin-1", displayName: "Admin", role: "super_admin" }),
}));

describe("AdminConsumersPage", () => {
  it("renders consumers moderation dashboard", async () => {
    const page = await AdminConsumersPage();
    render(page);

    expect(screen.getByText("Consumer Management")).toBeDefined();
  });
});
