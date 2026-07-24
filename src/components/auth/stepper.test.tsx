import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Stepper } from "./stepper";

describe("Stepper", () => {
  it("renders one dot per step, marks the active dot, and labels the group", () => {
    render(<Stepper steps={4} activeIndex={1} />);

    const group = screen.getByLabelText("Step 2 of 4");
    expect(group).toBeInTheDocument();

    const dots = group.querySelectorAll("[data-dot]");
    expect(dots).toHaveLength(4);

    expect(dots[0]?.className).toContain("bg-outline-variant");
    expect(dots[1]?.className).toContain("bg-primary");
    expect(dots[2]?.className).toContain("bg-outline-variant");
    expect(dots[3]?.className).toContain("bg-outline-variant");
  });

  it("updates the aria-label as the active step changes", () => {
    render(<Stepper steps={4} activeIndex={3} />);
    expect(screen.getByLabelText("Step 4 of 4")).toBeInTheDocument();
  });
});
