import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Review fix M8: StaffManager (257 lines - invite dialog, per-row revoke,
// owner-only role change) shipped with no test file at all, despite the
// original report claiming test coverage alongside every module. This file
// closes that gap, modelled on ../../customers/components/customers-manager
// .test.tsx (the closest sibling: Card list + Dialog + per-row actions).

import { StaffManager } from "./staff-manager";
import * as actions from "../actions";
import type { StaffRosterItem } from "../types";

vi.mock("../actions", () => ({
  inviteStaffAction: vi.fn(),
  revokeInviteAction: vi.fn(),
  changeStaffRoleAction: vi.fn(),
}));

function staffRow(overrides: Partial<StaffRosterItem> = {}): StaffRosterItem {
  return {
    id: "staff-row-1",
    role: "staff",
    status: "invited",
    invitedEmail: "kim@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderManager(props: Partial<React.ComponentProps<typeof StaffManager>> = {}) {
  return render(
    <StaffManager
      businessName="Kape Diaria"
      roster={[staffRow()]}
      actorRole="owner"
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StaffManager: the roster", () => {
  it("renders each row's invited email, role and status", () => {
    renderManager();

    expect(screen.getByText("kim@example.com")).toBeInTheDocument();
    // "Staff" also names the page's own <h1>; scope to the role badge.
    expect(screen.getAllByText("Staff")).toHaveLength(2);
    expect(screen.getByText("Invited")).toBeInTheDocument();
  });

  it("shows an empty state when there is only the caller themself", () => {
    renderManager({ roster: [] });

    expect(screen.getByText("Just you, for now")).toBeInTheDocument();
  });

  it("labels an active member Active and a disabled one Removed", () => {
    renderManager({
      roster: [
        staffRow({ id: "a", status: "active", invitedEmail: null }),
        staffRow({ id: "b", status: "disabled" }),
      ],
    });

    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
  });

  it("review fix M10: the Active chip stays in the teal family, not coral primary", () => {
    // docs/10-architecture/16-design-system.md: primary = Giya Coral,
    // reserved for the consumer PWA; the business portal "leads teal"
    // (secondary). A regression back to `bg-primary-container` here would
    // put a consumer-surface colour on a productive business screen.
    renderManager({ roster: [staffRow({ id: "a", status: "active", invitedEmail: null })] });

    const chip = screen.getByText("Active");
    expect(chip.className).not.toMatch(/\bbg-primary\b/);
    expect(chip.className).not.toMatch(/\bbg-primary-container\b/);
    expect(chip.className).toMatch(/\bbg-secondary\b/);
  });
});

describe("StaffManager: who may invite, and into which roles", () => {
  it("an owner sees Invite, offering every non-owner role", () => {
    renderManager({ actorRole: "owner" });

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    expect(screen.getByRole("radio", { name: "Manager" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Marketing" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Staff" })).toBeInTheDocument();
  });

  it("a manager sees Invite too, but ONLY the staff role", () => {
    // Mutant this catches: rendering the owner's full role list for a
    // manager would let them invite a fellow manager or marketing member,
    // exactly the escalation the server-side target-role gate refuses.
    renderManager({ actorRole: "manager" });

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    expect(screen.getByRole("radio", { name: "Staff" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Manager" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Marketing" })).not.toBeInTheDocument();
  });

  it("a plain staff/marketing actor never reaches this component at all in practice, but if it did: no Invite button", () => {
    // rolesInvitableBy("staff") / ("marketing") is [] - documented here as
    // the component-level mirror of the server's canActOnRole refusal,
    // even though the page itself already redirects such a caller before
    // this ever renders (see the /business/staff page test).
    renderManager({ actorRole: "staff" });

    expect(screen.queryByRole("button", { name: "Invite" })).not.toBeInTheDocument();
  });
});

describe("StaffManager: sending an invite", () => {
  it("submits the email and selected role, then closes the dialog", async () => {
    vi.mocked(actions.inviteStaffAction).mockResolvedValue({
      ok: true,
      data: staffRow({ id: "new-1" }),
    });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Manager" }));
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() =>
      expect(actions.inviteStaffAction).toHaveBeenCalledWith({
        email: "new@example.com",
        role: "manager",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument(),
    );
  });

  it("shows the server's refusal instead of closing the dialog", async () => {
    vi.mocked(actions.inviteStaffAction).mockResolvedValue({
      ok: false,
      code: "INVITE_DUPLICATE",
      message: "This person is already a member or already has a pending invite.",
    });
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "existing@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This person is already a member or already has a pending invite.",
    );
  });

  it("cannot submit with no email typed", () => {
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "Invite" }));

    expect(screen.getByRole("button", { name: "Send invite" })).toBeDisabled();
  });
});

