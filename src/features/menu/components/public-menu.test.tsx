import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";

import { PublicMenu } from "./public-menu";
import type { PublicMenuGroup } from "@/features/businesses/server/public-repo";

describe("PublicMenu", () => {
  it("shows the empty state when there are no groups", () => {
    render(<PublicMenu groups={[]} />);

    expect(screen.getByText("This store has not added a menu yet.")).toBeInTheDocument();
  });

  it("shows the empty state when every group has no public products", () => {
    const groups: PublicMenuGroup[] = [
      { category: { id: "cat-1", name: "Drinks", description: null }, products: [] },
    ];

    render(<PublicMenu groups={groups} />);

    expect(screen.getByText("This store has not added a menu yet.")).toBeInTheDocument();
  });

  it("renders a category heading and its product with a plain price when there are no variants", () => {
    const groups: PublicMenuGroup[] = [
      {
        category: { id: "cat-1", name: "Drinks", description: null },
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

    render(<PublicMenu groups={groups} />);

    expect(screen.getByRole("heading", { name: "Drinks" })).toBeInTheDocument();
    expect(screen.getByText("Iced Latte")).toBeInTheDocument();
    expect(screen.getByText("Cold brew latte")).toBeInTheDocument();
    expect(screen.getByText("₱120.00")).toBeInTheDocument();
    expect(screen.queryByText("Sold out")).not.toBeInTheDocument();
  });

  it("shows a 'From <lowest price>' label and variant chips when variants exist", () => {
    const groups: PublicMenuGroup[] = [
      {
        category: { id: "cat-1", name: "Drinks", description: null },
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

    render(<PublicMenu groups={groups} />);

    expect(screen.getByText("From ₱90.00")).toBeInTheDocument();
    expect(screen.getByText("Small")).toBeInTheDocument();
    expect(screen.getByText("Large")).toBeInTheDocument();
  });

  it("renders sold-out styling and a Sold out badge for a sold_out product", () => {
    const groups: PublicMenuGroup[] = [
      {
        category: { id: "cat-1", name: "Drinks", description: null },
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

    render(<PublicMenu groups={groups} />);

    expect(screen.getByText("Sold out")).toBeInTheDocument();
    const card = screen.getByText("Iced Latte").closest("li");
    expect(card).toHaveClass("opacity-60");
  });

  it("only renders groups that have at least one visible product", () => {
    const groups: PublicMenuGroup[] = [
      { category: { id: "cat-1", name: "Drinks", description: null }, products: [] },
      {
        category: { id: "cat-2", name: "Snacks", description: null },
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

    render(<PublicMenu groups={groups} />);

    expect(screen.queryByRole("heading", { name: "Drinks" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Snacks" })).toBeInTheDocument();
  });

  it("renders an uncategorized product under a trailing 'More' heading, after named categories", () => {
    const groups: PublicMenuGroup[] = [
      {
        category: { id: "cat-1", name: "Drinks", description: null },
        products: [
          {
            id: "prod-1",
            name: "Iced Latte",
            description: null,
            basePriceCentavos: 12000,
            status: "active",
            variants: [],
            addons: [],
          },
        ],
      },
      {
        category: null,
        products: [
          {
            id: "prod-2",
            name: "Loose Chips",
            description: null,
            basePriceCentavos: 5000,
            status: "active",
            variants: [],
            addons: [],
          },
        ],
      },
    ];

    render(<PublicMenu groups={groups} />);

    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings).toEqual(["Drinks", "More"]);
    expect(screen.getByText("Loose Chips")).toBeInTheDocument();
  });

  it("does not render a 'More' heading when the uncategorized group has no products", () => {
    const groups: PublicMenuGroup[] = [
      { category: { id: "cat-1", name: "Drinks", description: null }, products: [] },
      { category: null, products: [] },
    ];

    render(<PublicMenu groups={groups} />);

    expect(screen.getByText("This store has not added a menu yet.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "More" })).not.toBeInTheDocument();
  });
});
