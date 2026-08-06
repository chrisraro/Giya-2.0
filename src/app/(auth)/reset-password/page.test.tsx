import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ResetPasswordPage from "./page";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: authMocks }),
}));

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abcdefghijklmnopqrstuvwxyz",
    NEXT_PUBLIC_HCAPTCHA_SITE_KEY: undefined,
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

beforeEach(() => {
  authMocks.getSession.mockReset();
  authMocks.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
  authMocks.signOut.mockReset().mockResolvedValue({ error: null });
});

describe("ResetPasswordPage", () => {
  it("shows an expired-link message with a link back to /forgot-password when there is no recovery session", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session: null } });
    render(<ResetPasswordPage />);

    expect(
      await screen.findByText("That link expired or was already used."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("shows the new-password form when a recovery session is present", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    render(<ResetPasswordPage />);

    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeInTheDocument();
    expect(screen.queryByText("That link expired or was already used.")).not.toBeInTheDocument();
  });

  it("shows a validation error on empty submit and never calls updateUser", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(authMocks.updateUser).not.toHaveBeenCalled();
  });

  it("updates the password, signs out the recovery session, and shows a confirmation with a sign-in link", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "newSecret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => expect(authMocks.updateUser).toHaveBeenCalledWith({ password: "newSecret123" }));
    await waitFor(() => expect(authMocks.signOut).toHaveBeenCalled());

    expect(await screen.findByText("Password updated")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("shows updateUser's error message inline and does not sign out or advance past the form", async () => {
    authMocks.getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    authMocks.updateUser.mockResolvedValueOnce({
      data: {},
      error: { message: "Password should be at least 6 characters" },
    });
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(
      await screen.findByText("Password should be at least 6 characters"),
    ).toBeInTheDocument();
    expect(authMocks.signOut).not.toHaveBeenCalled();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
  });
});
