import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import type { BusinessSummary } from "@/features/businesses/server/public-repo";
import type { BalanceDTO } from "@/features/rewards/types";

import { BusinessCard } from "./business-card";
import { EmptyState } from "./empty-state";
import { LoyaltyStrip } from "./loyalty-strip";

// These components used to be handed fixtures out of src/lib/mock/consumer.ts,
// and the old assertions here pinned fixture-only fields: a "0.6 km" distance
// chip and a "3 of 5" stamp row. Neither exists in the schema. There is no
// geolocation anywhere in this app, and business_customers tracks
// points_balance / lifetime_points with no stamp card to count against. Those
// two assertions were removed rather than translated, because they were
// asserting the shape of the fixture, not of anything the database can
// produce. Everything they were guarding that IS real (name, caption, links)
// is asserted below against the real DTO shapes.

function balance(overrides: Partial<BalanceDTO> = {}): BalanceDTO {
  return {
    businessId: "3f1b0d9c-4444-4444-8444-444444444444",
    businessName: "Panaderia Mercedes",
    businessSlug: "panaderia-mercedes",
    pointsBalance: 1250,
    lifetimePoints: 4300,
    ...overrides,
  };
}

function summary(overrides: Partial<BusinessSummary> = {}): BusinessSummary {
  return {
    id: "7c2e5a1b-5555-4555-8555-555555555555",
    slug: "lugaw-republic",
    name: "Lugaw Republic",
    logoUrl: null,
    cityName: "Davao City",
    businessTypeName: "Carinderia",
    coordinates: null,
    ...overrides,
  };
}

describe("LoyaltyStrip", () => {
  it("renders the real points balance and lifetime total for each business", () => {
    render(<LoyaltyStrip balances={[balance()]} />);

    expect(screen.getByText("Panaderia Mercedes")).toBeInTheDocument();
    expect(screen.getByText("1,250")).toBeInTheDocument();
    expect(screen.getByText("4,300 earned here all time")).toBeInTheDocument();
  });

  it("CRITICAL: every card is a link to that business's page, not an inert card", () => {
    render(<LoyaltyStrip balances={[balance()]} />);

    expect(screen.getByRole("link", { name: /Panaderia Mercedes/ })).toHaveAttribute(
      "href",
      "/b/panaderia-mercedes",
    );
  });

  it("falls back to /wallet when the business is no longer publicly readable", () => {
    // getMyBalances leaves the slug empty when the businesses row could not be
    // resolved (deactivated or soft-deleted); /b/ would 404.
    render(<LoyaltyStrip balances={[balance({ businessSlug: "", businessName: "" })]} />);

    expect(screen.getByRole("link", { name: /This shop/ })).toHaveAttribute("href", "/wallet");
  });

  it("renders one card per balance", () => {
    render(
      <LoyaltyStrip
        balances={[
          balance(),
          balance({ businessId: "b2", businessName: "Sari Sari Co", businessSlug: "sari-sari-co" }),
        ]}
      />,
    );

    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("renders nothing at all for no balances, leaving the empty state to the page", () => {
    render(<LoyaltyStrip balances={[]} />);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("BusinessCard", () => {
  it("renders the name and the type/city caption", () => {
    render(<BusinessCard business={summary()} />);

    expect(screen.getByText("Lugaw Republic")).toBeInTheDocument();
    expect(screen.getByText("Carinderia · Davao City")).toBeInTheDocument();
  });

  it("CRITICAL: the card is a link to /b/[slug], which is what makes /home's cards work", () => {
    render(<BusinessCard business={summary()} />);

    expect(screen.getByRole("link", { name: /Lugaw Republic/ })).toHaveAttribute(
      "href",
      "/b/lugaw-republic",
    );
  });

  it("omits the caption entirely when neither type nor city is known", () => {
    render(<BusinessCard business={summary({ cityName: null, businessTypeName: null })} />);

    expect(screen.getByText("Lugaw Republic")).toBeInTheDocument();
    expect(screen.queryByText("·")).not.toBeInTheDocument();
  });

  it("shows just the city when the business type is missing", () => {
    render(<BusinessCard business={summary({ businessTypeName: null })} />);

    expect(screen.getByText("Davao City")).toBeInTheDocument();
  });

  it("falls back to the initial when there is no logo", () => {
    render(<BusinessCard business={summary({ logoUrl: null })} />);

    expect(screen.getByText("L")).toBeInTheDocument();
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
