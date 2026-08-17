import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BusinessSummary } from "@/features/businesses/server/public-repo";

import { DiscoverMap } from "./discover-map";

// The map of a result set. Two properties matter more than the geometry:
//
//   1. WITH NO TILE KEY IT RENDERS NOTHING. NEXT_PUBLIC_MAPTILER_KEY is still
//      outstanding, so this is the path that ships first, and it is exercised
//      here with the key explicitly emptied rather than merely absent - a test
//      that passes only because the runner happens to lack a variable proves
//      nothing about the environment where the variable is set to blank.
//
//   2. A SHOP WITH NO PIN IS STILL A RESULT. It is missing from the map and
//      present in the list, and the map never apologises for it.

function business(overrides: Partial<BusinessSummary> = {}): BusinessSummary {
  return {
    id: "biz-1",
    slug: "kape-diaria",
    name: "Kape Diaria",
    logoUrl: null,
    cityName: "Cebu City",
    businessTypeName: "Cafe",
    coordinates: { lat: 10.3156, lng: 123.8854 },
    ...overrides,
  };
}

/** The positioned <li> around each pin, in the order the shops were passed. */
function pinItems(): HTMLElement[] {
  const map = screen.getByRole("region", { name: /shops/i });
  return [...map.querySelectorAll("li")];
}

function withKey() {
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "test-key");
}

function withoutKey() {
  // Explicitly blank, not merely unset: this is the shipping configuration.
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with no tile key configured", () => {
  it("renders nothing at all, not an empty frame and not an apology", () => {
    withoutKey();

    const { container } = render(
      <DiscoverMap businesses={[business(), business({ id: "biz-2", slug: "lugaw" })]} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing about maps, so nothing on the page claims one exists", () => {
    withoutKey();

    const { container } = render(<DiscoverMap businesses={[business()]} />);

    expect(container.textContent ?? "").toBe("");
    expect(container.innerHTML).not.toMatch(/map/i);
  });
});

