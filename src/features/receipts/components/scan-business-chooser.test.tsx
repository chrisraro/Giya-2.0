import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { BusinessSummary } from "@/features/businesses/server/public-repo";

import { ScanBusinessChooser } from "./scan-business-chooser";

// The store chooser is what stands between a consumer and a guaranteed
// rejection: generic scan is [V1] and an unbound receipt is always rejected
// wrong_business, so every route out of this screen must carry a business id.
// These tests pin that, the recency ordering, and both empty cases.

const BUSINESS_A = "3f1b0d9c-4444-4444-8444-444444444444";
const BUSINESS_B = "7c2e5a1b-5555-4555-8555-555555555555";
const BUSINESS_C = "9a4d6f3e-6666-4666-8666-666666666666";

function business(id: string, name: string, overrides: Partial<BusinessSummary> = {}): BusinessSummary {
  return {
    id,
    // BusinessSummary carries the public slug so a picker row can also link to
    // /b/[slug]; the chooser itself only ever links by id.
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    logoUrl: null,
    cityName: "Cebu City",
    coordinates: null,
    businessTypeName: "Cafe",
    ...overrides,
  };
}

function manyBusinesses(count: number): BusinessSummary[] {
  return Array.from({ length: count }, (_unused, index) =>
    business(`0000000${index}-1111-4111-8111-11111111111${index}`, `Shop ${index}`),
  );
}

describe("ScanBusinessChooser", () => {
  it("CRITICAL: every shop links to the pre-bound scan flow, never to bare /scan", () => {
    render(
      <ScanBusinessChooser
        recent={[business(BUSINESS_A, "Kape Diaria")]}
        businesses={[business(BUSINESS_B, "Lugaw Republic")]}
      />,
    );

    expect(screen.getByRole("link", { name: /Kape Diaria/ })).toHaveAttribute(
      "href",
      `/scan?business=${BUSINESS_A}`,
    );
    expect(screen.getByRole("link", { name: /Lugaw Republic/ })).toHaveAttribute(
      "href",
      `/scan?business=${BUSINESS_B}`,
    );
  });

  it("explains why a shop has to be picked before the camera opens", () => {
    render(<ScanBusinessChooser recent={[]} businesses={[business(BUSINESS_A, "Kape Diaria")]} />);

    expect(screen.getByText(/Pick the shop where you paid/)).toBeInTheDocument();
  });

  it("leads with recently visited shops, in the order given", () => {
    render(
      <ScanBusinessChooser
        recent={[business(BUSINESS_A, "Kape Diaria"), business(BUSINESS_B, "Lugaw Republic")]}
        businesses={[business(BUSINESS_C, "Adobo Corner")]}
      />,
    );

    const recentSection = screen.getByRole("heading", { name: "Recently visited" }).closest("section");
    expect(recentSection).not.toBeNull();
    const recentLinks = within(recentSection as HTMLElement).getAllByRole("link");
    expect(recentLinks.map((link) => link.textContent)).toEqual([
      expect.stringContaining("Kape Diaria"),
      expect.stringContaining("Lugaw Republic"),
    ]);

    // The rest go under their own heading, so a shop never appears twice.
    const allSection = screen.getByRole("heading", { name: "All shops" }).closest("section");
    expect(within(allSection as HTMLElement).getAllByRole("link")).toHaveLength(1);
  });

  it("captions each shop with its type and city so near-identical names are distinguishable", () => {
    render(
      <ScanBusinessChooser
        recent={[]}
        businesses={[business(BUSINESS_A, "Kape Diaria", { cityName: "Mandaue" })]}
      />,
    );

    expect(screen.getByText("Cafe · Mandaue")).toBeInTheDocument();
  });

  it("hides the search field for a list short enough to read", () => {
    render(<ScanBusinessChooser recent={[]} businesses={manyBusinesses(3)} />);

    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });

  it("shows a GET search form once the list is long, so filtering needs no client JS", () => {
    render(<ScanBusinessChooser recent={[]} businesses={manyBusinesses(9)} />);

    const form = screen.getByRole("search");
    expect(form).toHaveAttribute("action", "/scan");
    expect(form).toHaveAttribute("method", "get");
    expect(screen.getByLabelText("Find a shop")).toHaveAttribute("name", "q");
  });

  it("shows the search field whenever a search is active, however few results came back", () => {
    render(<ScanBusinessChooser recent={[]} businesses={[business(BUSINESS_A, "Kape")]} query="kape" />);

    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.getByLabelText("Find a shop")).toHaveValue("kape");
  });

  it("says so and keeps the search field when more shops exist than are listed", () => {
    render(<ScanBusinessChooser recent={[]} businesses={manyBusinesses(3)} truncated />);

    expect(screen.getByRole("search")).toBeInTheDocument();
    expect(screen.getByText(/Only the first 50 shops are listed/)).toBeInTheDocument();
  });

  it("offers a way back to the full list when a search matches nothing", () => {
    render(<ScanBusinessChooser recent={[]} businesses={[]} query="zzz" />);

    expect(screen.getByText("No shops matched")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show all shops" })).toHaveAttribute("href", "/scan");
  });

  it("has an honest empty state when no shop is live yet", () => {
    render(<ScanBusinessChooser recent={[]} businesses={[]} />);

    expect(screen.getByText("No shops yet")).toBeInTheDocument();
    // Nothing to link to, so no CTA that would dead-end the consumer.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
  });
});
