import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PortalShell } from "@/components/business/portal-shell";

vi.mock("next/navigation", () => ({ usePathname: () => "/business/dashboard" }));

describe("PortalShell", () => {
  it("mounts the offline banner so staff see when the portal loses connection", () => {
    render(<PortalShell>content</PortalShell>);
    expect(screen.queryByText(/you are offline/i)).not.toBeInTheDocument();
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(/you are offline/i)).toBeInTheDocument();
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
  });
});
