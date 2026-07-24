import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/business/dashboard" }));

import { Sidebar } from "./sidebar";
import { KpiCard } from "./kpi-card";
import { BarChart } from "./bar-chart";
import { MOCK_KPIS, MOCK_WEEK_VISITS } from "@/lib/mock/business";

describe("Sidebar", () => {
  it("renders 6 nav items with accessible names", () => {
    render(<Sidebar mobileOpen={false} onMobileClose={() => {}} />);
    for (const label of [
      "Dashboard",
      "Campaigns",
      "Menu",
      "Customers",
      "Rewards",
      "Settings",
    ]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
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
