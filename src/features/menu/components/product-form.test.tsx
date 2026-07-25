import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ProductForm } from "./product-form";

describe("ProductForm validation", () => {
  it("shows required-field errors when submitted empty", async () => {
    render(<ProductForm categories={[]} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Save product" }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(await screen.findByText("Price is required")).toBeInTheDocument();
  });

  it("shows an error for a price that can't be parsed instead of calling onSubmit", async () => {
    const onSubmit = vi.fn();
    render(<ProductForm categories={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Iced Latte" } });
    fireEvent.change(screen.getByLabelText("Base price"), { target: { value: "not-a-price" } });
    fireEvent.click(screen.getByRole("button", { name: "Save product" }));

    expect(await screen.findByText("Enter a valid price")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("parses a valid peso price into integer centavos on submit", async () => {
    const onSubmit = vi.fn();
    render(<ProductForm categories={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Iced Latte" } });
    fireEvent.change(screen.getByLabelText("Base price"), { target: { value: "125.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save product" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Iced Latte",
        basePriceCentavos: 12550,
        categoryId: null,
        status: "active",
        images: [],
        variants: [],
        addons: [],
      }),
    );
  });

  it("rejects a price with more than two decimal digits", async () => {
    const onSubmit = vi.fn();
    render(<ProductForm categories={[]} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Iced Latte" } });
    fireEvent.change(screen.getByLabelText("Base price"), { target: { value: "10.005" } });
    fireEvent.click(screen.getByRole("button", { name: "Save product" }));

    expect(await screen.findByText("Enter a valid price")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
