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
  signOut: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/features/identity/server/repo", () => ({
  getMyConsumerProfile: mocks.getMyConsumerProfile,
}));
vi.mock("@/features/identity/actions", () => ({
  signOut: mocks.signOut,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const ProfilePage = (await import("./page")).default;

const FIXTURE_STRINGS = ["Mia", "Mia Santos", "MS", "Kape Diaria", "Cebu City"];

function signedInAs(overrides: Partial<{ displayName: string; email: string; cityName: string | null }> = {}) {
  mocks.getMyConsumerProfile.mockResolvedValue({
    userId: "user-1",
    displayName: "Ana Cruz",
    email: "ana@example.com",
    cityName: "Davao City",
    ...overrides,
  });
}

async function renderProfile(): Promise<void> {
  render(await ProfilePage());
}

beforeEach(() => {
  vi.clearAllMocks();
  signedInAs();
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
