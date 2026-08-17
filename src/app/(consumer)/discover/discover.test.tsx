import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { BusinessSummary } from "@/features/businesses/server/public-repo";

import DiscoverPage from "./page";

// /discover has three jobs and this file covers all three:
//
//   THE FILTERS ACTUALLY FILTER. Every control on the page is a round trip
//   through the catalog read, and until now nothing asserted that the values
//   reached it. That matters twice over now the map is derived from the
//   filtered set: a filter that silently stopped applying would produce a map
//   confidently showing the wrong shops.
//
//   THE PAGE WORKS WITH NO MAP. NEXT_PUBLIC_MAPTILER_KEY is not configured, so
//   the no-key path is the one that ships. The variable is emptied explicitly
//   below rather than left to chance.
//
//   AN UNGEOCODED SHOP IS STILL A RESULT. Absent from the map, present in the
//   list, and not remarked on.

const mocks = vi.hoisted(() => ({
  listActiveBusinesses: vi.fn(),
  listRefCities: vi.fn(),
  listRefBusinessTypes: vi.fn(),
}));

vi.mock("@/features/businesses/server/public-repo", () => ({
  listActiveBusinesses: mocks.listActiveBusinesses,
  listRefCities: mocks.listRefCities,
  listRefBusinessTypes: mocks.listRefBusinessTypes,
}));

function business(overrides: Partial<BusinessSummary> = {}): BusinessSummary {
  return {
    id: "biz-1",
    slug: "cozy-cafe",
    name: "Cozy Cafe",
    logoUrl: null,
    cityName: "Cebu City",
    businessTypeName: "Coffee Shop",
    coordinates: { lat: 10.3156, lng: 123.8854 },
    ...overrides,
  };
}

/**
 * The pin links only. Scoped to the map's own list, because the region also
 * contains the MapTiler and OpenStreetMap attribution links, which are a
 * licence condition and are supposed to be there.
 */
function pinLinks(): HTMLElement[] {
  const map = screen.getByRole("region", { name: /shops/i });
  return within(within(map).getByRole("list")).getAllByRole("link");
}

async function renderPage(
  params: { query?: string; cityId?: string; typeId?: string } = {},
): Promise<ReturnType<typeof render>> {
  const page = await DiscoverPage({ searchParams: Promise.resolve(params) });
  return render(page);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listActiveBusinesses.mockResolvedValue([business()]);
  mocks.listRefCities.mockResolvedValue([{ id: "c1", name: "Cebu City" }]);
  mocks.listRefBusinessTypes.mockResolvedValue([{ id: "t1", name: "Coffee Shop" }]);
  // The shipping configuration unless a test says otherwise.
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DiscoverPage", () => {
  it("renders search input, filter selects, and business list", async () => {
    await renderPage({ query: "", cityId: "", typeId: "" });

    expect(screen.getByText("Discover Shops")).toBeDefined();
    expect(screen.getByPlaceholderText("Search shops by name...")).toBeDefined();
    expect(screen.getByText("Cozy Cafe")).toBeDefined();
  });
});

describe("the filters reach the catalog read", () => {
  it("passes the search text through, trimmed", async () => {
    await renderPage({ query: "  kape  " });

    expect(mocks.listActiveBusinesses).toHaveBeenCalledWith(
      expect.objectContaining({ query: "kape" }),
    );
  });

  it("asks for no query at all when the search box is empty", async () => {
    await renderPage({ query: "   " });

    // Not the empty string: the repo treats any falsy query as absent, but
    // passing "" through means the page and the repo disagree about what
    // "no search" is, and only one of them is checked.
    expect(mocks.listActiveBusinesses).toHaveBeenCalledWith(
      expect.objectContaining({ query: undefined }),
    );
  });

  it("passes the chosen city through", async () => {
    await renderPage({ cityId: "c1" });

    expect(mocks.listActiveBusinesses).toHaveBeenCalledWith(
      expect.objectContaining({ cityId: "c1" }),
    );
  });

  it("passes the chosen category through as the business type", async () => {
    await renderPage({ typeId: "t1" });

    expect(mocks.listActiveBusinesses).toHaveBeenCalledWith(
      expect.objectContaining({ businessTypeId: "t1" }),
    );
  });

  it("composes all three filters in one read rather than filtering afterwards", async () => {
    await renderPage({ query: "kape", cityId: "c1", typeId: "t1" });

    expect(mocks.listActiveBusinesses).toHaveBeenCalledTimes(1);
    expect(mocks.listActiveBusinesses).toHaveBeenCalledWith({
      query: "kape",
      cityId: "c1",
      businessTypeId: "t1",
      limit: 50,
    });
  });

  it("asks for nothing at all when no filter is set", async () => {
    await renderPage({});

    expect(mocks.listActiveBusinesses).toHaveBeenCalledWith({
      query: undefined,
      cityId: undefined,
      businessTypeId: undefined,
      limit: 50,
    });
  });
});

