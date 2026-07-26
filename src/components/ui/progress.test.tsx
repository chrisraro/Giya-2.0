import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CircularProgress, LinearProgress } from "@/components/ui/progress";

describe("LinearProgress", () => {
  it("exposes itself as a named progressbar", () => {
    render(<LinearProgress label="Sending your receipt" />);
    expect(
      screen.getByRole("progressbar", { name: "Sending your receipt" }),
    ).toBeInTheDocument();
  });

  it("omits aria-valuenow when indeterminate", () => {
    // Absent aria-valuenow IS the ARIA spelling of "indeterminate". Emitting a
    // 0 here would tell a screen reader the task is 0% done, which is a claim
    // about progress this component cannot make.
    render(<LinearProgress label="Working" />);
    const bar = screen.getByRole("progressbar");

    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("reports a percentage when determinate", () => {
    render(<LinearProgress label="Uploading" value={0.42} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  });

  it("clamps values outside 0-1 rather than emitting nonsense", () => {
    const { rerender } = render(<LinearProgress label="Uploading" value={1.8} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");

    rerender(<LinearProgress label="Uploading" value={-3} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("drives the indeterminate sweep from a class, so CSS can disable it", () => {
    // The sweep animation is defined only inside a
    // `prefers-reduced-motion: no-preference` block in globals.css. Keeping the
    // animation in a class rather than an inline style is what makes that
    // media query able to switch it off; an inline `animation` would win over
    // the stylesheet and there would be no way to honour the preference.
    const { container } = render(<LinearProgress label="Working" />);
    const indicator = container.querySelector(".md3-linear-indeterminate-bar");

    expect(indicator).not.toBeNull();
    expect(indicator).not.toHaveAttribute("style");
  });

  it("uses tokenised colour and never mango", () => {
    // Doc 16 reserves tertiary/mango for rewards language. "Something is
    // loading" is not a reward.
    const { container } = render(<LinearProgress label="Working" />);
    const html = container.innerHTML;

    expect(html).toContain("bg-secondary-container");
    expect(html).toContain("bg-primary");
    expect(html).not.toContain("tertiary");
  });
});

describe("CircularProgress", () => {
  it("is hidden from assistive technology when unlabelled", () => {
    // Inside a button that already sets aria-busy, a second announcement of the
    // same state just reads the news twice.
    const { container } = render(<CircularProgress />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstElementChild).not.toHaveAttribute("role");
  });

  it("becomes a named progressbar when given a label", () => {
    render(<CircularProgress label="Loading" />);
    expect(screen.getByRole("progressbar", { name: "Loading" })).toBeInTheDocument();
  });

  it("spins from a class so reduced motion can stop it", () => {
    const { container } = render(<CircularProgress />);
    expect(container.firstElementChild).toHaveClass("md3-spinner");
  });

  it("inherits colour from the control it sits in", () => {
    // border-current is why this works on every button variant without a
    // colour prop, and why it can never introduce an untokenised colour.
    const { container } = render(<CircularProgress />);
    expect(container.firstElementChild).toHaveClass("border-current");
  });
});
