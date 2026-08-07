import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import OfflinePage from "./page";

describe("OfflinePage", () => {
  it("renders offline fallback message", () => {
    render(<OfflinePage />);
    expect(screen.getByText("You're Offline")).toBeDefined();
    expect(screen.getByText("Try Again")).toBeDefined();
  });
});
