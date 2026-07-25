import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/business/dashboard" }));

import { Sidebar } from "./sidebar";
import { KpiCard } from "./kpi-card";
import { BarChart } from "./bar-chart";
import { MOCK_KPIS, MOCK_WEEK_VISITS } from "@/lib/mock/business";

describe("Sidebar", () => {
  it("renders the nav items with accessible names", () => {
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} />);
    for (const label of [
      "Dashboard",
      "Receipts",
      "Campaigns",
      "Menu",
      "Customers",
      "Rewards",
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("badges the Receipts entry with the pending review count", () => {
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} pendingReviewCount={4} />);

    const receipts = screen.getByRole("link", { name: /Receipts/ });
    expect(receipts).toHaveAttribute("href", "/business/receipts");
    // The visible glyph is a bare number; the accessible name says what it counts.
    expect(receipts).toHaveAccessibleName("Receipts4 receipts waiting for review");
  });

  it("caps the badge rather than letting a backlog break the rail", () => {
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} pendingReviewCount={140} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("shows no badge at all when nothing is waiting, which is the steady state", () => {
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} pendingReviewCount={0} />);
    expect(screen.getByRole("link", { name: "Receipts" })).toBeInTheDocument();
    expect(screen.queryByText(/receipts waiting for review/)).not.toBeInTheDocument();
  });

  // Null is "the count could not be read", which the portal layout passes
  // through rather than flattening to 0. No badge is the right rendering: a
  // badge is a number people act on, so a wrong one is worse than none, and
  // the queue screen is the surface that explains the failure.
  it("shows no badge when the pending count could not be read", () => {
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} pendingReviewCount={null} />);
    expect(screen.getByRole("link", { name: "Receipts" })).toBeInTheDocument();
    expect(screen.queryByText(/receipts waiting for review/)).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});

describe("KpiCard", () => {
  it("renders label and value", () => {
    render(<KpiCard kpi={MOCK_KPIS[0]} />);
    expect(screen.getByText("Visits this week")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
  });
});

describe("BarChart", () => {
  it('renders role="img" with an aria-label', () => {
    render(
      <BarChart
        data={MOCK_WEEK_VISITS}
        ariaLabel="Visits per day this week, highest Saturday"
      />,
    );
    expect(
      screen.getByRole("img", { name: "Visits per day this week, highest Saturday" }),
    ).toBeInTheDocument();
  });
});
