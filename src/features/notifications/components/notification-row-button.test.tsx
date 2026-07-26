import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { NotificationRowButton } from "./notification-row-button";

// The optimistic read state.
//
// useFormStatus reports the status of the nearest ancestor <form>, and there is
// no way to drive a real server action from jsdom. Mocking the hook is
// therefore the only way to assert the two states, and it is an honest mock:
// the value it returns is exactly the shape React hands the component.

const { mockFormStatus } = vi.hoisted(() => ({
  mockFormStatus: vi.fn(() => ({ pending: false })),
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, useFormStatus: mockFormStatus };
});

function renderRow(unread: boolean) {
  return render(
    <form>
      <NotificationRowButton unread={unread}>
        <span>Points awarded</span>
      </NotificationRowButton>
    </form>,
  );
}

describe("NotificationRowButton", () => {
  it("shows an unread row as unread", () => {
    mockFormStatus.mockReturnValue({ pending: false });
    renderRow(true);

    expect(screen.getByRole("button")).toHaveClass("bg-surface-container-low");
    expect(screen.getByText("Unread")).toBeInTheDocument();
  });

  it("shows a read row without the tint or the dot", () => {
    mockFormStatus.mockReturnValue({ pending: false });
    renderRow(false);

    expect(screen.getByRole("button")).not.toHaveClass("bg-surface-container-low");
    expect(screen.queryByText("Unread")).toBeNull();
  });

  it("marks an unread row read the instant it is submitted", () => {
    // The optimistic claim, and the reason it is honest: openNotification marks
    // the row read and then redirects, unconditionally. There is no successful
    // path on which the row stays unread, so showing "read" immediately is
    // showing the truth early rather than guessing.
    mockFormStatus.mockReturnValue({ pending: true });
    renderRow(true);

    expect(screen.getByRole("button")).not.toHaveClass("bg-surface-container-low");
    expect(screen.queryByText("Unread")).toBeNull();
  });

  it("announces the pending submission", () => {
    mockFormStatus.mockReturnValue({ pending: true });
    renderRow(true);

    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });

  it("reserves the dot's box whether or not the dot is shown", () => {
    // Read and unread rows must be the same width, or the title reflows the
    // moment a row is tapped.
    mockFormStatus.mockReturnValue({ pending: false });

    const unreadRender = renderRow(true);
    const unreadSlot = unreadRender.container.querySelector("button > span:last-child");
    expect(unreadSlot).toHaveClass("size-2", "shrink-0");
    unreadRender.unmount();

    const readRender = renderRow(false);
    const readSlot = readRender.container.querySelector("button > span:last-child");
    expect(readSlot).toHaveClass("size-2", "shrink-0");
  });

  it("keeps its colour transition reduced-motion safe", () => {
    mockFormStatus.mockReturnValue({ pending: false });
    renderRow(false);

    expect(screen.getByRole("button")).toHaveClass("motion-reduce:transition-none");
  });
});
