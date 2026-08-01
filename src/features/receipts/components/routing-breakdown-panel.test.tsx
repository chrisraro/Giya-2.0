import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { foldRoutingBreakdown } from "../routing-breakdown";
import type { RoutingTally } from "../routing-breakdown";
import { RoutingBreakdownPanel } from "./routing-breakdown-panel";

// D10's panel, which the merchant dashboard and the admin overview both render.
//
// The three states this codebase insists on for any surface carrying a live
// number (see features/admin/screens.test.tsx): real data renders as given,
// empty says what empty MEANS, and unreadable says so explicitly rather than
// showing a zero. A review rate of 0% is the single most reassuring sentence
// this product can say to a merchant, and a dropped connection is not entitled
// to say it.

function status(key: string, tally: number): RoutingTally {
  return { kind: "status", key, tally };
}
function reason(key: string, tally: number): RoutingTally {
  return { kind: "reason", key, tally };
}

const HEALTHY = foldRoutingBreakdown(
  [
    status("approved", 88),
    status("review", 10),
    status("rejected", 2),
    reason("parse_confidence_low", 6),
    reason("merchant_name_mismatch", 4),
  ],
  30,
);

describe("RoutingBreakdownPanel", () => {
  it("renders the three shares of settled receipts", () => {
    render(<RoutingBreakdownPanel breakdown={HEALTHY} scope="your shop" />);

    expect(screen.getByText("88%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
    expect(screen.getByText("2%")).toBeInTheDocument();
  });

  it("names the window and the scope it is talking about", () => {
    render(<RoutingBreakdownPanel breakdown={HEALTHY} scope="the platform" />);

    expect(screen.getByText(/the platform over the last 30 days/i)).toBeInTheDocument();
  });

  it("CRITICAL: says it could not read rather than claiming a perfect 0%", () => {
    render(<RoutingBreakdownPanel breakdown={null} scope="your shop" />);

    expect(screen.getByText(/cannot read right now/i)).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("says nothing has been scanned rather than showing a wall of zeros", () => {
    render(<RoutingBreakdownPanel breakdown={foldRoutingBreakdown([], 30)} scope="your shop" />);

    expect(screen.getByText(/no receipts have been scanned/i)).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("distinguishes an empty queue from an unrecorded one", () => {
    const noReviews = foldRoutingBreakdown([status("approved", 20)], 30);
    render(<RoutingBreakdownPanel breakdown={noReviews} scope="your shop" />);

    expect(screen.getByText(/nothing needed a person/i)).toBeInTheDocument();
  });

  it("lists each rule with its count and its share of the reviewed receipts", () => {
    render(<RoutingBreakdownPanel breakdown={HEALTHY} scope="your shop" />);

    expect(screen.getByText("Could not read the receipt confidently")).toBeInTheDocument();
    expect(screen.getByText("6 (60%)")).toBeInTheDocument();
    expect(screen.getByText("Shop name on the receipt did not match")).toBeInTheDocument();
    expect(screen.getByText("4 (40%)")).toBeInTheDocument();
  });

  it("says out loud that the reasons overlap, so nobody reads them as a pie", () => {
    render(<RoutingBreakdownPanel breakdown={HEALTHY} scope="your shop" />);

    expect(screen.getByText(/can trip more than one rule/i)).toBeInTheDocument();
  });

  it("raises D10's attention line only past a quarter", () => {
    const calm = foldRoutingBreakdown([status("approved", 80), status("review", 20)], 30);
    const { unmount } = render(<RoutingBreakdownPanel breakdown={calm} scope="your shop" />);
    expect(screen.queryByText(/needed a person\. The rules below/i)).not.toBeInTheDocument();
    unmount();

    const busy = foldRoutingBreakdown([status("approved", 60), status("review", 40)], 30);
    render(<RoutingBreakdownPanel breakdown={busy} scope="your shop" />);
    expect(screen.getByText(/of settled receipts needed a person/i)).toBeInTheDocument();
  });

  it("names an operator failure as ours, in front of the merchant", () => {
    // D7's receipts land here. A merchant seeing a pile of them is seeing
    // something true that the old dead-letter path hid from them entirely.
    const ours = foldRoutingBreakdown(
      [status("review", 5), reason("ocr_operator_failure", 5)],
      30,
    );
    render(<RoutingBreakdownPanel breakdown={ours} scope="your shop" />);

    expect(screen.getByText(/we could not process it on our side/i)).toBeInTheDocument();
  });

  it("labels the backfill bucket as history, not as a rule", () => {
    const historic = foldRoutingBreakdown(
      [status("review", 9), reason("unattributed", 9)],
      30,
    );
    render(<RoutingBreakdownPanel breakdown={historic} scope="the platform" />);

    expect(screen.getByText("Scanned before we recorded reasons")).toBeInTheDocument();
  });

  it("carries no em-dash anywhere it renders", () => {
    const { container } = render(
      <RoutingBreakdownPanel breakdown={HEALTHY} scope="your shop" />,
    );

    expect(container.textContent).not.toContain("—");
    expect(container.textContent).not.toContain("–");
  });
});
