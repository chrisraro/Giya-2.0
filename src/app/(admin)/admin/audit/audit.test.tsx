import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminAuditPage from "./page";

vi.mock("@/features/admin/access", () => ({
  resolveAdminContext: vi.fn().mockResolvedValue({ userId: "admin-1", displayName: "Admin", role: "super_admin" }),
}));

describe("AdminAuditPage", () => {
  it("renders audit log viewer", async () => {
    const page = await AdminAuditPage();
    render(page);

    expect(screen.getByText("System Audit Logs")).toBeDefined();
  });
});
