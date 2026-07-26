import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { PendingButton } from "@/components/ui/pending-button";

describe("PendingButton", () => {
  it("is not tappable twice", () => {
    // The whole point on a money path. A consumer on a slow connection who
    // taps Claim and sees nothing happen will tap it again.
    const onClick = vi.fn();

    const { rerender } = render(
      <PendingButton pending={false} onClick={onClick}>
        Claim
      </PendingButton>,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <PendingButton pending onClick={onClick}>
        Claim
      </PendingButton>,
    );

    expect(screen.getByRole("button")).toBeDisabled();
    fireEvent.click(screen.getByRole("button"));
    // A disabled button dispatches no click, so the count is unchanged.
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("announces the pending state to assistive technology", () => {
    // A spinner is invisible to a screen reader; aria-busy is how this state
    // reaches someone who is not looking at it.
    const { rerender } = render(<PendingButton pending={false}>Claim</PendingButton>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "false");

    rerender(<PendingButton pending>Claim</PendingButton>);
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });

  it("keeps both labels mounted so the button cannot change width", () => {
    // The anti-layout-shift mechanism, asserted directly: "Claim" and
    // "Claiming" occupy the SAME grid cell, and the idle one stays in the box
    // (invisible, not removed) while pending. If a future refactor swapped this
    // for a ternary, the button would resize mid-tap and this test would fail.
    const { rerender } = render(
      <PendingButton pending={false} pendingLabel="Claiming">
        Claim
      </PendingButton>,
    );

    expect(screen.getByText("Claim")).toBeInTheDocument();
    expect(screen.getByText("Claiming")).toBeInTheDocument();
    expect(screen.getByText("Claim")).not.toHaveClass("invisible");
    expect(screen.getByText("Claiming")).toHaveClass("invisible");

    rerender(
      <PendingButton pending pendingLabel="Claiming">
        Claim
      </PendingButton>,
    );

    // Both still mounted; only which one is visible has changed.
    expect(screen.getByText("Claim")).toHaveClass("invisible");
    expect(screen.getByText("Claiming")).not.toHaveClass("invisible");
  });

  it("stacks the labels in one grid cell", () => {
    render(
      <PendingButton pending={false} pendingLabel="Claiming">
        Claim
      </PendingButton>,
    );

    const idle = screen.getByText("Claim");
    const busy = screen.getByText("Claiming");

    for (const label of [idle, busy]) {
      expect(label).toHaveClass("col-start-1", "row-start-1");
    }
    expect(idle.parentElement).toHaveClass("grid");
  });

  it("shows a spinner only while pending", () => {
    const { container, rerender } = render(
      <PendingButton pending={false}>Claim</PendingButton>,
    );
    expect(container.querySelector(".md3-spinner")).toBeNull();

    rerender(<PendingButton pending>Claim</PendingButton>);
    expect(container.querySelector(".md3-spinner")).not.toBeNull();
  });

  it("stays disabled when the caller disables it and it is not pending", () => {
    // Out-of-stock rewards, for instance: disabled for a reason that has
    // nothing to do with a request being in flight.
    render(
      <PendingButton pending={false} disabled>
        Claim
      </PendingButton>,
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");
  });

  it("defaults the pending label to the idle label", () => {
    render(<PendingButton pending>Save</PendingButton>);
    expect(screen.getAllByText("Save")).toHaveLength(2);
  });
});
