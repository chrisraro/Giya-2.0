import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /profile/settings - the screen 0021's header has been waiting for. Its comment
// on the four consent column grants reads "the profile settings screen edits
// them"; the grants shipped and the screen did not.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getMyConsumerProfile: vi.fn(),
  getMyConsents: vi.fn(),
  saveConsent: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/features/identity/server/repo", () => ({
  getMyConsumerProfile: mocks.getMyConsumerProfile,
  getMyConsents: mocks.getMyConsents,
}));
vi.mock("@/features/identity/actions", () => ({
  saveConsent: mocks.saveConsent,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const SettingsPage = (await import("./page")).default;

const ALL_ON = {
  marketing_opt_in: true,
  push_enabled: true,
  email_enabled: true,
  gps_fraud_opt_in: true,
};

async function renderSettings(): Promise<void> {
  render(await SettingsPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMyConsumerProfile.mockResolvedValue({
    userId: "user-1",
    displayName: "Ana Cruz",
    email: "ana@example.com",
    cityName: "Davao City",
    avatarUrl: null,
  });
  mocks.getMyConsents.mockResolvedValue({ ok: true, consents: ALL_ON });
});

describe("/profile/settings auth gate", () => {
  it("CRITICAL: an anonymous visitor is redirected to /login and never sees consents", async () => {
    mocks.getMyConsumerProfile.mockResolvedValue(null);

    await expect(SettingsPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.redirect).toHaveBeenCalledWith("/login?next=%2Fprofile%2Fsettings");
  });

  it("does not even read the consents for a visitor with no session", async () => {
    mocks.getMyConsumerProfile.mockResolvedValue(null);

    await expect(SettingsPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.getMyConsents).not.toHaveBeenCalled();
  });
});

describe("/profile/settings on a good read", () => {
  it("renders the four consent switches", async () => {
    await renderSettings();

    expect(screen.getAllByRole("switch")).toHaveLength(4);
  });

  it("hands the stored values through rather than re-deriving them", async () => {
    mocks.getMyConsents.mockResolvedValue({
      ok: true,
      consents: { ...ALL_ON, marketing_opt_in: false },
    });

    await renderSettings();

    expect(screen.getByRole("switch", { name: "Marketing messages" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Push notifications" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("offers the way back to /profile", async () => {
    // A screen that can only be left with the browser's back button is a screen
    // somebody gets stuck on inside a PWA shell.
    await renderSettings();

    expect(screen.getByRole("link", { name: /Profile/ })).toHaveAttribute("href", "/profile");
  });
});

describe("/profile/settings on a failed read", () => {
  it("CRITICAL: renders an error, NOT four switches that all say off", async () => {
    // Empty is not failed. Four un-ticked switches would tell a consumer their
    // consents are all off, and the obvious next tap writes that over whatever
    // the database really holds. Same conflation that shipped in getMyBalances
    // and in the metrics loader.
    mocks.getMyConsents.mockResolvedValue({ ok: false });

    await renderSettings();

    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("CRITICAL: says so, in an announced region", async () => {
    mocks.getMyConsents.mockResolvedValue({ ok: false });

    await renderSettings();

    const alert = screen.getByRole("alert");
    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(alert.textContent).toMatch(/could not load your preferences/i);
  });

  it("still offers the way back rather than stranding the consumer", async () => {
    mocks.getMyConsents.mockResolvedValue({ ok: false });

    await renderSettings();

    expect(screen.getByRole("link", { name: /Profile/ })).toHaveAttribute("href", "/profile");
  });
});
