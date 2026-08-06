import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// /business/staff - the rendered-page seam for the roster gate. The security-
// critical refusal (a staff-role member cannot invite) is proven server-side
// in service.test.ts and actions.test.ts; this file proves the PAGE never
// even reaches a render for a caller `resolveStaffContext` already refused -
// a redirect, not a hidden Invite button.

vi.mock("server-only", () => ({}));

class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

const mocks = vi.hoisted(() => ({
  resolveStaffContext: vi.fn(),
  loadRoster: vi.fn(),
}));

vi.mock("@/features/businesses/server/resolve-owner-business", () => ({
  resolveStaffContext: mocks.resolveStaffContext,
  BUSINESS_ROLES: ["owner", "manager", "marketing", "staff"],
}));

vi.mock("@/features/businesses/staff/server/service", () => ({
  loadRoster: mocks.loadRoster,
}));

// <StaffManager> (rendered by the page) imports ../actions, which imports
// @/lib/supabase/server at module load time for acceptInviteAction - unused
// by anything this file exercises, but it still needs a mock so importing the
// module tree does not hit real env validation.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: vi.fn() } })),
}));

const StaffPage = (await import("./page")).default;

const CONTEXT = {
  userId: "owner-1",
  businessId: "biz-1",
  businessName: "Kape Diaria",
  businessSlug: "kape-diaria",
  businessStatus: "active",
  role: "owner" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadRoster.mockResolvedValue({ ok: true, data: [] });
});

describe("a caller the roster gate refuses (e.g. staff/marketing)", () => {
  it("redirects to the dashboard rather than rendering the roster or the Invite button", async () => {
    // Mutant this catches: dropping the `if (context === null) redirect(...)`
    // guard (or inverting it) would render the manager UI, including the
    // Invite control, to a role the matrix excludes entirely.
    mocks.resolveStaffContext.mockResolvedValue(null);

    await expect(StaffPage()).rejects.toThrow("NEXT_REDIRECT:/business/dashboard");
    expect(mocks.loadRoster).not.toHaveBeenCalled();
  });
});

describe("an owner", () => {
  it("renders the roster and the Invite control", async () => {
    mocks.resolveStaffContext.mockResolvedValue(CONTEXT);

    render(await StaffPage());

    expect(screen.getByRole("heading", { name: "Staff" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
  });

  it("asks the roster gate for owner+manager only, never a wider role set", async () => {
    mocks.resolveStaffContext.mockResolvedValue(CONTEXT);

    render(await StaffPage());

    expect(mocks.resolveStaffContext).toHaveBeenCalledWith(["owner", "manager"]);
  });

  it("reports a read failure rather than an empty roster", async () => {
    mocks.resolveStaffContext.mockResolvedValue(CONTEXT);
    mocks.loadRoster.mockResolvedValue({ ok: false, message: "boom" });

    render(await StaffPage());

    expect(screen.getByText(/Could not load your staff/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
  });
});
