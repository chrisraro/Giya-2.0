import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Card } from "./card";
import { TextField } from "./text-field";
import { Chip } from "./chip";

describe("Card", () => {
  it("filled uses surface-container-highest, 12px radius", () => {
    render(<Card data-testid="c">x</Card>);
    const c = screen.getByTestId("c");
    expect(c.className).toContain("bg-surface-container-highest");
    expect(c.className).toContain("rounded-md3-md");
  });
});

describe("TextField", () => {
  it("renders label above input and helper text", () => {
    render(<TextField id="name" label="Business name" helperText="As registered with DTI" />);
    expect(screen.getByLabelText("Business name")).toBeInTheDocument();
    expect(screen.getByText("As registered with DTI")).toBeInTheDocument();
  });
  it("error state shows error text with role=alert", () => {
    render(<TextField id="tin" label="TIN" errorText="TIN is required" />);
    expect(screen.getByRole("alert")).toHaveTextContent("TIN is required");
  });
});

describe("Chip", () => {
  it("selected chip uses secondary-container", () => {
    render(<Chip label="Milk tea" selected />);
    expect(screen.getByRole("button").className).toContain("bg-secondary-container");
  });
});
