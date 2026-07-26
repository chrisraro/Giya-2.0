import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StaticMap } from "./static-map";

// The zero-JavaScript map. These tests assert the two properties the public
// business page depends on: that it renders as plain images, and that it
// renders NOTHING at all when there is no tile key, so the page never grows an
// empty grey rectangle.

const CEBU = { lat: 10.3156, lng: 123.8854 };

function withKey() {
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "test-key");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("without a tile key", () => {
  it("renders nothing rather than a broken frame", () => {
    const { container } = render(<StaticMap center={CEBU} label="Kape Diaria" />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("with a tile key", () => {
  it("renders the basemap as plain images, with no map library involved", () => {
    withKey();
    const { container } = render(<StaticMap center={CEBU} label="Kape Diaria" />);

    const images = container.querySelectorAll("img");
    expect(images.length).toBeGreaterThan(0);
    expect(images.length).toBeLessThanOrEqual(8);
  });

  it("names the place for assistive technology while leaving the tiles decorative", () => {
    withKey();
    const { container } = render(<StaticMap center={CEBU} label="Kape Diaria" />);

    expect(screen.getByRole("img", { name: /Kape Diaria/ })).toBeInTheDocument();
    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("alt")).toBe("");
    }
  });

  it("offers a dark basemap through a media condition, so the browser fetches only one", () => {
    withKey();
    const { container } = render(<StaticMap center={CEBU} label="Kape Diaria" />);

    const sources = container.querySelectorAll("source");
    expect(sources.length).toBe(container.querySelectorAll("img").length);

    for (const source of sources) {
      // Not a `dark:` class toggle: `display: none` does not stop a browser
      // fetching an image, so that approach would download both mosaics and
      // burn twice the tile quota to show one.
      expect(source.getAttribute("media")).toBe("(prefers-color-scheme: dark)");
      expect(source.getAttribute("srcset")).toContain("dark");
    }
  });

  it("asks the provider for dark pixels rather than inverting light ones", () => {
    withKey();
    const { container } = render(<StaticMap center={CEBU} label="Kape Diaria" />);

    // `filter: invert()` is the popular shortcut and it turns parks purple.
    expect(container.innerHTML).not.toMatch(/invert/);
  });

  it("lazy-loads the tiles, since this block sits below the fold", () => {
    withKey();
    const { container } = render(<StaticMap center={CEBU} label="Kape Diaria" />);

    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("loading")).toBe("lazy");
      // Fixed intrinsic size, so the frame does not shift as tiles arrive.
      expect(image.getAttribute("width")).toBe("256");
      expect(image.getAttribute("height")).toBe("256");
    }
  });

  it("renders the attribution visibly, because it is a licence condition", () => {
    withKey();
    render(<StaticMap center={CEBU} label="Kape Diaria" />);

    // ODbL 4.3 requires the OpenStreetMap credit wherever the data is shown,
    // and the tile host requires its own. Neither is behind a tooltip.
    expect(screen.getByRole("link", { name: /OpenStreetMap/ })).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/copyright",
    );
    expect(screen.getByRole("link", { name: /MapTiler/ })).toBeInTheDocument();
  });

  it("puts the tile key in the URL and the requested coordinates in the tile path", () => {
    withKey();
    const { container } = render(<StaticMap center={CEBU} label="Kape Diaria" zoom={17} />);

    const first = container.querySelector("img");
    expect(first?.getAttribute("src")).toContain("key=test-key");
    expect(first?.getAttribute("src")).toMatch(/\/17\/\d+\/\d+\.png/);
  });
});
