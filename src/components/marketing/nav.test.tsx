import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MarketingNav } from "./nav";

describe("MarketingNav", () => {
  it("renders brand lockup link and the app CTA", () => {
    render(<MarketingNav />);
    expect(screen.getByRole("link", { name: /giya home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Open Giya" })).toHaveAttribute("href", "/home");
  });
  it("renders section links", () => {
    render(<MarketingNav />);
    expect(screen.getByRole("link", { name: "How it works" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "For businesses" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "FAQ" })).toBeInTheDocument();
  });
});
