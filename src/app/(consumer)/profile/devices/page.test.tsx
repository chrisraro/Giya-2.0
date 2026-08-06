import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /profile/devices. The "Devices" row on /profile has pointed at nothing since
// it was written - `{ icon: "devices", label: "Devices", href: undefined }` -
// and `user_devices` had no reader in the whole codebase. This is both halves.
//
// THE ASSERTION THIS FILE EXISTS FOR: empty is not failed. A consumer with no
// registered devices and a consumer whose query timed out must never see the
// same screen, because "no devices" reads as "nothing is signed in anywhere",
// which is a claim about their account's security that a failed read has no
// business making. This codebase has shipped that exact conflation twice.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getMyConsumerProfile: vi.fn(),
  listMyDevices: vi.fn(),
  revokeDevice: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/features/identity/server/repo", () => ({
  getMyConsumerProfile: mocks.getMyConsumerProfile,
}));
vi.mock("@/features/identity/server/devices", () => ({
  listMyDevices: mocks.listMyDevices,
}));
vi.mock("@/features/identity/actions", () => ({
  revokeDevice: mocks.revokeDevice,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const DevicesPage = (await import("./page")).default;

const DEVICES = [
  { id: "device-1", summary: "Chrome on Windows", lastSeen: "1 hour ago", isCurrent: true },
  { id: "device-2", summary: "Safari on iPhone", lastSeen: "2 days ago", isCurrent: false },
];

async function renderDevices(): Promise<void> {
  render(await DevicesPage());
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
  mocks.listMyDevices.mockResolvedValue({ ok: true, devices: DEVICES });
});

describe("/profile/devices auth gate", () => {
  it("CRITICAL: an anonymous visitor is redirected to /login", async () => {
    mocks.getMyConsumerProfile.mockResolvedValue(null);

    await expect(DevicesPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.redirect).toHaveBeenCalledWith("/login?next=%2Fprofile%2Fdevices");
  });

  it("does not read anybody's devices without a session", async () => {
    mocks.getMyConsumerProfile.mockResolvedValue(null);

    await expect(DevicesPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.listMyDevices).not.toHaveBeenCalled();
  });
});

describe("/profile/devices with devices", () => {
  it("lists them by readable summary", async () => {
    await renderDevices();

    expect(screen.getByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
  });

  it("offers the way back to /profile", async () => {
    await renderDevices();

    expect(screen.getByRole("link", { name: /Profile/ })).toHaveAttribute("href", "/profile");
  });
});

describe("/profile/devices with none", () => {
  it("CRITICAL: renders an empty state, and it is not an error", async () => {
    mocks.listMyDevices.mockResolvedValue({ ok: true, devices: [] });

    await renderDevices();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/No devices yet/i)).toBeInTheDocument();
  });

  it("explains why the list can be empty rather than implying something broke", async () => {
    mocks.listMyDevices.mockResolvedValue({ ok: true, devices: [] });

    await renderDevices();

    expect(screen.getByText(/next time you sign in/i)).toBeInTheDocument();
  });
});

describe("/profile/devices when the read failed", () => {
  it("CRITICAL: does NOT render the empty state", async () => {
    // Telling somebody they have no registered devices when the query timed out
    // invites them to conclude nothing is signed in anywhere.
    mocks.listMyDevices.mockResolvedValue({ ok: false });

    await renderDevices();

    expect(screen.queryByText(/No devices yet/i)).not.toBeInTheDocument();
  });

  it("CRITICAL: says the read failed, in an announced region", async () => {
    mocks.listMyDevices.mockResolvedValue({ ok: false });

    await renderDevices();

    const alert = screen.getByRole("alert");
    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    expect(alert.textContent).toMatch(/could not load your devices/i);
  });

  it("CRITICAL: the empty screen and the failed screen do not share a word of copy", async () => {
    // The point of the distinction is that the two READ differently.
    mocks.listMyDevices.mockResolvedValue({ ok: true, devices: [] });
    const empty = render(await DevicesPage()).container.textContent ?? "";

    mocks.listMyDevices.mockResolvedValue({ ok: false });
    const failed = render(await DevicesPage()).container.textContent ?? "";

    expect(empty).not.toBe(failed);
    expect(failed).not.toMatch(/No devices yet/i);
    expect(empty).not.toMatch(/could not load/i);
  });

  it("renders no remove controls at all", async () => {
    mocks.listMyDevices.mockResolvedValue({ ok: false });

    await renderDevices();

    expect(screen.queryAllByRole("button", { name: /Remove/ })).toHaveLength(0);
  });
});
