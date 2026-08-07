import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import MaintenancePage from "./page";

describe("MaintenancePage", () => {
  it("renders maintenance mode screen", () => {
    render(<MaintenancePage />);
    expect(screen.getByText("System Maintenance")).toBeDefined();
  });
});
