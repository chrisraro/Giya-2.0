import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BusinessLocation } from "./business-location";

// "Where to find us" on the public business page. The owner's requirement:
// "consumers will not guess anymore the directions of the business address.
// They can see it on the business profile when they tap it."
//
// The thing these tests are really guarding is the degradation ladder. Almost
// every business has an address and no pin today, and that state must look
// deliberate rather than broken.

const CEBU = { lat: 10.3156, lng: 123.8854 };
const ADDRESS = "12 Real Street, San Jose, Cebu City, 5000";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("when the merchant has set nothing", () => {
  it("renders no block at all, rather than a heading with nothing under it", () => {
    const { container } = render(
      <BusinessLocation name="Kape Diaria" addressText={null} coordinates={null} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("when there is an address but no pin", () => {
  it("shows the address text", () => {
    render(<BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={null} />);

    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
  });

  it("renders no map frame at all", () => {
    const { container } = render(
      <BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={null} />,
    );

    // The state every business is in until its owner opens the picker. An empty
    // bordered rectangle here would read as a failure rather than as a profile
    // that is not finished.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelectorAll("picture")).toHaveLength(0);
  });

  it("offers no directions link, because there is nowhere to send anyone", () => {
    render(<BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={null} />);

    expect(screen.queryByRole("link", { name: /directions/i })).not.toBeInTheDocument();
  });
});

describe("when there is a pin", () => {
  it("offers a directions link whose URL is well formed", () => {
    render(<BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={CEBU} />);

    const link = screen.getByRole("link", { name: /directions to Kape Diaria/i });
    const url = new URL(link.getAttribute("href") ?? "");

    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("www.google.com");
    expect(url.pathname).toBe("/maps/dir/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("destination")).toBe("10.3156,123.8854");
  });

  it("uses one universal https link rather than sniffing the platform", () => {
    render(<BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={CEBU} />);

    const href = screen.getByRole("link", { name: /directions/i }).getAttribute("href") ?? "";

    // `geo:` is dead on iOS and desktop; `maps://` is dead everywhere but
    // Apple. A wrong user-agent sniff produces a button that does nothing,
    // which is worse than one that opens a web map.
    expect(href.startsWith("geo:")).toBe(false);
    expect(href.startsWith("maps:")).toBe(false);
    expect(href.startsWith("https://")).toBe(true);
  });

  it("opens the link safely in a new context", () => {
    render(<BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={CEBU} />);

    const link = screen.getByRole("link", { name: /directions/i });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("shows the coordinates as text, so the information does not depend on the picture", () => {
    render(<BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={CEBU} />);

    expect(screen.getByText("10.315600, 123.885400")).toBeInTheDocument();
  });

  it("keeps the address text alongside the map, not instead of it", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "test-key");
    const { container } = render(
      <BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={CEBU} />,
    );

    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    // Queried through the DOM rather than by role: the map is wrapped in an
    // `aria-hidden` shortcut link, so it is deliberately absent from the
    // accessibility tree. Everything it shows is text elsewhere in the block.
    expect(container.querySelectorAll("img").length).toBeGreaterThan(0);
  });

  it("still gives directions when there is no basemap to draw", () => {
    // No tile key. The link is two numbers in a URL and needs no picture, so
    // the owner-visible requirement survives a missing key completely.
    const { container } = render(
      <BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={CEBU} />,
    );

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByRole("link", { name: /directions/i })).toBeInTheDocument();
  });

  it("works with a pin and no written address at all", () => {
    render(<BusinessLocation name="Kape Diaria" addressText={null} coordinates={CEBU} />);

    expect(screen.getByRole("link", { name: /directions/i })).toBeInTheDocument();
  });

  it("exposes exactly one directions control to the keyboard, not two", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "test-key");
    render(<BusinessLocation name="Kape Diaria" addressText={ADDRESS} coordinates={CEBU} />);

    // The map picture is a shortcut to the same destination as the button, so
    // it is removed from the tab order and from the accessibility tree. One
    // target, one announcement.
    expect(screen.getAllByRole("link", { name: /directions/i })).toHaveLength(1);
  });
});
