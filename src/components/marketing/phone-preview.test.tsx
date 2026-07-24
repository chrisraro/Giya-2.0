import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PhonePreview } from "./phone-preview";

describe("PhonePreview", () => {
  it("shows a points balance and reward badge from real components", () => {
    render(<PhonePreview />);
    expect(screen.getByText("1,250 pts")).toBeInTheDocument();
    expect(screen.getByText("+120 pts")).toBeInTheDocument();
    expect(screen.getByText("Kape Diaria")).toBeInTheDocument();
  });
});
