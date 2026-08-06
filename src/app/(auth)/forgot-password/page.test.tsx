import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import ForgotPasswordPage from "./page";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
}));

const authMocks = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: authMocks }),
}));

// Same rationale as auth.test.tsx: @/lib/env throws at module-evaluation
// time without the required NEXT_PUBLIC_SUPABASE_* vars, and captcha.tsx
// pulls it in transitively.
const envState = vi.hoisted(() => ({ hcaptchaSiteKey: undefined as string | undefined }));

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abcdefghijklmnopqrstuvwxyz",
    get NEXT_PUBLIC_HCAPTCHA_SITE_KEY() {
      return envState.hcaptchaSiteKey;
    },
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

const hcaptchaMocks = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock("@hcaptcha/react-hcaptcha", () => {
  const HCaptchaMock = React.forwardRef<
    { resetCaptcha: () => void },
    { sitekey: string; onVerify?: (token: string) => void }
  >(function HCaptchaMock({ sitekey, onVerify }, ref) {
    React.useImperativeHandle(ref, () => ({ resetCaptcha: hcaptchaMocks.reset }));
    return (
      <button
        type="button"
        data-testid="mock-hcaptcha"
        data-sitekey={sitekey}
        onClick={() => onVerify?.("test-token")}
      >
        Verify captcha
      </button>
    );
  });
  return { default: HCaptchaMock };
});

beforeEach(() => {
  nav.push.mockClear();
  envState.hcaptchaSiteKey = undefined;
  hcaptchaMocks.reset.mockClear();
  authMocks.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("ForgotPasswordPage", () => {
  it("renders an email field and a send-link CTA", () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
  });

  it("shows a validation error on empty submit and never calls the API, then clears as the user retypes", () => {
    render(<ForgotPasswordPage />);
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(screen.getByText("Email is required")).toBeInTheDocument();
    expect(authMocks.resetPasswordForEmail).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a" } });
    expect(screen.queryByText("Email is required")).not.toBeInTheDocument();
  });

  it("calls resetPasswordForEmail with the entered address and the reset-password callback redirect, then shows a check-your-email confirmation", async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() =>
      expect(authMocks.resetPasswordForEmail).toHaveBeenCalledWith("a@b.com", {
        redirectTo: expect.stringContaining("/auth/callback?next=/reset-password"),
      }),
    );

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send reset link" })).not.toBeInTheDocument();
  });

  it("shows the exact same confirmation when Supabase answers with an error, so a known and unknown address are indistinguishable", async () => {
    const { unmount } = render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "known@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(authMocks.resetPasswordForEmail).toHaveBeenCalledTimes(1));
    const knownBodyHtml = (await screen.findByText("Check your email")).closest("div")?.innerHTML;
    unmount();

    authMocks.resetPasswordForEmail.mockReset().mockResolvedValueOnce({
      data: {},
      error: { message: "Unable to validate email address: invalid format" },
    });
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "known@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await waitFor(() => expect(authMocks.resetPasswordForEmail).toHaveBeenCalledTimes(1));
    const errorBodyHtml = (await screen.findByText("Check your email")).closest("div")?.innerHTML;

    expect(errorBodyHtml).toBe(knownBodyHtml);
    // The raw Supabase error text must never leak into the rendered page.
    expect(screen.queryByText(/Unable to validate email address/)).not.toBeInTheDocument();
  });

  it("shows the same confirmation even when resetPasswordForEmail rejects outright (e.g. a network failure)", async () => {
    authMocks.resetPasswordForEmail.mockReset().mockRejectedValueOnce(new Error("network down"));
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
  });

  it("holds the confirmation back for a minimum delay even when Supabase answers instantly", async () => {
    vi.useFakeTimers();
    try {
      render(<ForgotPasswordPage />);
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
      fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

      await vi.advanceTimersByTimeAsync(799);
      expect(screen.queryByText("Check your email")).not.toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(1);
      expect(screen.getByText("Check your email")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ForgotPasswordPage captcha enabled", () => {
  beforeEach(() => {
    envState.hcaptchaSiteKey = "test-site-key";
  });

  it("blocks submit until the captcha is verified, then calls resetPasswordForEmail with the token and resets the widget", async () => {
    vi.resetModules();
    const { default: FreshForgotPasswordPage } = await import("./page");
    render(<FreshForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Please complete the captcha.")).toBeInTheDocument();
    expect(authMocks.resetPasswordForEmail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mock-hcaptcha"));
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() =>
      expect(authMocks.resetPasswordForEmail).toHaveBeenCalledWith("a@b.com", {
        redirectTo: expect.stringContaining("/auth/callback?next=/reset-password"),
        captchaToken: "test-token",
      }),
    );
    // resetCaptcha() fires after the minimum-delay floor (MIN_RESPONSE_DELAY_MS)
    // has elapsed, not at the moment the API call resolves - give it room.
    await waitFor(() => expect(hcaptchaMocks.reset).toHaveBeenCalled());
  });
});