describe("with a tile key but nothing to pin", () => {
  it("renders nothing when no result has been geocoded", () => {
    withKey();

    const { container } = render(
      <DiscoverMap
        businesses={[
          business({ coordinates: null }),
          business({ id: "biz-2", slug: "lugaw", coordinates: null }),
        ]}
      />,
    );

    // An empty basemap of the middle of the ocean would be worse than no map.
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the result set is empty", () => {
    withKey();

    const { container } = render(<DiscoverMap businesses={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("with a tile key and pinned results", () => {
  it("draws one pin per pinned shop, each reaching that shop's page", () => {
    withKey();

    render(
      <DiscoverMap
        businesses={[
          business(),
          business({
            id: "biz-2",
            slug: "lugaw-republic",
            name: "Lugaw Republic",
            coordinates: { lat: 10.32, lng: 123.89 },
          }),
        ]}
      />,
    );

    const map = screen.getByRole("region", { name: /shops/i });
    const links = within(map).getAllByRole("link", { name: /Kape Diaria|Lugaw Republic/ });

    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute("href")).sort()).toEqual([
      "/b/kape-diaria",
      "/b/lugaw-republic",
    ]);
  });

  it("leaves an ungeocoded shop off the map without saying a word about it", () => {
    withKey();

    render(
      <DiscoverMap
        businesses={[
          business(),
          business({ id: "biz-2", slug: "no-pin", name: "Unpinned Panaderia", coordinates: null }),
        ]}
      />,
    );

    const map = screen.getByRole("region", { name: /shops/i });

    expect(within(map).getAllByRole("link", { name: /Kape Diaria/ })).toHaveLength(1);
    expect(within(map).queryByText(/Unpinned Panaderia/)).toBeNull();
    // No count, no "1 of 2 shown", nothing that reads as a complaint about
    // data the consumer cannot fix.
    expect(map.textContent ?? "").not.toMatch(/unpinned|not shown|missing|unavailable/i);
  });

  it("zooms all the way in on a single result", () => {
    withKey();

    const { container } = render(<DiscoverMap businesses={[business()]} />);

    // 15, the literal, not the constant: importing DISCOVER_MAP_MAX_ZOOM would
    // let a wrong value agree with its own expectation. A neighbourhood, which
    // is what "where is this, roughly" wants, rather than BUSINESS_MAP_ZOOM's
    // street-level 17.
    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("src")).toMatch(/\/15\/\d+\/\d+\.png/);
    }
    expect(container.querySelectorAll("img").length).toBeGreaterThan(0);
  });

  it("zooms out far enough to hold shops that are far apart", () => {
    withKey();

    const { container } = render(
      <DiscoverMap
        businesses={[
          business({ coordinates: { lat: 14.5995, lng: 120.9842 } }), // Manila
          business({ id: "biz-2", slug: "davao", coordinates: { lat: 7.1907, lng: 125.4553 } }),
        ]}
      />,
    );

    const zooms = new Set(
      [...container.querySelectorAll("img")].map(
        (image) => /\/(\d+)\/\d+\/\d+\.png/.exec(image.getAttribute("src") ?? "")?.[1],
      ),
    );

    // Manila to Davao is roughly 4.5 degrees of longitude, which does not fit
    // a 512px frame anywhere near zoom 15.
    expect(zooms.size).toBe(1);
    expect(Number([...zooms][0])).toBeLessThan(15);
    expect(Number([...zooms][0])).toBeGreaterThanOrEqual(3);
  });

  it("keeps every pin inside the frame, with room for the pin's own body", () => {
    withKey();

    render(
      <DiscoverMap
        businesses={[
          business({ coordinates: { lat: 14.5995, lng: 120.9842 } }),
          business({ id: "biz-2", slug: "cebu", coordinates: { lat: 10.3157, lng: 123.8854 } }),
          business({ id: "biz-3", slug: "davao", coordinates: { lat: 7.1907, lng: 125.4553 } }),
        ]}
      />,
    );

    // The mosaic's logical box is 512x224 and the fit reserves the pin's own
    // 24px at every edge, so no pin may fall outside [24, 488] x [24, 200].
    // Without that reservation the outermost pins sit exactly on the boundary
    // and are drawn half outside the frame.
    for (const item of pinItems()) {
      expect(Number.parseFloat(item.style.left)).toBeGreaterThanOrEqual(24);
      expect(Number.parseFloat(item.style.left)).toBeLessThanOrEqual(488);
      expect(Number.parseFloat(item.style.top)).toBeGreaterThanOrEqual(24);
      expect(Number.parseFloat(item.style.top)).toBeLessThanOrEqual(200);
    }
  });

  it("reserves the pin's own width in the fit, even when that costs a zoom level", () => {
    withKey();

    // Chosen so the reservation is VISIBLE rather than merely plausible. The
    // two shops are 2.6719 degrees apart, which is 1.90002px at zoom 0:
    //   using the whole 512px frame:  512 / 1.90002 = 269.47, log2 = 8.074 -> 8
    //   reserving 24px at each edge:  464 / 1.90002 = 244.21, log2 = 7.932 -> 7
    // A fit that ignores the pin's body draws zoom 8 and slices both outermost
    // pins down the middle at the frame edge.
    const { container } = render(
      <DiscoverMap
        businesses={[
          business({ id: "w", slug: "w", coordinates: { lat: 10.3, lng: 120.0 } }),
          business({ id: "e", slug: "e", coordinates: { lat: 10.3, lng: 122.6719 } }),
        ]}
      />,
    );

    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("src")).toMatch(/\/7\/\d+\/\d+\.png/);
    }
    expect(container.querySelectorAll("img").length).toBeGreaterThan(0);
  });

  it("puts each shop at its own place, with the eastern one further right", () => {
    withKey();

    render(
      <DiscoverMap
        businesses={[
          business({ id: "west", slug: "west", coordinates: { lat: 10.3, lng: 120.9 } }),
          business({ id: "east", slug: "east", coordinates: { lat: 10.3, lng: 125.4 } }),
        ]}
      />,
    );

    // A map that draws every pin at the frame's centre satisfies "one link per
    // shop" and "every pin inside the frame" perfectly, and is useless.
    const [west, east] = pinItems();
    expect(Number.parseFloat(west?.style.left ?? "0")).toBeLessThan(
      Number.parseFloat(east?.style.left ?? "0"),
    );
    expect(Number.parseFloat(west?.style.top ?? "0")).toBeCloseTo(
      Number.parseFloat(east?.style.top ?? "0"),
      6,
    );
  });

  it("puts the northern shop higher up, since north is a smaller y", () => {
    withKey();

    render(
      <DiscoverMap
        businesses={[
          business({ id: "north", slug: "north", coordinates: { lat: 16.4, lng: 121 } }),
          business({ id: "south", slug: "south", coordinates: { lat: 7.19, lng: 121 } }),
        ]}
      />,
    );

    const [north, south] = pinItems();
    expect(Number.parseFloat(north?.style.top ?? "0")).toBeLessThan(
      Number.parseFloat(south?.style.top ?? "0"),
    );
  });

  it("renders the attribution, because it is a licence condition", () => {
    withKey();

    render(<DiscoverMap businesses={[business()]} />);

    expect(screen.getByRole("link", { name: /OpenStreetMap/ })).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/copyright",
    );
    expect(screen.getByRole("link", { name: /MapTiler/ })).toBeInTheDocument();
  });

  it("keeps the tiles decorative, so a screen reader hears shops and not images", () => {
    withKey();

    const { container } = render(<DiscoverMap businesses={[business()]} />);

    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("alt")).toBe("");
      expect(image.getAttribute("loading")).toBe("lazy");
    }
  });
});
