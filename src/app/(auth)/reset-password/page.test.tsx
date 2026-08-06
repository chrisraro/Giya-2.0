import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ResetPasswordPage from "./page";

// This page's gate is the whole point of this file: reaching the
// new-password form must require evidence THIS browser just came through
// /auth/confirm's explicit verifyOtp({ type: "recovery" }) check - not
// merely that a session of any kind exists. The check itself now lives in
// GET /auth/recovery-status (its own route.test.ts covers the actual
// cookie logic); this page's only job is to ask it and render accordingly.
//
// The actual password update no longer happens client-side either: it POSTs
// to /api/v1/auth/reset-password (its own route.test.ts covers the
// authorization - the recovery cookie check and its clearing on success).
// This page mocks `fetch` for both, keyed by URL, rather than mocking
// Supabase's updateUser/claims/session shapes directly.

const authMocks = vi.hoisted(() => ({
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

let recoveryVerified = true;
let updateResponse: { ok: boolean; status: number; json: () => Promise<unknown> };

function recoveryStatusResponds(verified: boolean) {
  recoveryVerified = verified;
}

function updatePasswordResponds(status: number, body: unknown) {
  updateResponse = { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  authMocks.signOut.mockReset().mockResolvedValue({ error: null });
  recoveryVerified = true;
  updatePasswordResponds(200, { data: { message: "Password updated." } });
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url === "/auth/recovery-status") {
      return { json: async () => ({ data: { verified: recoveryVerified } }) };
    }
    if (url === "/api/v1/auth/reset-password") {
      return updateResponse;
    }
    throw new Error(`Unexpected fetch call in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
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
    fetchMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    render(<ResetPasswordPage />);

    expect(
      await screen.findByText("That link expired or was already used."),
    ).toBeInTheDocument();
  });
});

describe("ResetPasswordPage - form", () => {
  it("shows a validation error on empty submit and never POSTs the reset", async () => {
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/v1/auth/reset-password",
      expect.anything(),
    );
  });

  it("POSTs the new password, signs out the recovery session, and shows a confirmation with a sign-in link", async () => {
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "newSecret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/auth/reset-password",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ password: "newSecret123" }),
        }),
      ),
    );
    await waitFor(() => expect(authMocks.signOut).toHaveBeenCalled());

    expect(await screen.findByText("Password updated")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("shows the server's error message inline and does not sign out or advance past the form", async () => {
    updatePasswordResponds(422, {
      error: { code: "VALIDATION_FAILED", message: "Password should be at least 6 characters" },
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

  it("shows a generic error and does not sign out when the reset POST itself rejects (network failure)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/auth/recovery-status") {
        return { json: async () => ({ data: { verified: true } }) };
      }
      throw new Error("network down");
    });
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "newSecret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(authMocks.signOut).not.toHaveBeenCalled();
  });
});
