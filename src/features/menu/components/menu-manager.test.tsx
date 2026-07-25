import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MenuManager } from "./menu-manager";
import * as actions from "../actions";
import type { ProductRow } from "../types";

vi.mock("../actions", () => ({
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  addVariant: vi.fn(),
  addAddon: vi.fn(),
  removeVariant: vi.fn(),
  removeAddon: vi.fn(),
  archiveCategory: vi.fn(),
  archiveProduct: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  reorderCategory: vi.fn(),
  toggleProductAvailability: vi.fn(),
}));

const business = { id: "business-1", slug: "test-cafe", name: "Test Cafe" };

const createdProduct: ProductRow = {
  id: "product-1",
  business_id: business.id,
  category_id: null,
  name: "Iced Latte",
  description: null,
  base_price_centavos: 12550,
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

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Iced Latte" } });
  fireEvent.change(screen.getByLabelText("Base price"), { target: { value: "125.50" } });
}

function addOneVariantRow(name: string, price: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
  const nameInput = document.querySelector<HTMLInputElement>("#product-variant-name-0");
  const priceInput = document.querySelector<HTMLInputElement>("#product-variant-price-0");
  if (!nameInput || !priceInput) throw new Error("variant row inputs not found");
  fireEvent.change(nameInput, { target: { value: name } });
  fireEvent.change(priceInput, { target: { value: price } });
}

describe("MenuManager create-product retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call createProduct again after a partial variant-add failure; retries via updateProduct/addVariant", async () => {
    vi.mocked(actions.createProduct).mockResolvedValue({ ok: true, data: createdProduct });
    vi.mocked(actions.addVariant)
      .mockResolvedValueOnce({ ok: false, message: "Network error, please retry." })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          id: "variant-1",
          business_id: business.id,
          product_id: createdProduct.id,
          name: "Large",
          price_centavos: 2000,
          is_available: true,
          sort: 0,
          deleted_at: null,
          created_at: "",
          updated_at: "",
        } as never,
      });
    vi.mocked(actions.updateProduct).mockResolvedValue({ ok: true, data: createdProduct });

    render(
      <MenuManager
        business={business}
        categories={[]}
        products={[]}
        variantsByProduct={{}}
        addonsByProduct={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add product" }));
    fillRequiredFields();
    addOneVariantRow("Large", "20");

    fireEvent.click(screen.getByRole("button", { name: "Save product" }));

    // The variant add fails; createProduct has already run exactly once,
    // and the failure surfaces as a server error instead of silently
    // leaving the dialog in a state that would recreate the product.
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error, please retry.");
    expect(actions.createProduct).toHaveBeenCalledTimes(1);
    expect(actions.updateProduct).not.toHaveBeenCalled();

    // Retry: the dialog is still open (now pointed at the real product id
    // createProduct returned). Submitting again must go through
    // updateProduct + addVariant, never a second createProduct call.
    fireEvent.click(screen.getByRole("button", { name: "Save product" }));

    await waitFor(() => expect(actions.updateProduct).toHaveBeenCalledTimes(1));
    expect(actions.updateProduct).toHaveBeenCalledWith(
      expect.objectContaining({ productId: createdProduct.id }),
    );
    expect(actions.addVariant).toHaveBeenCalledTimes(2);
    expect(actions.createProduct).toHaveBeenCalledTimes(1);
  });
});
