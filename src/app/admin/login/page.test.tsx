import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: null } }),
      signInWithPassword: vi.fn(),
      signInWithOAuth: vi.fn(),
      signOut: vi.fn(),
    },
  }),
}));
vi.mock("@/features/identity/actions", () => ({ registerCurrentDevice: vi.fn() }));

import AdminLoginPage from "./page";

// The page is public, so anything rendered into it is published to every visitor. A
// hard-coded super-admin address told them which account to attack.
describe("AdminLoginPage", () => {
  it("renders an empty email field with a generic placeholder", () => {
    render(<AdminLoginPage />);
    const email = screen.getByLabelText(/admin email/i) as HTMLInputElement;
    expect(email.value).toBe("");
    expect(email.placeholder).toBe("you@company.com");
  });

  it("never puts the super-admin address anywhere in the rendered page", () => {
    const { container } = render(<AdminLoginPage />);
    expect(container.innerHTML).not.toContain("teamocsph");
    const email = screen.getByLabelText(/admin email/i) as HTMLInputElement;
    expect(email.value).not.toContain("teamocsph");
  });
});
