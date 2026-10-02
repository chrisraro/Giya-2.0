import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RouteError } from "@/components/shell/route-error";

const SECRET = 'relation "receipts" does not exist: SELECT * FROM secrets';

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

function setup(error: Error & { digest?: string } = new Error(SECRET)) {
  const reset = vi.fn();
  const utils = render(
    <RouteError error={error} reset={reset} homeHref="/home" homeLabel="Back to home" />,
  );
  return { reset, ...utils };
}

describe("RouteError", () => {
  it("shows a friendly heading inside an alert region", () => {
    setup();
    expect(
      screen.getByRole("heading", { level: 1, name: /something went wrong/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("calls reset when Try again is pressed", () => {
    const { reset } = setup();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("links back to the group's home", () => {
    setup();
    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute("href", "/home");
  });

  it("never renders error.message", () => {
    const { container } = setup();
    expect(container.innerHTML).not.toContain("secrets");
    expect(container.innerHTML).not.toContain("relation");
  });

  it("shows the digest as a reference code when present", () => {
    setup(Object.assign(new Error(SECRET), { digest: "abc123" }));
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
  });

  it("omits the reference line when there is no digest", () => {
    setup();
    expect(screen.queryByText(/reference/i)).not.toBeInTheDocument();
  });

  it("reports the error once even across re-renders", () => {
    const error = new Error(SECRET);
    const { rerender, reset } = setup(error);
    rerender(<RouteError error={error} reset={reset} homeHref="/home" homeLabel="Back to home" />);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
