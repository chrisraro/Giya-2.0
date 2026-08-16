import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listMyFavorites: vi.fn() }));

vi.mock("@/features/favorites/server/repo", () => ({
  listMyFavorites: mocks.listMyFavorites,
}));

const FavoritesPage = (await import("./page")).default;

function favorite(overrides: Record<string, unknown> = {}) {
  return {
    id: "fav-1",
    businessId: "biz-1",
    slug: "boba-shop",
    name: "Boba Shop",
    logoUrl: null,
    cityName: "Manila",
    businessTypeName: "Beverages",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMyFavorites.mockResolvedValue([favorite()]);
});

describe("FavoritesPage", () => {
  it("renders list of favorited businesses", async () => {
    render(await FavoritesPage());

    expect(screen.getByText("Your Favorites")).toBeInTheDocument();
    expect(screen.getByText("Boba Shop")).toBeInTheDocument();
  });

  it("tells a consumer with none what to do about it", async () => {
    mocks.listMyFavorites.mockResolvedValue([]);
    render(await FavoritesPage());

    expect(screen.getByText("No favorites saved yet")).toBeInTheDocument();
  });

  // This page's ENTIRE job is the favourites list, so a read it cannot perform
  // has nothing honest left to render. The empty state here is a positive claim
  // ("you have saved none, here is how to save one") and printing it over a
  // failed read tells the consumer their saved shops do not exist. There is no
  // error.tsx under src/app, so this surfaces as Next's error page: less
  // pretty than the empty state and the only one of the two that is true.
  //
  // /home makes the opposite call for the same read, deliberately: see the
  // comment on its listMyFavorites call.
  it("CRITICAL: propagates a failed read instead of claiming the shelf is empty", async () => {
    mocks.listMyFavorites.mockRejectedValue(
      new Error("listMyFavorites: failed to load favorites: permission denied"),
    );

    await expect(FavoritesPage()).rejects.toThrow(/failed to load favorites/);
  });
});
