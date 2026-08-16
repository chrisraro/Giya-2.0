import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BusinessSummary } from "@/features/businesses/server/public-repo";
import type { BalanceDTO } from "@/features/rewards/types";

// /home shipped as a fully populated dashboard built from module-level
// fixtures: a person called "Mia" with 2,800 points across 4 businesses,
// rendered identically for every visitor including signed-out ones, while
// /wallet one tap away queried the real database and correctly reported
// nothing. These tests pin the fix - every figure on this page now comes from a
// read, the empty database renders as empty, and no fixture name can reach the
// DOM.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getMyConsumerProfile: vi.fn(),
  getMyBalances: vi.fn(),
  listActiveBusinesses: vi.fn(),
  getMyUnreadNotificationCount: vi.fn(),
  listPublicPromotions: vi.fn().mockResolvedValue([]),
  listMyFavorites: vi.fn().mockResolvedValue([]),
  redirect: vi.fn(),
}));

vi.mock("@/features/identity/server/repo", () => ({
  getMyConsumerProfile: mocks.getMyConsumerProfile,
}));
vi.mock("@/features/rewards/server/repo", () => ({
  getMyBalances: mocks.getMyBalances,
}));
vi.mock("@/features/businesses/server/public-repo", () => ({
  listActiveBusinesses: mocks.listActiveBusinesses,
}));
vi.mock("@/features/notifications/server/repo", () => ({
  getMyUnreadNotificationCount: mocks.getMyUnreadNotificationCount,
}));
vi.mock("@/features/promotions/server/repo", () => ({
  listPublicPromotions: mocks.listPublicPromotions,
}));
vi.mock("@/features/favorites/server/repo", () => ({
  listMyFavorites: mocks.listMyFavorites,
}));
vi.mock("next/navigation", () => ({
  // The real redirect() signals by throwing; throwing here is what stops the
  // page body from running, exactly as it would in Next.
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const HomePage = (await import("./page")).default;
const { HOME_DISCOVER_LIMIT } = await import("./limits");

/**
 * Every name and place the deleted fixtures used. If any of these ever appears
 * in this page's output again, a fixture has crept back into the render path.
 */
const FIXTURE_STRINGS = [
  "Mia",
  "Mia Santos",
  "Kape Diaria",
  "Cebu City",
  "Lola Nena's Bakeshop",
  "Chill Cup Milk Tea",
  "Tapsi ni Marco",
  "Seoul Grill PH",
  "2,800",
];

function balance(overrides: Partial<BalanceDTO> = {}): BalanceDTO {
  return {
    businessId: "3f1b0d9c-4444-4444-8444-444444444444",
    businessName: "Panaderia Mercedes",
    businessSlug: "panaderia-mercedes",
    pointsBalance: 1250,
    lifetimePoints: 4300,
    ...overrides,
  };
}

function summary(overrides: Partial<BusinessSummary> = {}): BusinessSummary {
  return {
    id: "7c2e5a1b-5555-4555-8555-555555555555",
    slug: "lugaw-republic",
    name: "Lugaw Republic",
    logoUrl: null,
    cityName: "Davao City",
    businessTypeName: "Carinderia",
    ...overrides,
  };
}

function signedInAs(displayName: string): void {
  mocks.getMyConsumerProfile.mockResolvedValue({
    userId: "user-1",
    displayName,
    email: "ana@example.com",
    cityName: "Davao City",
  });
}

async function renderHome(): Promise<void> {
  render(await HomePage());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  signedInAs("Ana Cruz");
  mocks.getMyBalances.mockResolvedValue([]);
  mocks.listActiveBusinesses.mockResolvedValue([]);
  mocks.getMyUnreadNotificationCount.mockResolvedValue(0);
  mocks.listPublicPromotions.mockResolvedValue([]);
  mocks.listMyFavorites.mockResolvedValue([]);
});

// T4.3 shipped 0065_favorites.sql, /favorites and the heart on /b/[slug], and
// then left /home with ZERO references to favorites - the one screen a consumer
// opens first. These pin the rail, and pin that the PAGE reaches it: a test that
// rendered <FavoritesRail /> on its own would have passed the whole time the
// rail was unreachable, which was the defect.
describe("/home favourites rail", () => {
  const favorite = {
    id: "fav-1",
    businessId: "biz-1",
    slug: "kalesa-coffee",
    name: "Kalesa Coffee",
    logoUrl: null,
    cityName: null,
    businessTypeName: null,
  };

  it("CRITICAL: the page renders the rail, linking each saved shop to its page", async () => {
    mocks.listMyFavorites.mockResolvedValue([favorite]);
    await renderHome();

    expect(screen.getByRole("heading", { name: "Your favorites" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Kalesa Coffee/ })).toHaveAttribute(
      "href",
      "/b/kalesa-coffee",
    );
  });

  it("offers the full list, since the rail only shows the first few", async () => {
    mocks.listMyFavorites.mockResolvedValue([favorite]);
    await renderHome();

    expect(screen.getByRole("link", { name: "See all favorites" })).toHaveAttribute(
      "href",
      "/favorites",
    );
  });

  it("shows nothing at all when the consumer has saved none, rather than an empty shell", async () => {
    await renderHome();

    expect(screen.queryByRole("heading", { name: "Your favorites" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "See all favorites" })).not.toBeInTheDocument();
  });

  // The deliberate call the brief asks to be named: on THIS page the rail
  // degrades and the page survives. /home's job is the points total, the
  // balance strip and the discover grid, and none of those has anything to do
  // with favourites; taking the whole screen down over an accelerator would be
  // a worse outcome than losing the accelerator. /favorites makes the opposite
  // call, because there the list IS the page.
  it("CRITICAL: a favourites read that throws costs the rail, not the rest of the page", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listMyFavorites.mockRejectedValue(new Error("permission denied for table favorites"));
    mocks.getMyBalances.mockResolvedValue([balance()]);

    await renderHome();

    expect(screen.getByText("across 1 business")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Panaderia Mercedes/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Your favorites" })).not.toBeInTheDocument();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

// The notifications slice put the inbox affordance in this header rather than
// in the bottom nav, which is full at MD3's five destinations. These pin the
// two things that decision has to get right: the badge only exists when there
// is something to say, and the count is legible to a screen reader.
describe("/home notification bell", () => {
  it("links to the inbox", async () => {
    await renderHome();

    expect(screen.getByRole("link", { name: /Notifications/ })).toHaveAttribute(
      "href",
      "/notifications",
    );
  });

  it("shows no count at all when nothing is unread", async () => {
    await renderHome();

    const bell = screen.getByRole("link", { name: "Notifications" });
    expect(bell.textContent).toBe("notifications");
  });

  it("carries the unread count in the accessible name, not only in the glyph", async () => {
    mocks.getMyUnreadNotificationCount.mockResolvedValue(3);
    await renderHome();

    expect(
      screen.getByRole("link", { name: "Notifications, 3 unread" }),
    ).toBeInTheDocument();
  });

  it("caps the visible badge at 99+ so a long backlog cannot widen the header", async () => {
    mocks.getMyUnreadNotificationCount.mockResolvedValue(412);
    await renderHome();

    expect(screen.getByText("99+")).toBeInTheDocument();
  });
});

describe("/home auth gate", () => {
  it("CRITICAL: an anonymous visitor is redirected to /login and never sees a page", async () => {
    mocks.getMyConsumerProfile.mockResolvedValue(null);

    await expect(HomePage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.redirect).toHaveBeenCalledWith("/login?next=%2Fhome");
  });

  it("does not read any personal data before it knows who is asking", async () => {
    mocks.getMyConsumerProfile.mockResolvedValue(null);

    await expect(HomePage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.getMyBalances).not.toHaveBeenCalled();
  });
});

describe("/home on real data", () => {
  beforeEach(() => {
    mocks.getMyBalances.mockResolvedValue([
      balance(),
      balance({
        businessId: "b2",
        businessName: "Sari Sari Co",
        businessSlug: "sari-sari-co",
        pointsBalance: 300,
        lifetimePoints: 900,
      }),
    ]);
    mocks.listActiveBusinesses.mockResolvedValue([summary()]);
  });

  it("greets the signed-in consumer by their real first name", async () => {
    signedInAs("Ana Cruz");
    await renderHome();

    expect(screen.getByText(/Magandang \w+, Ana$/)).toBeInTheDocument();
  });

  it("totals the real balances rather than a fixture figure", async () => {
    await renderHome();

    expect(screen.getByText("1,550")).toBeInTheDocument();
    expect(screen.getByText("across 2 businesses")).toBeInTheDocument();
  });

  it("says 'business' rather than 'businesses' for a single balance", async () => {
    mocks.getMyBalances.mockResolvedValue([balance()]);
    await renderHome();

    expect(screen.getByText("across 1 business")).toBeInTheDocument();
  });

  it("links each balance card to that business's page", async () => {
    await renderHome();

    expect(screen.getByRole("link", { name: /Panaderia Mercedes/ })).toHaveAttribute(
      "href",
      "/b/panaderia-mercedes",
    );
  });

  it("links each shop card to that shop's page", async () => {
    await renderHome();

    expect(screen.getByRole("link", { name: /Lugaw Republic/ })).toHaveAttribute(
      "href",
      "/b/lugaw-republic",
    );
  });

  it("CRITICAL: every card on the page is a link, so none of them is inert", async () => {
    await renderHome();

    // Two balance cards plus one shop card. The header's notification bell is
    // a link too and is deliberately excluded here: this assertion is about
    // the CARDS, and counting a header affordance among them would make it
    // fail the next time the shell grows one.
    const cards = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href") !== "/notifications");
    expect(cards).toHaveLength(3);
  });

  it("does not offer a shop the consumer already collects points at", async () => {
    mocks.listActiveBusinesses.mockResolvedValue([
      summary({ id: "3f1b0d9c-4444-4444-8444-444444444444", name: "Panaderia Mercedes" }),
      summary(),
    ]);
    await renderHome();

    // The shop section lists only Lugaw Republic; Panaderia Mercedes appears
    // once, in the balance strip.
    expect(screen.getAllByRole("link", { name: /Panaderia Mercedes/ })).toHaveLength(1);
  });

  it(`lists at most ${HOME_DISCOVER_LIMIT} shops`, async () => {
    mocks.listActiveBusinesses.mockResolvedValue(
      Array.from({ length: 12 }, (_unused, index) =>
        summary({ id: `shop-${index}`, slug: `shop-${index}`, name: `Shop ${index}` }),
      ),
    );
    await renderHome();

    expect(screen.getAllByRole("link", { name: /Shop \d+/ })).toHaveLength(HOME_DISCOVER_LIMIT);
  });

  it("renders a name-less greeting rather than a placeholder person", async () => {
    signedInAs("");
    await renderHome();

    expect(screen.getByText(/^Magandang \w+$/)).toBeInTheDocument();
  });

  it("CRITICAL: no fixture name reaches the DOM", async () => {
    const { container } = render(await HomePage());

    for (const fixture of FIXTURE_STRINGS) {
      expect(container.textContent).not.toContain(fixture);
    }
  });
});

describe("/home on an empty database", () => {
  it("tells a consumer with no points exactly what to do about it", async () => {
    await renderHome();

    expect(screen.getByText("No points yet")).toBeInTheDocument();
    expect(screen.getByText(/scan a receipt from a shop on Giya/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Scan a receipt" })).toHaveAttribute("href", "/scan");
  });

  it("CRITICAL: shows no points total at all rather than a hopeful zero dashboard", async () => {
    await renderHome();

    expect(screen.queryByText("Total points")).not.toBeInTheDocument();
    expect(screen.queryByText("across 0 businesses")).not.toBeInTheDocument();
  });

  it("says plainly that no shops are live yet", async () => {
    await renderHome();

    expect(screen.getByText("No shops yet")).toBeInTheDocument();
    expect(screen.getByText(/No shops are live on Giya right now/)).toBeInTheDocument();
  });

  it("CRITICAL: no fixture name reaches the DOM", async () => {
    const { container } = render(await HomePage());

    for (const fixture of FIXTURE_STRINGS) {
      expect(container.textContent).not.toContain(fixture);
    }
  });

  it("still greets the real consumer by name", async () => {
    signedInAs("Ana Cruz");
    await renderHome();

    expect(screen.getByText(/Magandang \w+, Ana$/)).toBeInTheDocument();
  });

  it("drops the shop section entirely when the consumer is already on every shop", async () => {
    mocks.getMyBalances.mockResolvedValue([balance()]);
    mocks.listActiveBusinesses.mockResolvedValue([
      summary({ id: "3f1b0d9c-4444-4444-8444-444444444444", name: "Panaderia Mercedes" }),
    ]);
    await renderHome();

    // "No shops yet" would be a lie here: there IS a shop, they are just
    // already collecting points at it.
    expect(screen.queryByText("No shops yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Shops on Giya")).not.toBeInTheDocument();
  });
});

describe("/home greeting clock", () => {
  it("uses the Manila hour, not the server's", async () => {
    vi.useFakeTimers();
    // 11:00 UTC is 7pm in Manila.
    vi.setSystemTime(new Date("2026-07-26T11:00:00Z"));
    signedInAs("Ana Cruz");

    await renderHome();

    expect(screen.getByText("Magandang gabi, Ana")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