describe("with no tile key, which is the configuration that ships", () => {
  it("is fully usable: search, filters and results all still render", async () => {
    mocks.listActiveBusinesses.mockResolvedValue([
      business(),
      business({ id: "biz-2", slug: "lugaw-republic", name: "Lugaw Republic" }),
    ]);

    await renderPage({ query: "a" });

    expect(screen.getByPlaceholderText("Search shops by name...")).toBeDefined();
    expect(screen.getByRole("button", { name: "Filter" })).toBeDefined();
    expect(screen.getByText("Cozy Cafe")).toBeDefined();
    expect(screen.getByText("Lugaw Republic")).toBeDefined();
  });

  it("says nothing anywhere about a map", async () => {
    const { container } = await renderPage({});

    // No apology, no dead toggle, no heading left behind by a component that
    // rendered itself away. NOT asserted against container.textContent with a
    // word boundary: textContent concatenates every element's text without
    // separators, so a stray "Map" heading arrives as "FilterMapstorefront"
    // and \b matches nothing. queryByText compares per element, which is the
    // question actually being asked.
    expect(screen.queryByText(/map/i)).toBeNull();
    expect(screen.queryByRole("region", { name: /map|shops/i })).toBeNull();

    // No tiles, and no attribution, which only ever accompanies drawn tiles.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /OpenStreetMap/ })).toBeNull();
    expect(container.innerHTML).not.toContain("maptiler");
  });

  it("puts the results straight after the filters, with no empty frame between", async () => {
    const { container } = await renderPage({});

    // The structural half of the same claim. An empty bordered rectangle
    // carries no text and no images, so the assertions above would all pass
    // while the page grew a grey box; this one would not.
    const afterTheForm = container.querySelector("form")?.nextElementSibling;

    expect(afterTheForm?.tagName).toBe("SECTION");
    expect(afterTheForm?.textContent ?? "").toContain("Cozy Cafe");
  });

  it("still shows the empty state when nothing matched", async () => {
    mocks.listActiveBusinesses.mockResolvedValue([]);

    await renderPage({ query: "nothing" });

    expect(screen.getByText("No matching shops found")).toBeDefined();
  });
});

describe("with a tile key configured", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "test-key");
  });

  it("draws the map from the shops the filter returned, not from anything else", async () => {
    mocks.listActiveBusinesses.mockResolvedValue([
      business({ id: "biz-1", slug: "cozy-cafe", name: "Cozy Cafe" }),
      business({
        id: "biz-2",
        slug: "lugaw-republic",
        name: "Lugaw Republic",
        coordinates: { lat: 10.32, lng: 123.89 },
      }),
    ]);

    await renderPage({ cityId: "c1" });

    expect(pinLinks().map((link) => link.getAttribute("href")).sort()).toEqual([
      "/b/cozy-cafe",
      "/b/lugaw-republic",
    ]);
  });

  it("keeps an ungeocoded shop in the results while leaving it off the map", async () => {
    mocks.listActiveBusinesses.mockResolvedValue([
      business({ id: "biz-1", slug: "cozy-cafe", name: "Cozy Cafe" }),
      business({
        id: "biz-2",
        slug: "sari-sari",
        name: "Aling Nena Sari Sari",
        coordinates: null,
      }),
    ]);

    await renderPage({});

    // In the list.
    expect(screen.getByText("Aling Nena Sari Sari")).toBeDefined();
    expect(screen.getByRole("link", { name: /Aling Nena Sari Sari/ })).toHaveAttribute(
      "href",
      "/b/sari-sari",
    );

    // Not on the map, and the map does not mention it.
    expect(pinLinks()).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: /shops/i })).queryByText(/Aling Nena/),
    ).toBeNull();
  });

  it("draws no map when the filter returned nothing", async () => {
    mocks.listActiveBusinesses.mockResolvedValue([]);

    const { container } = await renderPage({ query: "nothing" });

    expect(screen.queryByRole("region", { name: /shops/i })).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByText("No matching shops found")).toBeDefined();
  });

  it("draws no map when nothing in the results has been geocoded", async () => {
    mocks.listActiveBusinesses.mockResolvedValue([
      business({ coordinates: null }),
      business({ id: "biz-2", slug: "lugaw", name: "Lugaw Republic", coordinates: null }),
    ]);

    const { container } = await renderPage({});

    expect(screen.queryByRole("region", { name: /shops/i })).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(0);
    // The results are unaffected.
    expect(screen.getByText("Cozy Cafe")).toBeDefined();
    expect(screen.getByText("Lugaw Republic")).toBeDefined();
  });
});