describe("StaffManager: revoking a pending invite", () => {
  it("offers Revoke on a pending invite the actor may act on, and calls the action with its id", async () => {
    vi.mocked(actions.revokeInviteAction).mockResolvedValue({ ok: true });
    renderManager({ roster: [staffRow({ id: "row-9", status: "invited" })] });

    fireEvent.click(screen.getByRole("button", { name: "Revoke invite" }));

    await waitFor(() => expect(actions.revokeInviteAction).toHaveBeenCalledWith("row-9"));
  });

  it("does not offer Revoke on an active member", () => {
    renderManager({ roster: [staffRow({ status: "active", invitedEmail: null })] });

    expect(screen.queryByRole("button", { name: "Revoke invite" })).not.toBeInTheDocument();
  });

  it("a manager cannot revoke a manager's pending invite (mirrors the server's target-role gate)", () => {
    renderManager({
      actorRole: "manager",
      roster: [staffRow({ role: "manager", status: "invited" })],
    });

    expect(screen.queryByRole("button", { name: "Revoke invite" })).not.toBeInTheDocument();
  });

  it("a manager CAN revoke a staff invite", () => {
    renderManager({
      actorRole: "manager",
      roster: [staffRow({ role: "staff", status: "invited" })],
    });

    expect(screen.getByRole("button", { name: "Revoke invite" })).toBeInTheDocument();
  });

  it("shows a row-scoped error rather than a page-wide one when revoke fails", async () => {
    vi.mocked(actions.revokeInviteAction).mockResolvedValue({
      ok: false,
      message: "That invite was just accepted or already revoked.",
    });
    renderManager({ roster: [staffRow({ id: "row-9", status: "invited" })] });

    fireEvent.click(screen.getByRole("button", { name: "Revoke invite" }));

    expect(await screen.findByText("That invite was just accepted or already revoked.")).toBeInTheDocument();
  });
});

describe("StaffManager: role change", () => {
  it("an owner sees a role select on an active non-owner member", () => {
    renderManager({
      actorRole: "owner",
      roster: [staffRow({ status: "active", role: "manager", invitedEmail: null })],
    });

    expect(screen.getByLabelText("Role")).toBeInTheDocument();
  });

  it("changing the select calls the action with the row id and new role", async () => {
    vi.mocked(actions.changeStaffRoleAction).mockResolvedValue({
      ok: true,
      data: staffRow({ role: "marketing" }),
    });
    renderManager({
      actorRole: "owner",
      roster: [staffRow({ id: "row-3", status: "active", role: "manager", invitedEmail: null })],
    });

    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "marketing" } });

    await waitFor(() =>
      expect(actions.changeStaffRoleAction).toHaveBeenCalledWith({
        staffId: "row-3",
        role: "marketing",
      }),
    );
  });

  it("a manager never sees the role select at all, on anyone", () => {
    renderManager({
      actorRole: "manager",
      roster: [staffRow({ status: "active", role: "staff", invitedEmail: null })],
    });

    expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
  });

  it("the owner row itself never gets a role select, even for the owner actor", () => {
    renderManager({
      actorRole: "owner",
      roster: [staffRow({ status: "active", role: "owner", invitedEmail: null })],
    });

    expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
  });
});
