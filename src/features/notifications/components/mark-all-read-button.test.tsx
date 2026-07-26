import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { MarkAllReadButton } from "./mark-all-read-button";

// The inbox header's "Mark all read" control.
//
// Same mock and same reasoning as notification-row-button.test.tsx:
// useFormStatus reports the nearest ancestor <form>, and there is no way to
// drive a real server action from jsdom, so the hook is mocked with exactly the
// shape React hands the component.
//
// The behaviour these assert is the behaviour that used to live inline in the
// page as a render prop, which is what took /notifications down in production.
// Moving it into a client component is what fixed it; keeping the behaviour is
// what these tests are for. src/app/rsc-boundary.test.ts guards the shape.

const { mockFormStatus } = vi.hoisted(() => ({
  mockFormStatus: vi.fn(() => ({ pending: false })),
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, useFormStatus: mockFormStatus };
});

function renderButton() {
  return render(
    <form>
      <MarkAllReadButton />
    </form>,
  );
}

describe("MarkAllReadButton", () => {
  it("submits the form it is rendered in", () => {
    mockFormStatus.mockReturnValue({ pending: false });
    renderButton();

    expect(screen.getByRole("button", { name: "Mark all read" })).toHaveAttribute(
      "type",
      "submit",
    );
  });

  it("is live and silent when idle", () => {
    mockFormStatus.mockReturnValue({ pending: false });
    const { container } = renderButton();

    const button = screen.getByRole("button", { name: "Mark all read" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");
    expect(container.querySelector(".md3-spinner")).toBeNull();
  });

  it("cannot be pressed twice while the write is in flight", () => {
    mockFormStatus.mockReturnValue({ pending: true });
    renderButton();

    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  });

  it("announces the pending write to assistive tech", () => {
    mockFormStatus.mockReturnValue({ pending: true });
    renderButton();

    expect(screen.getByRole("button", { name: "Mark all read" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("reserves the spinner's box whether or not it is spinning", () => {
    // The label must not slide across the header when the button is pressed.
    mockFormStatus.mockReturnValue({ pending: false });
    const idle = renderButton();
    expect(idle.container.querySelector("button > span:first-child")).toHaveClass(
      "size-4",
    );
    idle.unmount();

    mockFormStatus.mockReturnValue({ pending: true });
    const busy = renderButton();
    expect(busy.container.querySelector("button > span:first-child")).toHaveClass(
      "size-4",
    );
  });

  it("keeps its colour transition reduced-motion safe", () => {
    mockFormStatus.mockReturnValue({ pending: false });
    renderButton();

    expect(screen.getByRole("button", { name: "Mark all read" })).toHaveClass(
      "motion-reduce:transition-none",
    );
  });
});
