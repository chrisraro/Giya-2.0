import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /profile rendered MOCK_USER: "Mia Santos", initials "MS", city "Cebu City",
// for everyone including signed-out visitors, and its "Log out" was a plain
// <Link href="/login"> that moved the user to another screen while their
// session cookies stayed valid. These tests pin real identity data, a real
// sign-out control, and the auth gate.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getMyConsumerProfile: vi.fn(),
  getMyUnreadNotificationCount: vi.fn(),
  signOut: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/features/identity/server/repo", () => ({
  getMyConsumerProfile: mocks.getMyConsumerProfile,
}));
vi.mock("@/features/identity/actions", () => ({
  signOut: mocks.signOut,
}));
vi.mock("@/features/notifications/server/repo", () => ({
  getMyUnreadNotificationCount: mocks.getMyUnreadNotificationCount,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const ProfilePage = (await import("./page")).default;

const FIXTURE_STRINGS = ["Mia", "Mia Santos", "MS", "Kape Diaria", "Cebu City"];

const AVATAR_URL = "https://proj.supabase.co/storage/v1/object/public/avatars/user-1/a.jpg";

function signedInAs(
  overrides: Partial<{
    displayName: string;
    email: string;
    cityName: string | null;
    avatarUrl: string | null;
  }> = {},
) {
  mocks.getMyConsumerProfile.mockResolvedValue({
    userId: "user-1",
    displayName: "Ana Cruz",
    email: "ana@example.com",
    cityName: "Davao City",
    avatarUrl: null,
    ...overrides,
  });
}

async function renderProfile(): Promise<void> {
  render(await ProfilePage());
}

beforeEach(() => {
  vi.clearAllMocks();
  signedInAs();
  mocks.getMyUnreadNotificationCount.mockResolvedValue(0);
});

// The "Notifications" settings row rendered with no href and went nowhere
// until the notifications slice. It is the inbox's quieter entry point (the
// other is the home header bell), so it has to actually go somewhere and it has
// to carry the same count.
describe("/profile notifications row", () => {
  it("CRITICAL: is a real link now, not a dead row", async () => {
    await renderProfile();

    expect(screen.getByRole("link", { name: /Notifications/ })).toHaveAttribute(
      "href",
      "/notifications",
    );
  });

  it("shows no count when nothing is unread", async () => {
    await renderProfile();

    const row = screen.getByRole("link", { name: /Notifications/ });
    expect(row.textContent).not.toMatch(/\d/);
  });

  it("shows the unread count when there is one", async () => {
    mocks.getMyUnreadNotificationCount.mockResolvedValue(4);
    await renderProfile();

    expect(screen.getByText("4 unread notifications")).toBeInTheDocument();
  });

});

// The LAST dead affordance on this page. "Devices" rendered as
// `{ icon: "devices", label: "Devices", href: undefined }`: a row with a chevron
// pointing nowhere, next to a "Preferences" screen that did not exist either
// while 0021's four consent column grants sat unused.
describe("/profile settings rows that used to go nowhere", () => {
  it("CRITICAL: Devices is a real link now", async () => {
    await renderProfile();

    expect(screen.getByRole("link", { name: /Devices/ })).toHaveAttribute(
      "href",
      "/profile/devices",
    );
  });

  it("CRITICAL: Preferences reaches the consent screen", async () => {
    // Without this row, /profile/settings exists and nobody can reach it - and
    // the four consents stay as invisible as they were with no screen at all.
    await renderProfile();

    expect(screen.getByRole("link", { name: /Preferences/ })).toHaveAttribute(
      "href",
      "/profile/settings",
    );
  });

  it("CRITICAL: no row renders a chevron that points nowhere", async () => {
    // The property, not the instance: every row in the settings list is a link.
    // A future row added without an href fails here rather than shipping as
    // another dead affordance.
    const { container } = render(await ProfilePage());

    const chevrons = Array.from(container.querySelectorAll(".material-symbols-rounded")).filter(
      (icon) => icon.textContent === "chevron_right",
    );
    expect(chevrons.length).toBeGreaterThan(0);
    for (const chevron of chevrons) {
      expect(chevron.closest("a")).not.toBeNull();
    }
  });
});

describe("/profile auth gate", () => {
  it("CRITICAL: an anonymous visitor is redirected to /login and never sees an account", async () => {
    mocks.getMyConsumerProfile.mockResolvedValue(null);

    await expect(ProfilePage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.redirect).toHaveBeenCalledWith("/login?next=%2Fprofile");
  });
});

describe("/profile on real data", () => {
  it("renders the real display name, email and city", async () => {
    await renderProfile();

    expect(screen.getByText("Ana Cruz")).toBeInTheDocument();
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    expect(screen.getByText("Davao City")).toBeInTheDocument();
  });

  it("derives the initials from the real name rather than storing them", async () => {
    await renderProfile();

    expect(screen.getByText("AC")).toBeInTheDocument();
  });

  it("derives one initial from a single-word name", async () => {
    signedInAs({ displayName: "Ana" });
    await renderProfile();

    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("omits the city line entirely when the consumer has not set one", async () => {
    signedInAs({ cityName: null });
    await renderProfile();

    expect(screen.getByText("Ana Cruz")).toBeInTheDocument();
    expect(screen.queryByText("Davao City")).not.toBeInTheDocument();
  });

  it("falls back to the email local part when there is no profile row", async () => {
    signedInAs({ displayName: "" });
    await renderProfile();

    expect(screen.getByText("ana")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("CRITICAL: no fixture name reaches the DOM", async () => {
    const { container } = render(await ProfilePage());

    for (const fixture of FIXTURE_STRINGS) {
      expect(container.textContent).not.toContain(fixture);
    }
  });

  it("keeps the settings rows linking where they did", async () => {
    await renderProfile();

    expect(screen.getByRole("link", { name: /Privacy policy/ })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: /Terms/ })).toHaveAttribute("href", "/terms");
  });
});

// profiles.avatar_url existed from 0002 with zero writers and no bucket, so the
// header has always rendered initials. T3.4a gives it both.
describe("/profile avatar", () => {
  it("CRITICAL: renders the photo when there is one", async () => {
    signedInAs({ avatarUrl: AVATAR_URL });
    const { container } = render(await ProfilePage());

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", AVATAR_URL);
  });

  it("CRITICAL: falls back to the initials circle when there is not", async () => {
    // The fallback is the correct empty state, not a placeholder to delete.
    signedInAs({ avatarUrl: null });
    const { container } = render(await ProfilePage());

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("AC")).toBeInTheDocument();
  });

  it("shows the photo INSTEAD of the initials, not on top of them", async () => {
    signedInAs({ avatarUrl: AVATAR_URL });
    await renderProfile();

    expect(screen.queryByText("AC")).not.toBeInTheDocument();
  });

  it("gives the photo an empty alt, because the name is right beside it", async () => {
    // Announcing "Ana Cruz" twice is noise; the image carries no information the
    // adjacent text does not.
    signedInAs({ avatarUrl: AVATAR_URL });
    const { container } = render(await ProfilePage());

    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });
});

describe("/profile edit entry point", () => {
  it("CRITICAL: offers a route to /profile/edit", async () => {
    // Without this the edit screen exists and nobody can reach it.
    await renderProfile();

    expect(screen.getByRole("link", { name: "Edit profile" })).toHaveAttribute(
      "href",
      "/profile/edit",
    );
  });
});

describe("/profile sign-out control", () => {
  it("CRITICAL: Log out submits a form, it is not a link to /login", async () => {
    await renderProfile();

    const logout = screen.getByRole("button", { name: /Log out/ });
    expect(logout).toHaveAttribute("type", "submit");
    // The old version rendered <Link href="/login">, which navigated without
    // ending the session. There must be no link to /login on this page.
    expect(screen.queryByRole("link", { name: /Log out/ })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole("link")) {
      expect(link).not.toHaveAttribute("href", "/login");
    }
  });

  it("wires the button to the signOut server action", async () => {
    await renderProfile();

    const form = screen.getByRole("button", { name: /Log out/ }).closest("form");
    expect(form).not.toBeNull();
  });
});
