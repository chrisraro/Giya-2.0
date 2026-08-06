import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ResetPasswordPage from "./page";

// This page's gate is the whole point of this file: reaching the
// new-password form must require evidence the CURRENT session specifically
// came from a recovery link, not merely that a session of any kind exists.
// See page.tsx's own comment for why the check is done via getClaims()'s
// `amr` (Authentication Methods Reference) claim rather than getSession()
// alone, and why onAuthStateChange's PASSWORD_RECOVERY event is kept as a
// second, standard admission path.

type AuthChangeCallback = (event: string, session: unknown) => void;

const authMocks = vi.hoisted(() => ({
  getClaims: vi.fn(),
  onAuthStateChange: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
}));

const authChangeState = vi.hoisted(() => ({
  callback: undefined as AuthChangeCallback | undefined,
  unsubscribe: vi.fn(),
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

/** A session whose most recent authentication method was a recovery link. */
function mockRecoveryClaims() {
  authMocks.getClaims.mockResolvedValue({
    data: { claims: { amr: [{ method: "recovery", timestamp: 1 }] } },
  });
}

/** An ordinary signed-in session - the case I4 exists to keep OUT. */
function mockOrdinaryClaims() {
  authMocks.getClaims.mockResolvedValue({
    data: { claims: { amr: [{ method: "password", timestamp: 1 }] } },
  });
}

beforeEach(() => {
  authMocks.getClaims.mockReset();
  authMocks.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
  authMocks.signOut.mockReset().mockResolvedValue({ error: null });
  authChangeState.callback = undefined;
  authChangeState.unsubscribe.mockReset();
  authMocks.onAuthStateChange.mockReset().mockImplementation((cb: AuthChangeCallback) => {
    authChangeState.callback = cb;
    return { data: { subscription: { unsubscribe: authChangeState.unsubscribe } } };
  });
});

describe("ResetPasswordPage - recovery gate", () => {
  it("shows an expired-link message with a link back to /forgot-password when there is no session at all", async () => {
    authMocks.getClaims.mockResolvedValue({ data: { claims: null } });
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

  it("I4: shows the SAME expired-link message for an ordinary signed-in session that did not come from a recovery link", async () => {
    mockOrdinaryClaims();
    render(<ResetPasswordPage />);

    expect(
      await screen.findByText("That link expired or was already used."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("shows the new-password form when the session's most recent auth method was recovery", async () => {
    mockRecoveryClaims();
    render(<ResetPasswordPage />);

    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update password" })).toBeInTheDocument();
    expect(screen.queryByText("That link expired or was already used.")).not.toBeInTheDocument();
  });

  it("also admits via supabase-js's own PASSWORD_RECOVERY event, independent of the amr check", async () => {
    // No usable claims yet (e.g. still resolving) - the event alone must be
    // enough to admit.
    authMocks.getClaims.mockResolvedValue({ data: { claims: null } });
    render(<ResetPasswordPage />);
    await waitFor(() => expect(authMocks.onAuthStateChange).toHaveBeenCalled());

    act(() => {
      authChangeState.callback?.("PASSWORD_RECOVERY", { access_token: "t" });
    });

    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
  });

  it("I5: does not stay stuck on a blank screen when checking the session fails outright", async () => {
    authMocks.getClaims.mockRejectedValue(new Error("network down"));
    render(<ResetPasswordPage />);

    expect(
      await screen.findByText("That link expired or was already used."),
    ).toBeInTheDocument();
  });

  it("unsubscribes the auth-state listener on unmount", async () => {
    mockRecoveryClaims();
    const { unmount } = render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    unmount();

    expect(authChangeState.unsubscribe).toHaveBeenCalled();
  });
});

describe("ResetPasswordPage - form", () => {
  it("shows a validation error on empty submit and never calls updateUser", async () => {
    mockRecoveryClaims();
    render(<ResetPasswordPage />);
    await screen.findByLabelText("New password");

    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(authMocks.updateUser).not.toHaveBeenCalled();
  });

  it("updates the password, signs out the recovery session, and shows a confirmation with a sign-in link", async () => {
    mockRecoveryClaims();
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
    mockRecoveryClaims();
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
