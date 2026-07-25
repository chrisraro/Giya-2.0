import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { Dialog } from "./dialog";

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(
      <Dialog open={false} onClose={vi.fn()} title="Add product">
        <button type="button">Focus me</button>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders with role=dialog, aria-modal, and aria-labelledby the title when open", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Add product">
        <button type="button">Focus me</button>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const title = screen.getByText("Add product");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
  });

  it("moves focus to the first focusable element in the panel on open", () => {
    // The header's Close button is the first focusable element in DOM
    // order (it renders before children), so it receives focus.
    render(
      <Dialog open onClose={vi.fn()} title="Add product">
        <button type="button">Focus me</button>
      </Dialog>,
    );

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("calls onClose on Escape", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Add product">
        <button type="button">Focus me</button>
      </Dialog>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose on scrim click but not on panel click", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Add product">
        <button type="button">Focus me</button>
      </Dialog>,
    );

    fireEvent.click(screen.getByText("Add product"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the previously focused element on close", () => {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Add product">
            <button type="button">Inside</button>
          </Dialog>
        </div>
      );
    }

    render(<Harness />);
    const openButton = screen.getByRole("button", { name: "Open" });
    openButton.focus();
    fireEvent.click(openButton);

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(openButton).toHaveFocus();
  });
});
