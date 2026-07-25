import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: () => {} }),
}));

import { Topbar } from "./topbar";

// The topbar is the chrome of all eight portal routes. It used to hardcode
// `aria-label="Ramon Dela Cruz"` and the initials "RD", so every staff member
// of every tenant saw, and every screen reader announced, somebody else's name
// as their own account control. These tests are the fence against that
// returning.

const FIXTURE_NAME = "Ramon Dela Cruz";

describe("Topbar identity", () => {
  it("shows the signed-in user's initials and name", () => {
    render(
      <Topbar
        title="Dashboard"
        onMenuClick={() => {}}
        userName="Karla Mendoza"
        userInitials="KM"
        businessName="Kape Diaria"
      />,
    );

    expect(screen.getByRole("img", { name: "Karla Mendoza" })).toHaveTextContent("KM");
  });

  it("shows the real business name", () => {
    render(
      <Topbar
        title="Dashboard"
        onMenuClick={() => {}}
        userName="Karla Mendoza"
        userInitials="KM"
        businessName="Kape Diaria"
      />,
    );

    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
  });

  it("CRITICAL: never renders a name that was not passed in", () => {
    const { container } = render(
      <Topbar
        title="Dashboard"
        onMenuClick={() => {}}
        userName="Karla Mendoza"
        userInitials="KM"
        businessName="Kape Diaria"
      />,
    );

    expect(container.innerHTML).not.toContain(FIXTURE_NAME);
    expect(screen.queryByRole("img", { name: FIXTURE_NAME })).not.toBeInTheDocument();
    expect(screen.queryByText("RD")).not.toBeInTheDocument();
  });

  it("falls back to a neutral account glyph when there is no readable name", () => {
    const { container } = render(<Topbar title="Dashboard" onMenuClick={() => {}} />);

    const avatar = screen.getByRole("img", { name: "Your account" });
    expect(avatar).toBeInTheDocument();
    // A glyph, not a placeholder person's initials.
    expect(avatar).toHaveTextContent("person");
    expect(container.innerHTML).not.toContain(FIXTURE_NAME);
  });

  it("omits the business name entirely when it is unknown", () => {
    render(<Topbar title="Dashboard" onMenuClick={() => {}} userName="Karla Mendoza" userInitials="KM" />);

    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Karla Mendoza" })).toBeInTheDocument();
  });
});
