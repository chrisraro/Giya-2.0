import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Doc 30 section 2.8: "/suspended | Suspension notice | [MVP] | Terminal
// screen, logout only". Reached from two gates - the consumer layout
// (?type=account) and the business portal layout (?type=business) - and this
// suite is the fence on the one thing that actually matters about this page:
// it must NEVER echo `profiles.suspended_reason` / `businesses.suspended_reason`
// (operator-facing free text an admin typed for the audit log, per
// src/features/admin/consequences.ts) back at the suspended person. This page
// takes no such prop at all, by construction - these tests are what makes
// that a property of the page rather than an accident of its current props.

vi.mock("@/features/identity/actions", () => ({
  signOut: vi.fn(),
}));

const SuspendedPage = (await import("./page")).default;

function searchParams(type?: string) {
  return Promise.resolve(type === undefined ? {} : { type });
}

describe("SuspendedPage", () => {
  it("shows account copy for ?type=account", async () => {
    render(await SuspendedPage({ searchParams: searchParams("account") }));
    expect(screen.getByRole("heading", { name: /account is suspended/i })).toBeInTheDocument();
  });

  it("shows business copy for ?type=business", async () => {
    render(await SuspendedPage({ searchParams: searchParams("business") }));
    expect(screen.getByRole("heading", { name: /business is suspended/i })).toBeInTheDocument();
  });

  it("defaults to account copy for an unrecognized or missing type", async () => {
    render(await SuspendedPage({ searchParams: searchParams(undefined) }));
    expect(screen.getByRole("heading", { name: /account is suspended/i })).toBeInTheDocument();
  });

  it("offers a sign-out control (doc 30: 'logout only')", async () => {
    render(await SuspendedPage({ searchParams: searchParams("account") }));
    expect(screen.getByRole("button", { name: /log out/i })).toBeInTheDocument();
  });

  it("offers an appeal contact", async () => {
    render(await SuspendedPage({ searchParams: searchParams("account") }));
    const appealLink = screen.getByRole("link", { name: /appeal|contact/i });
    expect(appealLink.getAttribute("href")).toMatch(/^mailto:/);
  });

  // The header comment's claim ("must NEVER echo suspended_reason") had no
  // assertion behind it - review finding. This is that assertion: even if a
  // caller smuggles a reason-shaped field into searchParams (simulating a
  // future edit to one of the two callers, or a crafted URL), the page must
  // not render it. The component only ever destructures `type`, so this also
  // guards against a future change that starts interpolating more of
  // searchParams into the JSX.
  it("CRITICAL: never renders reason-like text smuggled into searchParams", async () => {
    const sneaky = "Repeated fraudulent receipts, ring flagged";
    render(
      await SuspendedPage({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        searchParams: Promise.resolve({ type: "account", reason: sneaky } as any),
      }),
    );
    expect(screen.queryByText(sneaky)).not.toBeInTheDocument();
  });
});
