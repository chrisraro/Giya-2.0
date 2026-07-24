import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SocialButtons } from "./social-buttons";
import SignupPage from "@/app/(auth)/signup/page";
import LoginPage from "@/app/(auth)/login/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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
