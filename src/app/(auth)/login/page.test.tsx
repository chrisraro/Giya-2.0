import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Device registration on the password sign-in path.
//
// `public.user_devices` had no writer anywhere in src/, so nobody's device was
// ever registered and /profile/devices would have been empty for everyone. A
// session has to be ESTABLISHED for a device to exist, and the two paths that
// establish one are this page (password) and /auth/callback (PKCE / OAuth).
// Both now register; this file covers this one.
//
// The rest of this page's behaviour predates this slice and is not re-asserted
// here.

// @/lib/env throws at module-evaluation time without the NEXT_PUBLIC_SUPABASE_*
// vars, and captcha.tsx pulls it in transitively. Same shim the other auth page
// tests use.
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
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
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
      signInWithPassword: mocks.signInWithPassword,
      signInWithOAuth: mocks.signInWithOAuth,
    },
  }),
}));

vi.mock("@/features/identity/actions", () => ({
  registerCurrentDevice: mocks.registerCurrentDevice,
}));

const LoginPage = (await import("./page")).default;

function signIn(): void {
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signInWithPassword.mockResolvedValue({ error: null });
  mocks.registerCurrentDevice.mockResolvedValue(undefined);
});

describe("password sign-in registers the device", () => {
  it("CRITICAL: registers this browser once the session exists", async () => {
    signIn();

    await waitFor(() => expect(mocks.registerCurrentDevice).toHaveBeenCalledTimes(1));
  });

  it("CRITICAL: registers nothing when the credentials were refused", async () => {
    // No session, no device. Registering here would attribute a device row to
    // whoever happened to be signed in before.
    mocks.signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });

    signIn();

    await screen.findByRole("alert");
    expect(mocks.registerCurrentDevice).not.toHaveBeenCalled();
  });

  it("CRITICAL: a registration that fails does not strand the person on the login page", async () => {
    // Signing in succeeded. Whatever happened to the device row, they are
    // signed in and belong on the other side of this screen.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.registerCurrentDevice.mockRejectedValue(new Error("Failed to fetch"));

    signIn();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/home"));
    consoleError.mockRestore();
  });

  it("CRITICAL: the Sign in button stays disabled for the whole registration round trip", async () => {
    // `setSubmitting(false)` used to run the moment signInWithPassword
    // returned - which was harmless when the next statement was the
    // navigation, and is not now that a server-action round trip sits between
    // them. For its whole duration the button was re-enabled, read "Sign in",
    // and the page had not moved: a very tappable window on a Philippine mobile
    // connection, and the most likely real-world route to the duplicate
    // user_devices row this slice disclosed as theoretical.
    let release: () => void = () => {};
    mocks.registerCurrentDevice.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );

    signIn();

    await waitFor(() => expect(mocks.registerCurrentDevice).toHaveBeenCalled());
    const button = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button).toBeDisabled();
    expect(button.textContent).not.toBe("Sign in");
    release();
  });

  it("CRITICAL: a second tap during registration cannot start a second sign-in", async () => {
    // The consequence of the window above, asserted as behaviour rather than as
    // a disabled attribute.
    let release: () => void = () => {};
    mocks.registerCurrentDevice.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );

    signIn();
    await waitFor(() => expect(mocks.registerCurrentDevice).toHaveBeenCalled());

    fireEvent.click(document.querySelector('button[type="submit"]') as HTMLButtonElement);

    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(mocks.registerCurrentDevice).toHaveBeenCalledTimes(1);
    release();
  });

  it("re-enables the button after a refused sign-in, so it can be retried", async () => {
    mocks.signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });

    signIn();

    await screen.findByRole("alert");
    expect(document.querySelector('button[type="submit"]')).not.toBeDisabled();
  });

  it("CRITICAL: registers BEFORE it navigates", async () => {
    // Fire-and-forget would be cancelled by the navigation on a slow
    // connection, which is exactly the connection where it would be slow.
    const order: string[] = [];
    mocks.registerCurrentDevice.mockImplementation(async () => {
      // A real await inside. Without one the mock's body runs synchronously up
      // to its return, and a fire-and-forget call would look ordered too.
      await Promise.resolve();
      order.push("register");
    });
    mocks.push.mockImplementation(() => {
      order.push("push");
    });

    signIn();

    await waitFor(() => expect(order).toEqual(["register", "push"]));
  });
});
