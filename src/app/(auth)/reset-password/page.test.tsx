import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ResetPasswordPage from "./page";

// This page's gate is the whole point of this file: reaching the
// new-password form must require evidence THIS browser just came through
// /auth/confirm's explicit verifyOtp({ type: "recovery" }) check - not
// merely that a session of any kind exists. The check itself now lives in
// GET /auth/recovery-status (its own route.test.ts covers the actual
// cookie logic); this page's only job is to ask it and render accordingly,
// so its test mocks `fetch`, not any Supabase claims/session shape. An
// earlier version of this gate inferred the answer from a session's `amr`
// claim, which turned out to have no "recovery" value at all (every
// email-OTP flow - recovery, invite, signup, magiclink - records as
// `amr: "otp"`), so it was replaced outright rather than patched.

const authMocks = vi.hoisted(() => ({
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

const fetchMock = vi.fn();

function recoveryStatusResponds(verified: boolean) {
  fetchMock.mockResolvedValue({
    json: async () => ({ data: { verified } }),
  });
}

beforeEach(() => {
  authMocks.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
  authMocks.signOut.mockReset().mockResolvedValue({ error: null });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  recoveryStatusResponds(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResetPasswordPage - recovery gate", () => {
  it("asks GET /auth/recovery-status on mount", async () => {
    render(<ResetPasswordPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/auth/recovery-status"));
  });

  it("shows the new-password form when recovery-status reports verified: true", async () => {
    recoveryStatusResponds(true);
    render(<ResetPasswordPage />);

    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeInTheDocument();
    expect(screen.queryByText("That link expired or was already used.")).not.toBeInTheDocument();
  });

  it("shows an expired-link message with a link back to /forgot-password when recovery-status reports verified: false", async () => {
    recoveryStatusResponds(false);
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

  it("does not stay stuck on a blank screen when the recovery-status check fails outright", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    render(<ResetPasswordPage />);

    expect(
      await screen.findByText("That link expired or was already used."),
    ).toBeInTheDocument();
  });
});

describe("ResetPasswordPage - form", () => {
  it("shows a validation error on empty submit and never calls updateUser", async () => {
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(authMocks.updateUser).not.toHaveBeenCalled();
  });

  it("updates the password, signs out the recovery session, and shows a confirmation with a sign-in link", async () => {
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
