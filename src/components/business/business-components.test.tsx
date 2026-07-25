import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/business/dashboard" }));

import { Sidebar } from "./sidebar";
import { KpiCard } from "./kpi-card";
import { BarChart } from "./bar-chart";
import type { DashboardKpi } from "@/features/analytics/types";

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
  const measured: DashboardKpi = {
    label: "Visits, last 7 days",
    value: "12",
    delta: { text: "+20% vs previous 7 days", tone: "trend" },
  };

  const unmeasurable: DashboardKpi = {
    label: "Visits, last 7 days",
    value: "0",
    delta: { text: "No comparison yet", tone: "muted" },
  };

  it("renders label, value and delta", () => {
    render(<KpiCard kpi={measured} />);
    expect(screen.getByText("Visits, last 7 days")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("+20% vs previous 7 days")).toBeInTheDocument();
  });

  // A measured change earns the accent. "No comparison yet" is not a
  // measurement and must not be dressed as one, or the accent stops meaning
  // anything at all.
  it("accents a measured change and keeps an absent one calm", () => {
    const { rerender } = render(<KpiCard kpi={measured} />);
    expect(screen.getByText("+20% vs previous 7 days")).toHaveClass("text-secondary");

    rerender(<KpiCard kpi={unmeasurable} />);
    const calm = screen.getByText("No comparison yet");
    expect(calm).toHaveClass("text-on-surface-variant");
    expect(calm).not.toHaveClass("text-secondary");
  });
});

describe("BarChart", () => {
  it('renders role="img" with an aria-label', () => {
    render(
      <BarChart
        data={[
          { day: "Mon", value: 3 },
          { day: "Tue", value: 7 },
        ]}
        ariaLabel="Visits per day for the last 7 days, highest Tuesday"
      />,
    );
    expect(
      screen.getByRole("img", { name: "Visits per day for the last 7 days, highest Tuesday" }),
    ).toBeInTheDocument();
  });

  // A week of zeros is the correct picture of a merchant's first week. The
  // chart must draw it rather than divide by zero or collapse.
  it("renders a full week of zero bars without breaking", () => {
    render(
      <BarChart
        data={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => ({ day, value: 0 }))}
        ariaLabel="Visits per day for the last 7 days, no visits recorded yet"
      />,
    );
    expect(
      screen.getByRole("img", { name: "Visits per day for the last 7 days, no visits recorded yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Sun")).toBeInTheDocument();
  });
});
