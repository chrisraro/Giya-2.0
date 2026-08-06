import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Device registration on the SIGN-UP path.
//
// handleSubmit branches after a successful signUp:
//
//   if (data.user && !data.session) { …check your email…; return; }
//   router.push(next);
//
// The second branch establishes a session AT /signup - it is the branch
// Supabase takes whenever email confirmation is turned OFF - and it navigated
// straight to onboarding with no device registered. The first branch has no
// session yet and must register nothing; that account's device is registered
// when the confirmation link lands on /auth/callback.
//
// The rest of this page's behaviour is covered in
// src/components/auth/auth.test.tsx and is not re-asserted here.

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

vi.mock("@hcaptcha/react-hcaptcha", () => {
  const HCaptchaMock = React.forwardRef<{ resetCaptcha: () => void }, { sitekey: string }>(
    function HCaptchaMock(_props, ref) {
      React.useImperativeHandle(ref, () => ({ resetCaptcha: vi.fn() }));
      return null;
    },
  );
  return { default: HCaptchaMock };
});

const mocks = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithOAuth: vi.fn(),
  resend: vi.fn(),
  registerCurrentDevice: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signUp: mocks.signUp,
      signInWithOAuth: mocks.signInWithOAuth,
      resend: mocks.resend,
    },
  }),
}));

vi.mock("@/features/identity/actions", () => ({
  registerCurrentDevice: mocks.registerCurrentDevice,
}));

const SignupPage = (await import("./page")).default;

/** A signUp result that carries a live session - email confirmation OFF. */
const WITH_SESSION = {
  data: { user: { id: "user-1" }, session: { access_token: "t" } },
  error: null,
};

/** A signUp result that does not - email confirmation ON. */
const AWAITING_CONFIRMATION = {
  data: { user: { id: "user-1" }, session: null },
  error: null,
};

function signUp(): void {
  render(<SignupPage />);
  fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Ana Cruz" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signUp.mockResolvedValue(WITH_SESSION);
  mocks.registerCurrentDevice.mockResolvedValue(undefined);
});

describe("sign-up that lands a session immediately", () => {
  it("CRITICAL: registers the device before leaving for onboarding", async () => {
    // This branch fires whenever Supabase email confirmation is off. Before
    // this it was a session created with no device row and no later chance to
    // write one until the consumer signed out and back in.
    signUp();

    await waitFor(() => expect(mocks.registerCurrentDevice).toHaveBeenCalledTimes(1));
    expect(mocks.push).toHaveBeenCalledWith("/onboarding");
  });

  it("CRITICAL: registers BEFORE it navigates", async () => {
    const order: string[] = [];
    mocks.registerCurrentDevice.mockImplementation(async () => {
      await Promise.resolve();
      order.push("register");
    });
    mocks.push.mockImplementation(() => {
      order.push("push");
    });

    signUp();

    await waitFor(() => expect(order).toEqual(["register", "push"]));
  });

  it("CRITICAL: keeps the submit button disabled for the whole registration round trip", async () => {
    // The same double-submit window the login page had: a re-enabled button
    // over a server-action round trip, with the page not yet moved.
    let release: () => void = () => {};
    mocks.registerCurrentDevice.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );

    signUp();

    await waitFor(() => expect(mocks.registerCurrentDevice).toHaveBeenCalled());
    expect(document.querySelector('button[type="submit"]')).toBeDisabled();
    release();
  });

  it("still navigates when registration throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.registerCurrentDevice.mockRejectedValue(new Error("Failed to fetch"));

    signUp();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
    consoleError.mockRestore();
  });
});

describe("sign-up that is waiting on a confirmation email", () => {
  it("CRITICAL: registers nothing, because there is no session yet", async () => {
    // `data.user && !data.session`. The device for this account is registered
    // when the confirmation link lands on /auth/callback.
    mocks.signUp.mockResolvedValue(AWAITING_CONFIRMATION);

    signUp();

    await waitFor(() => expect(mocks.signUp).toHaveBeenCalled());
    expect(mocks.registerCurrentDevice).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("sign-up that failed", () => {
  it("CRITICAL: registers nothing when Supabase refused", async () => {
    mocks.signUp.mockResolvedValue({ data: {}, error: { message: "Password is too short" } });

    signUp();

    await screen.findByRole("alert");
    expect(mocks.registerCurrentDevice).not.toHaveBeenCalled();
  });

  it("re-enables the button so the person can fix it and retry", async () => {
    mocks.signUp.mockResolvedValue({ data: {}, error: { message: "Password is too short" } });

    signUp();

    await screen.findByRole("alert");
    expect(document.querySelector('button[type="submit"]')).not.toBeDisabled();
  });
});
