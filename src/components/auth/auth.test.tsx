import { render, screen } from "@testing-library/react";
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
});
