import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DiscoverPage from "./page";

vi.mock("@/features/businesses/server/public-repo", () => ({
  listActiveBusinesses: vi.fn().mockResolvedValue([
    {
      id: "biz-1",
      slug: "cozy-cafe",
      name: "Cozy Cafe",
      logoUrl: null,
      cityName: "Cebu City",
      businessTypeName: "Coffee Shop",
    },
  ]),
  listRefCities: vi.fn().mockResolvedValue([{ id: "c1", name: "Cebu City" }]),
  listRefBusinessTypes: vi.fn().mockResolvedValue([{ id: "t1", name: "Coffee Shop" }]),
}));

describe("DiscoverPage", () => {
  it("renders search input, filter selects, and business list", async () => {
    const page = await DiscoverPage({
      searchParams: Promise.resolve({ query: "", cityId: "", typeId: "" }),
    });

    render(page);

    expect(screen.getByText("Discover Shops")).toBeDefined();
    expect(screen.getByPlaceholderText("Search shops by name...")).toBeDefined();
    expect(screen.getByText("Cozy Cafe")).toBeDefined();
  });
});
