import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));

import { BottomNav } from "./bottom-nav";

describe("BottomNav", () => {
  it("renders 4 destinations and the Scan FAB", () => {
    render(<BottomNav />);
    for (const label of ["Home", "Wallet", "Rewards", "Profile"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    const fab = screen.getByRole("link", { name: "Scan receipt" });
    expect(fab.className).toContain("bg-tertiary-container");
    expect(fab.className).toContain("size-14"); // 56px FAB
  });
});
