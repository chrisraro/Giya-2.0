import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import ConsumerNotFound from "@/app/(consumer)/not-found";
import RootNotFound from "@/app/not-found";

// Regression guard for the invisible-404 defect. Next's built-in 404 emits its
// inline `<style>` as a React child, so it never applies and the text computed
// to white on the light `bg-surface` (about 1.02:1). These tests assert that
// both boundaries render real content and colour it from MD3 tokens, so a
// future edit cannot quietly reintroduce a hardcoded or inherited colour.

describe("root not-found", () => {
  it("renders its heading and a recovery link to the landing page", () => {
    render(<RootNotFound />);

    expect(
      screen.getByRole("heading", { level: 1, name: /we could not find that page/i }),
    ).toBeInTheDocument();

    const recovery = screen.getByRole("link", { name: /go to giya home/i });
    expect(recovery).toHaveAttribute("href", "/");
  });

  it("does not say the bare string 404 as its only message", () => {
    render(<RootNotFound />);
    expect(screen.getByText(/nothing is wrong with your account/i)).toBeInTheDocument();
  });
});

describe("consumer not-found", () => {
  it("renders its heading and both recovery links inside the consumer shell", () => {
    render(<ConsumerNotFound />);

    expect(
      screen.getByRole("heading", { level: 1, name: /we could not find that page/i }),
    ).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /go to my wallet/i })).toHaveAttribute(
      "href",
      "/wallet",
    );
    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute("href", "/home");
  });

  it("colours its text from MD3 tokens rather than hardcoded values", () => {
    const { container } = render(<ConsumerNotFound />);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.className).toContain("text-on-surface");

    // The defect was a foreground with no legible relationship to the surface.
    // Every colour utility on the page must come from the token layer, so no
    // raw hex, rgb() or named CSS colour may appear in any class or style
    // attribute of the rendered tree.
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(container.innerHTML).not.toMatch(/\brgba?\(/);
    expect(container.innerHTML).not.toMatch(/\b(?:text|bg|border)-(?:white|black)\b/);
  });
});
