import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { OfflineBanner } from "@/components/pwa/offline-banner";

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
  act(() => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

afterEach(() => setOnline(true));

describe("OfflineBanner", () => {
  it("shows no message while online", () => {
    render(<OfflineBanner />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces politely when the connection drops, and clears on return", () => {
    render(<OfflineBanner />);
    // The live region exists before the drop so assistive tech announces the change.
    const banner = screen.getByRole("status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    setOnline(false);
    expect(banner).toHaveTextContent(/offline/i);
    setOnline(true);
    expect(banner).toBeEmptyDOMElement();
  });

  it("sits at the top, clear of the notch, so it never covers the bottom nav", () => {
    render(<OfflineBanner />);
    setOnline(false);
    const cls = screen.getByRole("status").className;
    expect(cls).toContain("sticky");
    expect(cls).toContain("top-0");
    expect(cls).toContain("safe-area-inset-top");
  });
});
