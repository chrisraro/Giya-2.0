import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SocialButtons } from "./social-buttons";
import SignupPage from "@/app/(auth)/signup/page";
import LoginPage from "@/app/(auth)/login/page";

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => nav.searchParams,
}));

const authMocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signInWithOAuth: vi.fn(),
  resend: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: authMocks }),
}));

beforeEach(() => {
  nav.push.mockClear();
  nav.searchParams = new URLSearchParams();
  authMocks.signInWithPassword.mockReset().mockResolvedValue({ data: {}, error: null });
  authMocks.signUp.mockReset().mockResolvedValue({
    data: { user: { id: "u1" }, session: { access_token: "t" } },
    error: null,
  });
  authMocks.signInWithOAuth.mockReset().mockResolvedValue({ data: {}, error: null });
  authMocks.resend.mockReset().mockResolvedValue({ data: {}, error: null });
});

describe("SocialButtons", () => {
  it("renders accessible names for Google and Facebook", () => {
    render(<SocialButtons onGoogle={() => {}} onFacebook={() => {}} />);
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Facebook" })).toBeInTheDocument();
  });
});

describe("LoginPage", () => {
  it("renders the sign in CTA", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("SignupPage", () => {
  it("renders a radiogroup role selector with both role labels", () => {
    render(<SignupPage />);
    const group = screen.getByRole("radiogroup");
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.getByText("Earn rewards")).toBeInTheDocument();
    expect(screen.getByText("Grow my business")).toBeInTheDocument();
  });

  it("moves selection to the other role on arrow key and focuses it", () => {
    render(<SignupPage />);
    const earnRewards = screen.getByText("Earn rewards").closest('[role="radio"]') as HTMLElement;
    const growBusiness = screen.getByText("Grow my business").closest('[role="radio"]') as HTMLElement;

    earnRewards.focus();
    expect(earnRewards).toHaveFocus();

    fireEvent.keyDown(earnRewards, { key: "ArrowRight" });

    expect(growBusiness).toHaveAttribute("aria-checked", "true");
    expect(earnRewards).toHaveAttribute("aria-checked", "false");
    expect(growBusiness).toHaveFocus();
  });
});

describe("LoginPage validation", () => {
  it("shows an error on empty submit and clears the email error as the user retypes", () => {
    render(<LoginPage />);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const alerts = screen.getAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(screen.getByText("Email is required")).toBeInTheDocument();

    const emailInput = screen.getByLabelText("Email");
    fireEvent.change(emailInput, { target: { value: "a" } });

    expect(screen.queryByText("Email is required")).not.toBeInTheDocument();
  });
});

describe("LoginPage submit", () => {
  it("signs in with the entered credentials and redirects to /home by default", async () => {
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(authMocks.signInWithPassword).toHaveBeenCalledWith({
        email: "a@b.com",
        password: "secret123",
      }),
    );
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/home"));
  });

  it("redirects to an internal next search param instead of /home", async () => {
    nav.searchParams = new URLSearchParams("next=/business/dashboard");
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/business/dashboard"));
  });

  it("ignores a protocol-relative next and falls back to /home", async () => {
    nav.searchParams = new URLSearchParams("next=//evil.com");
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/home"));
  });

  it("shows a friendly message for invalid credentials instead of the raw Supabase error", async () => {
    authMocks.signInWithPassword.mockResolvedValueOnce({
      data: {},
      error: { message: "Invalid login credentials" },
    });
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Email or password is incorrect.")).toBeInTheDocument();
  });

  it("shows an expired-link notice when ?error=confirm is present", () => {
    nav.searchParams = new URLSearchParams("error=confirm");
    render(<LoginPage />);
    expect(
      screen.getByText("That link expired or was already used. Sign in or request a new one."),
    ).toBeInTheDocument();
  });

  it("shows an inline notice when Google sign-in errors", async () => {
    authMocks.signInWithOAuth.mockResolvedValueOnce({
      data: {},
      error: { message: "provider is not enabled" },
    });
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(await screen.findByText("Google sign-in is not configured yet.")).toBeInTheDocument();
  });
});

describe("SignupPage submit", () => {
  it("calls signUp with intended_role for the selected role card", async () => {
    render(<SignupPage />);
    fireEvent.click(screen.getByText("Grow my business").closest('[role="radio"]') as HTMLElement);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Jamie Cruz" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jamie@shop.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(authMocks.signUp).toHaveBeenCalled());
    expect(authMocks.signUp).toHaveBeenCalledWith({
      email: "jamie@shop.com",
      password: "secret123",
      options: expect.objectContaining({
        data: { full_name: "Jamie Cruz", intended_role: "business" },
        emailRedirectTo: expect.stringContaining("/auth/callback?next=/business/onboarding"),
      }),
    });
  });

  it("shows the CheckEmail state when confirmation is required (user without a session)", async () => {
    authMocks.signUp.mockResolvedValueOnce({
      data: { user: { id: "u1" }, session: null },
      error: null,
    });
    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Jamie Cruz" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jamie@shop.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText("jamie@shop.com")).toBeInTheDocument();
  });

  it("redirects straight through when a session is returned (confirmation disabled)", async () => {
    authMocks.signUp.mockResolvedValueOnce({
      data: { user: { id: "u1" }, session: { access_token: "t" } },
      error: null,
    });
    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Jamie Cruz" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jamie@shop.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/onboarding"));
  });

  it("shows a form-level error alert when signUp fails", async () => {
    authMocks.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: "Email address already in use" },
    });
    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Jamie Cruz" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "jamie@shop.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Email address already in use")).toBeInTheDocument();
  });
});
