import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LoyaltyStrip } from "./loyalty-strip";
import { BusinessCard } from "./business-card";
import { EmptyState } from "./empty-state";
import { MOCK_BALANCES, MOCK_BUSINESSES } from "@/lib/mock/consumer";

describe("LoyaltyStrip", () => {
  it('renders "3 of 5" for Kape Diaria', () => {
    render(<LoyaltyStrip balances={MOCK_BALANCES} />);
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
    expect(screen.getByText("3 of 5")).toBeInTheDocument();
  });
});

describe("BusinessCard", () => {
  it("renders name and distance in km", () => {
    render(<BusinessCard business={MOCK_BUSINESSES[0]} />);
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
    expect(screen.getByText("0.6 km")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders title and body", () => {
    render(
      <EmptyState
        icon="redeem"
        title="Nothing claimed yet"
        body="Rewards you claim will appear here with their QR codes."
      />,
    );
    expect(screen.getByText("Nothing claimed yet")).toBeInTheDocument();
    expect(
      screen.getByText("Rewards you claim will appear here with their QR codes."),
    ).toBeInTheDocument();
  });
});
