import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  Skeleton,
  SkeletonCircle,
  SkeletonScreen,
  SkeletonText,
} from "@/components/ui/skeleton";

describe("Skeleton", () => {
  it("carries the pulse and its reduced-motion escape hatch", () => {
    const { container } = render(<Skeleton data-testid="bone" />);
    const bone = container.firstElementChild;

    expect(bone).toHaveClass("animate-pulse");
    // The whole reduced-motion contract for the bone itself: a user who asked
    // their OS for less motion still gets the shape, without the pulse.
    expect(bone).toHaveClass("motion-reduce:animate-none");
  });

  it("colours itself from a surface token, never a literal", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveClass("bg-surface-container-high");
  });

  it("lets callers override size without losing the base classes", () => {
    const { container } = render(<Skeleton className="h-10 w-20" />);
    const bone = container.firstElementChild;

    expect(bone).toHaveClass("h-10", "w-20", "animate-pulse");
  });
});

describe("SkeletonText", () => {
  // The reason this component exists: a text bone has to reserve the LINE box,
  // not the glyph box, or a screen of bones comes out shorter than the screen
  // of text it stands in for and everything below it jumps when content lands.
  const LINE_BOX_FOR_SIZE = [
    ["headline-m", "h-9"],
    ["headline-s", "h-8"],
    ["title-l", "h-7"],
    ["title-m", "h-6"],
    ["body-l", "h-6"],
    ["body-m", "h-5"],
    ["body-s", "h-4"],
  ] as const;

  it.each(LINE_BOX_FOR_SIZE)(
    "reserves the %s line height (%s)",
    (size, expectedHeight) => {
      const { container } = render(<SkeletonText size={size} />);
      expect(container.firstElementChild).toHaveClass(expectedHeight);
    },
  );

  it("defaults to body-m", () => {
    const { container } = render(<SkeletonText />);
    expect(container.firstElementChild).toHaveClass("h-5");
  });

  it("applies a caller width to the bone rather than the line box", () => {
    const { container } = render(<SkeletonText size="title-m" className="w-32" />);
    const lineBox = container.firstElementChild;
    const bone = lineBox?.firstElementChild;

    expect(lineBox).toHaveClass("h-6");
    expect(bone).toHaveClass("w-32");
    // twMerge must have dropped the base `w-full`, or the width is meaningless.
    expect(bone).not.toHaveClass("w-full");
  });
});

describe("SkeletonCircle", () => {
  it("is round and does not shrink", () => {
    const { container } = render(<SkeletonCircle className="size-10" />);
    expect(container.firstElementChild).toHaveClass("rounded-full", "shrink-0", "size-10");
  });
});

describe("SkeletonScreen", () => {
  it("announces what is loading, once, politely", () => {
    render(
      <SkeletonScreen label="your wallet">
        <Skeleton />
      </SkeletonScreen>,
    );

    expect(screen.getByText("Loading your wallet.")).toBeInTheDocument();
  });

  it("marks itself busy for assistive technology", () => {
    const { container } = render(
      <SkeletonScreen label="your wallet">
        <Skeleton />
      </SkeletonScreen>,
    );
    const root = container.firstElementChild;

    expect(root).toHaveAttribute("aria-busy", "true");
    expect(root).toHaveAttribute("aria-live", "polite");
  });

  it("hides the bones from assistive technology", () => {
    // A screen reader walking fifty empty divs is having a worse time than one
    // that hears a single sentence. The announcement is the accessible version
    // of this screen; the bones are decoration.
    const { container } = render(
      <SkeletonScreen label="your wallet">
        <Skeleton data-testid="bone" />
      </SkeletonScreen>,
    );

    const boneWrapper = container.querySelector("[aria-hidden]");
    expect(boneWrapper).not.toBeNull();
    expect(boneWrapper?.querySelector("[data-testid='bone']")).not.toBeNull();
  });
});
