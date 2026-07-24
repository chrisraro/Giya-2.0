import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders filled variant by default with MD3 classes", () => {
    render(<Button>Scan receipt</Button>);
    const btn = screen.getByRole("button", { name: "Scan receipt" });
    expect(btn.className).toContain("bg-primary");
    expect(btn.className).toContain("rounded-full");
  });

  it("renders tonal variant on secondary-container", () => {
    render(<Button variant="tonal">Claim</Button>);
    expect(screen.getByRole("button").className).toContain("bg-secondary-container");
  });

  it("touch size meets 48px minimum", () => {
    render(<Button size="touch">Go</Button>);
    expect(screen.getByRole("button").className).toContain("h-12");
  });
});
