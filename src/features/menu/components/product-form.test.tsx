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

  it("defaults the category select to defaultCategoryId when creating a new product", () => {
    render(
      <ProductForm
        categories={[{ id: "cat-1", name: "Drinks" }]}
        defaultCategoryId="cat-1"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("cat-1");
  });

  it("ignores defaultCategoryId when editing an existing product", () => {
    const product = {
      id: "product-1",
      business_id: "business-1",
      category_id: "cat-2",
      name: "Iced Latte",
      description: null,
      base_price_centavos: 12000,
      status: "active",
      is_available: true,
      images: [],
      availability: {},
      sort: 0,
      deleted_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      created_by: null,
      updated_by: null,
      search_tsv: null as unknown as never,
    };

    render(
      <ProductForm
        categories={[
          { id: "cat-1", name: "Drinks" },
          { id: "cat-2", name: "Snacks" },
        ]}
        product={product as never}
        defaultCategoryId="cat-1"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByLabelText("Category") as HTMLSelectElement).value).toBe("cat-2");
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
