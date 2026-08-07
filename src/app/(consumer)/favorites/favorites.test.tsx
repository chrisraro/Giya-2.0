import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import FavoritesPage from "./page";

vi.mock("@/features/favorites/server/repo", () => ({
  listMyFavorites: vi.fn().mockResolvedValue([
    {
      id: "fav-1",
      businessId: "biz-1",
      slug: "boba-shop",
      name: "Boba Shop",
      logoUrl: null,
      cityName: "Manila",
      businessTypeName: "Beverages",
    },
  ]),
}));

describe("FavoritesPage", () => {
  it("renders list of favorited businesses", async () => {
    const page = await FavoritesPage();
    render(page);

    expect(screen.getByText("Your Favorites")).toBeDefined();
    expect(screen.getByText("Boba Shop")).toBeDefined();
  });
});
