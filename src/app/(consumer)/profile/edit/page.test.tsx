import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// /profile/edit is a server component around one client island. These pin the
// two things only the PAGE can get wrong: the auth gate, and handing the island
// the caller's real values rather than blanks.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getMyConsumerProfile: vi.fn(),
  redirect: vi.fn(),
  formProps: vi.fn(),
}));

vi.mock("@/features/identity/server/repo", () => ({
  getMyConsumerProfile: mocks.getMyConsumerProfile,
}));

vi.mock("@/features/identity/components/profile-edit-form", () => ({
  ProfileEditForm: (props: Record<string, unknown>) => {
    mocks.formProps(props);
    return <div data-testid="edit-form" />;
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const ProfileEditPage = (await import("./page")).default;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMyConsumerProfile.mockResolvedValue({
    userId: "user-1",
    displayName: "Ana Cruz",
    email: "ana@example.com",
    cityName: "Davao City",
    avatarUrl: null,
  });
});

describe("/profile/edit", () => {
  it("CRITICAL: an anonymous visitor is redirected to /login and never sees an edit form", async () => {
    mocks.getMyConsumerProfile.mockResolvedValue(null);

    await expect(ProfileEditPage()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mocks.redirect).toHaveBeenCalledWith("/login?next=%2Fprofile%2Fedit");
  });

  it("CRITICAL: hands the form the consumer's current values", async () => {
    render(await ProfileEditPage());

    expect(mocks.formProps).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Ana Cruz",
        cityName: "Davao City",
        avatarUrl: null,
      }),
    );
  });

  it("passes the avatar through when there is one", async () => {
    const url = "https://proj.supabase.co/storage/v1/object/public/avatars/user-1/a.jpg";
    mocks.getMyConsumerProfile.mockResolvedValue({
      userId: "user-1",
      displayName: "Ana Cruz",
      email: "ana@example.com",
      cityName: null,
      avatarUrl: url,
    });

    render(await ProfileEditPage());

    expect(mocks.formProps).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: url }));
  });

  it("CRITICAL: offers a route back to /profile", async () => {
    // A screen that can only be left with the browser's back button is a screen
    // somebody gets stuck on inside an installed PWA shell.
    render(await ProfileEditPage());

    expect(screen.getByRole("link", { name: /Profile/ })).toHaveAttribute("href", "/profile");
  });

  it("names itself", async () => {
    render(await ProfileEditPage());

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Edit profile");
  });

  it("renders the form", async () => {
    render(await ProfileEditPage());

    expect(screen.getByTestId("edit-form")).toBeInTheDocument();
  });

  it("CRITICAL: is never cached across people", async () => {
    // It renders the caller's own name, city and photo.
    const { dynamic } = await import("./page");
    expect(dynamic).toBe("force-dynamic");
  });
});
