import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { PublicMenu } from "./public-menu";
import type { PublicCategory } from "@/features/businesses/server/public-repo";

describe("PublicMenu", () => {
  it("shows the empty state when there are no categories", () => {
    render(<PublicMenu categories={[]} />);

    expect(screen.getByText("This store has not added a menu yet.")).toBeInTheDocument();
  });

  it("shows the empty state when every category has no public products", () => {
    const categories: PublicCategory[] = [
      { id: "cat-1", name: "Drinks", description: null, products: [] },
    ];

    render(<PublicMenu categories={categories} />);

    expect(screen.getByText("This store has not added a menu yet.")).toBeInTheDocument();
  });

  it("renders a category heading and its product with a plain price when there are no variants", () => {
    const categories: PublicCategory[] = [
      {
        id: "cat-1",
        name: "Drinks",
        description: null,
        products: [
          {
            id: "prod-1",
            name: "Iced Latte",
            description: "Cold brew latte",
            basePriceCentavos: 12000,
            status: "active",
            variants: [],
            addons: [],
          },
        ],
      },
    ];

    render(<PublicMenu categories={categories} />);

    expect(screen.getByRole("heading", { name: "Drinks" })).toBeInTheDocument();
    expect(screen.getByText("Iced Latte")).toBeInTheDocument();
    expect(screen.getByText("Cold brew latte")).toBeInTheDocument();
    expect(screen.getByText("₱120.00")).toBeInTheDocument();
    expect(screen.queryByText("Sold out")).not.toBeInTheDocument();
  });

  it("shows a 'From <lowest price>' label and variant chips when variants exist", () => {
    const categories: PublicCategory[] = [
      {
        id: "cat-1",
        name: "Drinks",
        description: null,
        products: [
          {
            id: "prod-1",
            name: "Iced Latte",
            description: null,
            basePriceCentavos: 12000,
            status: "active",
            variants: [
              { id: "var-1", name: "Small", priceCentavos: 9000 },
              { id: "var-2", name: "Large", priceCentavos: 15000 },
            ],
            addons: [],
          },
        ],
      },
    ];

    render(<PublicMenu categories={categories} />);

    expect(screen.getByText("From ₱90.00")).toBeInTheDocument();
    expect(screen.getByText("Small")).toBeInTheDocument();
    expect(screen.getByText("Large")).toBeInTheDocument();
  });

  it("renders sold-out styling and a Sold out badge for a sold_out product", () => {
    const categories: PublicCategory[] = [
      {
        id: "cat-1",
        name: "Drinks",
        description: null,
        products: [
          {
            id: "prod-1",
            name: "Iced Latte",
            description: null,
            basePriceCentavos: 12000,
            status: "sold_out",
            variants: [],
            addons: [],
          },
        ],
      },
    ];

    render(<PublicMenu categories={categories} />);

    expect(screen.getByText("Sold out")).toBeInTheDocument();
    const card = screen.getByText("Iced Latte").closest("li");
    expect(card).toHaveClass("opacity-60");
  });

  it("only renders categories that have at least one visible product", () => {
    const categories: PublicCategory[] = [
      { id: "cat-1", name: "Drinks", description: null, products: [] },
      {
        id: "cat-2",
        name: "Snacks",
        description: null,
        products: [
          {
            id: "prod-2",
            name: "Fries",
            description: null,
            basePriceCentavos: 8000,
            status: "active",
            variants: [],
            addons: [],
          },
        ],
      },
    ];

    render(<PublicMenu categories={categories} />);

    expect(screen.queryByRole("heading", { name: "Drinks" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Snacks" })).toBeInTheDocument();
  });
});
