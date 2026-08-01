import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE ADMIN SCREENS RENDER REAL DATA OR AN HONEST ABSENCE. NEVER A FIXTURE.
//
// This codebase already paid for the other approach once: the business
// dashboard shipped rendering `MOCK_KPIS` and told a merchant with an empty
// database that they had 128 visits and that "Mia Santos scanned a receipt for
// PHP 180" eighteen minutes ago. The test file guarding that page opens by
// naming the incident. These screens are the platform-wide equivalent, where
// the invented number would be a claim about the whole platform's fraud
// posture, so the same fence goes up here on the way in rather than after.
//
// Three states, three assertions, for both queues and the overview:
//   * REAL DATA renders as given.
//   * EMPTY renders an empty state that says what empty MEANS, never a zero
//     dressed as a statistic.
//   * UNREADABLE renders an explicit alert and suppresses the empty state,
//     because "nothing here" and "we could not look" are different sentences.
// ===========================================================================

import { foldRoutingBreakdown } from "@/features/receipts/routing-breakdown";

import { OverviewScreen } from "./overview-screen";
import { AdminQueueScreen } from "./queue-screen";
import type { AdminQueueItem, PlatformOverview } from "./types";

const NOW = new Date("2026-07-26T12:00:00.000Z");

/**
 * A readable D10 breakdown, so the overview's own assertions are not testing
 * the routing panel by accident. The panel has its own suite; every case below
 * that is not about it passes a breakdown that renders quietly.
 */
const ROUTING = foldRoutingBreakdown(
  [{ kind: "status", key: "approved", tally: 9 }],
  30,
);

function item(overrides: Partial<AdminQueueItem> = {}): AdminQueueItem {
  return {
    receiptId: "receipt-1",
    businessId: "biz-1",
    businessName: "Kape Diaria",
    consumerId: "consumer-1",
    consumerName: "Ana Reyes",
    merchantName: "KAPE DIARIA CEBU",
    receiptNumber: "R-001",
    totalCentavos: 124500,
    createdAt: "2026-07-26T09:00:00.000Z",
    status: "review",
    rejectReason: null,
    topSeverity: "warn",
    signalCount: 2,
    fraudScore: 0.56,
    staffSelfScan: false,
    ...overrides,
  };
}

function overview(overrides: Partial<PlatformOverview> = {}): PlatformOverview {
  return {
    businessesAwaitingVerification: 0,
    receiptsInReview: 0,
    fraudBlocks7d: 0,
    unmatchedReceipts: 0,
    recentBlocks: [],
    ...overrides,
  };
}

describe("AdminQueueScreen", () => {
  it("renders the rows it is given, with the tenant each one belongs to", () => {
    render(
      <AdminQueueScreen
        title="Fraud"
        subtitle="Every flagged receipt"
        kind="fraud"
        filter="open"
        items={[item(), item({ receiptId: "receipt-2", businessName: "Rival Cafe" })]}
        now={NOW}
      />,
    );

    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
    expect(screen.getByText("Rival Cafe")).toBeInTheDocument();
    expect(screen.getAllByText("Ana Reyes")).toHaveLength(2);
  });

  it("names an unmatched receipt as having no business rather than leaving it blank", () => {
    render(
      <AdminQueueScreen
        title="Receipts"
        subtitle=""
        kind="receipts"
        filter="unmatched"
        items={[item({ businessId: null, businessName: null })]}
        now={NOW}
      />,
    );
    expect(screen.getAllByText("No business matched").length).toBeGreaterThan(0);
    expect(screen.getByText("Unmatched")).toBeInTheDocument();
  });

  it("marks a staff self-scan on the row, so doc 37 S9 is visible without opening it", () => {
    render(
      <AdminQueueScreen
        title="Fraud"
        subtitle=""
        kind="fraud"
        filter="open"
        items={[item({ staffSelfScan: true })]}
        now={NOW}
      />,
    );
    expect(screen.getByText("Staff scanned their own")).toBeInTheDocument();
  });

  it("renders an empty state that says what empty MEANS", () => {
    render(
      <AdminQueueScreen title="Fraud" subtitle="" kind="fraud" filter="open" items={[]} now={NOW} />,
    );
    expect(screen.getByText("Nothing is waiting on a person")).toBeInTheDocument();
  });

  it("gives the unmatched filter an empty state that is a warning, not a congratulation", () => {
    // An empty `unmatched` list is the correct steady state, and a non-empty one
    // means merchant matching is letting receipts through it should have
    // rejected. The copy has to carry that.
    render(
      <AdminQueueScreen
        title="Receipts"
        subtitle=""
        kind="receipts"
        filter="unmatched"
        items={[]}
        now={NOW}
      />,
    );
    expect(screen.getByText(/should stay empty/i)).toBeInTheDocument();
  });

  it("suppresses the empty state entirely when the read failed", () => {
    render(
      <AdminQueueScreen
        title="Fraud"
        subtitle=""
        kind="fraud"
        filter="open"
        items={[]}
        now={NOW}
        unavailable
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/cannot be loaded/i);
    // The empty state's copy is a claim about the platform. A failed read must
    // never be allowed to make it.
    expect(screen.queryByText("Nothing is waiting on a person")).toBeNull();
  });

  it("links every row to the cross-tenant decision screen", () => {
    render(
      <AdminQueueScreen title="Fraud" subtitle="" kind="fraud" filter="open" items={[item()]} now={NOW} />,
    );
    expect(screen.getByRole("link", { name: /Kape Diaria/ })).toHaveAttribute(
      "href",
      "/admin/receipts/receipt-1",
    );
  });
});

describe("OverviewScreen", () => {
  it("renders live counts", () => {
    render(
      <OverviewScreen
        overview={overview({
          businessesAwaitingVerification: 3,
          receiptsInReview: 12,
          fraudBlocks7d: 4,
          unmatchedReceipts: 0,
        })}
        adminName="Ops Lead"
        now={NOW}
        routing={ROUTING}
      />,
    );

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("says a tile could not be read rather than showing zero", () => {
    // "0 receipts in review" is a claim that the whole platform is clear, and
    // it is the claim an operator acts on by closing the tab.
    render(
      <OverviewScreen
        overview={overview({ receiptsInReview: null })}
        adminName="Ops Lead"
        now={NOW}
        routing={ROUTING}
      />,
    );
    expect(screen.getAllByText("Cannot read right now").length).toBe(1);
  });

  it("renders the recent blocks it is given", () => {
    render(
      <OverviewScreen
        overview={overview({ fraudBlocks7d: 1, recentBlocks: [item({ topSeverity: "block" })] })}
        adminName="Ops Lead"
        now={NOW}
        routing={ROUTING}
      />,
    );
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
    expect(screen.getByText(/Blocking/)).toBeInTheDocument();
  });

  it("explains an empty block list instead of leaving a bare zero", () => {
    render(
      <OverviewScreen
        overview={overview()}
        adminName="Ops Lead"
        now={NOW}
        routing={ROUTING}
      />,
    );
    expect(screen.getByText("Nothing was blocked recently")).toBeInTheDocument();
  });

  it("carries no invented figure anywhere on an empty platform", () => {
    const { container } = render(
      <OverviewScreen
        overview={overview()}
        adminName="Ops Lead"
        now={NOW}
        routing={ROUTING}
      />,
    );
    // The dashboard fixtures that shipped once in this codebase. None of them
    // may ever appear on a platform-wide surface.
    for (const fixture of ["128", "4,320", "+12% vs last week", "Mia Santos"]) {
      expect(container.textContent).not.toContain(fixture);
    }
  });
});
