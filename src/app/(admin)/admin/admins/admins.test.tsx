import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminAdminsPage from "./page";

vi.mock("@/features/admin/access", () => ({
  resolveAdminContext: vi.fn().mockResolvedValue({ userId: "admin-1", displayName: "Admin", role: "super_admin" }),
}));

describe("AdminAdminsPage", () => {
  it("renders admin user management dashboard", async () => {
    const page = await AdminAdminsPage();
    render(page);

    expect(screen.getByText("Platform Admin Roster")).toBeDefined();
    expect(screen.getByText("LAST_SUPER_ADMIN Protected")).toBeDefined();
  });
});
