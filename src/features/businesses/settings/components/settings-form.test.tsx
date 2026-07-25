import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { SettingsForm } from "./settings-form";
import * as actions from "../actions";
import type { BusinessProfileView } from "../types";

vi.mock("../actions", () => ({
  saveBusinessProfile: vi.fn(),
}));

function profile(overrides: Partial<BusinessProfileView> = {}): BusinessProfileView {
  return {
    name: "Kape Diaria",
    description: "Neighbourhood coffee",
    phone: "+63 900 000 0000",
    email: "hello@kapediaria.ph",
    website: "https://kapediaria.ph",
    socials: { facebook: "https://facebook.com/kapediaria", instagram: null, tiktok: null },
    addressLine: "12 Real Street",
    barangay: "San Jose",
    postalCode: "5000",
    openingHours: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
      day,
      open: "09:00",
      close: "21:00",
      closed: day === 7,
    })),
    readOnly: {
      slug: "kape-diaria",
      status: "active",
      verifiedAt: "2026-06-01T00:00:00.000Z",
      plan: "free",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsForm: what it renders", () => {
  it("prefills every editable presentation field from the stored profile", () => {
    render(<SettingsForm profile={profile()} />);

    expect(screen.getByLabelText("Business name")).toHaveValue("Kape Diaria");
    expect(screen.getByLabelText("Description")).toHaveValue("Neighbourhood coffee");
    expect(screen.getByLabelText("Phone")).toHaveValue("+63 900 000 0000");
    expect(screen.getByLabelText("Email")).toHaveValue("hello@kapediaria.ph");
    expect(screen.getByLabelText("Website")).toHaveValue("https://kapediaria.ph");
    expect(screen.getByLabelText("Facebook")).toHaveValue("https://facebook.com/kapediaria");
    expect(screen.getByLabelText("Street address")).toHaveValue("12 Real Street");
    expect(screen.getByLabelText("Barangay")).toHaveValue("San Jose");
    expect(screen.getByLabelText("Postal code")).toHaveValue("5000");
  });

  it("renders a full week of hours, so no day is silently missing", () => {
    render(<SettingsForm profile={profile()} />);

    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      expect(screen.getByText(day)).toBeInTheDocument();
    }
  });

  it("shows status, plan and slug as read-only context, with no input for them", () => {
    render(<SettingsForm profile={profile()} />);

    expect(screen.getByText("giya.ph/kape-diaria")).toBeInTheDocument();
    expect(screen.getByText(/Verified and live/)).toBeInTheDocument();
    expect(screen.getByText(/set by Giya, so they are not/i)).toBeInTheDocument();

    for (const label of ["Status", "Plan", "Web address", "Slug", "Verified at"]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
  });

  it("says the map pin is not editable here rather than offering raw coordinates", () => {
    render(<SettingsForm profile={profile()} />);

    expect(screen.queryByLabelText("Latitude")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Longitude")).not.toBeInTheDocument();
    expect(screen.getByText(/map picker/i)).toBeInTheDocument();
  });
});

describe("SettingsForm: saving", () => {
  it("submits exactly the presentation payload, with no status, verified_at or plan key", async () => {
    vi.mocked(actions.saveBusinessProfile).mockResolvedValue({ ok: true });
    render(<SettingsForm profile={profile()} />);

    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "Kape Diaria PH" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(actions.saveBusinessProfile).toHaveBeenCalledTimes(1));

    const payload = vi.mocked(actions.saveBusinessProfile).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.name).toBe("Kape Diaria PH");
    expect(Object.keys(payload).sort()).toEqual([
      "addressLine",
      "barangay",
      "description",
      "email",
      "facebook",
      "instagram",
      "name",
      "openingHours",
      "phone",
      "postalCode",
      "tiktok",
      "website",
    ]);
    for (const forbidden of ["status", "verified_at", "plan", "plan_limits", "slug", "businessId"]) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it("sends all seven weekday rows so the stored value is always a full week", async () => {
    vi.mocked(actions.saveBusinessProfile).mockResolvedValue({ ok: true });
    render(<SettingsForm profile={profile()} />);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(actions.saveBusinessProfile).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(actions.saveBusinessProfile).mock.calls[0]?.[0] as {
      openingHours: { day: number }[];
    };
    expect(payload.openingHours.map((entry) => entry.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("copies Monday's hours to every other day on request", async () => {
    vi.mocked(actions.saveBusinessProfile).mockResolvedValue({ ok: true });
    render(<SettingsForm profile={profile()} />);

    fireEvent.change(screen.getByLabelText("Monday opening time"), { target: { value: "07:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy Monday to every day" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(actions.saveBusinessProfile).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(actions.saveBusinessProfile).mock.calls[0]?.[0] as {
      openingHours: { open: string }[];
    };
    expect(payload.openingHours.every((entry) => entry.open === "07:30")).toBe(true);
  });

  it("refuses an invalid email before it reaches the server", async () => {
    render(<SettingsForm profile={profile()} />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Enter a valid email address");
    expect(actions.saveBusinessProfile).not.toHaveBeenCalled();
  });

  it("refuses a link with no scheme before it reaches the server", async () => {
    render(<SettingsForm profile={profile()} />);

    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "kapediaria.ph" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Links must start with http:// or https://");
    expect(actions.saveBusinessProfile).not.toHaveBeenCalled();
  });

  it("refuses an empty business name", async () => {
    render(<SettingsForm profile={profile()} />);

    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Your business needs a name");
    expect(actions.saveBusinessProfile).not.toHaveBeenCalled();
  });

  it("confirms a successful save", async () => {
    vi.mocked(actions.saveBusinessProfile).mockResolvedValue({ ok: true });
    render(<SettingsForm profile={profile()} />);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
  });

  it("shows the server's refusal rather than claiming success", async () => {
    vi.mocked(actions.saveBusinessProfile).mockResolvedValue({
      ok: false,
      message: "Only an owner or manager can edit business details.",
    });
    render(<SettingsForm profile={profile()} />);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only an owner or manager can edit business details.",
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
