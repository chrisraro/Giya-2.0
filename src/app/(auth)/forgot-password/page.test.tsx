import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import ForgotPasswordPage from "./page";

// This page no longer calls Supabase directly - see
// src/app/api/v1/auth/forgot-password/route.ts. It POSTs here instead, so
// what used to be a `@/lib/supabase/client` mock is now a `fetch` mock.
// Enumeration-neutral body/timing and the actual rate limit are the ROUTE's
// tests now (route.test.ts); this page's own responsibility is narrower:
// send the request, and treat every outcome identically EXCEPT a 429 from
// our own limiter, which is not an enumeration leak (see page.tsx) and is
// worth a distinct, honest message.

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

const fetchMock = vi.fn();

function apiResponds(status: number, body: unknown = { data: { message: "ok" } }) {
  fetchMock.mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

beforeEach(() => {
  envState.hcaptchaSiteKey = undefined;
  hcaptchaMocks.reset.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  apiResponds(200);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a" } });
    expect(screen.queryByText("Email is required")).not.toBeInTheDocument();
  });

  it("POSTs the entered address to the forgot-password route, then shows a check-your-email confirmation", async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/auth/forgot-password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.com" });

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send reset link" })).not.toBeInTheDocument();
  });

  it("shows the same confirmation for a plain success and for an unexpected non-429 status, so nothing about the route's answer is surfaced", async () => {
    // Deliberately diffs the FULL rendered tree (render()'s own `container`),
    // not `someNode.closest("div")`: AuthCard splits its title/subtitle into
    // one header <div> and its children (the email address, in this case)
    // into a SIBLING <div> - closest("div") from the "Check your email" <h1>
    // only ever reaches the header, which is hard-coded and identical on
    // every render by construction. That made the test pass for the wrong
    // reason: it would stay green even if the confirmation's BODY (the part
    // that actually varies) leaked something from the route's response.
    const { unmount, container: successContainer } = render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "known@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await screen.findByText("Check your email");
    const successHtml = successContainer.innerHTML;
    unmount();

    apiResponds(500, { error: { code: "INTERNAL", message: "Something went wrong." } });
    const { container: errorContainer } = render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "known@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    await screen.findByText("Check your email");
    const errorHtml = errorContainer.innerHTML;

    expect(errorHtml).toBe(successHtml);
  });

  it("shows the same confirmation even when the fetch itself rejects outright (e.g. a network failure)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
  });

  it("shows a distinct rate-limit message on a 429 and stays on the form (a 429 is not an enumeration leak - it is keyed by IP/address, not by Supabase's answer)", async () => {
    apiResponds(429, { error: { code: "RATE_LIMITED", message: "Too many requests." } });
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Too many requests. Please wait a moment and try again.")).toBeInTheDocument();
    expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
  });
});

describe("ForgotPasswordPage captcha enabled", () => {
  beforeEach(() => {
    envState.hcaptchaSiteKey = "test-site-key";
  });

  it("blocks submit until the captcha is verified, then POSTs the token and resets the widget", async () => {
    vi.resetModules();
    const { default: FreshForgotPasswordPage } = await import("./page");
    render(<FreshForgotPasswordPage />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByText("Please complete the captcha.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mock-hcaptcha"));
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.com", captchaToken: "test-token" });
    expect(hcaptchaMocks.reset).toHaveBeenCalled();
  });
});
