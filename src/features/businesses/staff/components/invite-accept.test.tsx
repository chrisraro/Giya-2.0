import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// I5 (review fix): the invitee's session at the moment they click Accept
// PREDATES the business_staff row this click creates - it was issued at
// their own sign-in/sign-up, before this invite ever existed - so it carries
// no `biz` claim for the tenant they just joined. Pushing straight to
// /business/dashboard on that stale token means `is_staff_of` reads false
// and their own roster comes back empty, exactly the way
// `business/onboarding/page.tsx:416` already had to solve for a freshly
// registered owner. This file proves the same fix is cloned here.

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  acceptInviteAction: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("../actions", () => ({
  acceptInviteAction: mocks.acceptInviteAction,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { refreshSession: mocks.refreshSession } }),
}));

const { InviteAccept } = await import("./invite-accept");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.acceptInviteAction.mockResolvedValue({ ok: true, data: { businessId: "biz-1" } });
  mocks.refreshSession.mockResolvedValue({ data: { session: {} }, error: null });
});

describe("InviteAccept", () => {
  it("refreshes the session BEFORE navigating, so the dashboard's own roster read sees the new membership", async () => {
    // Mutant: dropping the refreshSession() call entirely, or calling it
    // AFTER router.push (too late to matter - the dashboard has already
    // started rendering against the stale token), both make this fail.
    const calls: string[] = [];
    mocks.refreshSession.mockImplementation(async () => {
      calls.push("refresh");
      return { data: { session: {} }, error: null };
    });
    mocks.push.mockImplementation(() => {
      calls.push("push");
    });

    render(<InviteAccept token="tok_live" />);
    fireEvent.click(screen.getByRole("button", { name: /Accept invite/i }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());

    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["refresh", "push"]);
  });

  it("still navigates to the dashboard even if the refresh itself errors - the accept already committed", async () => {
    // A failed client-side refresh is a courtesy, not the source of truth
    // (the business_staff row already flipped server-side); the invitee can
    // always get a fresh token on their next real request. This must not
    // strand them on the invite page.
    mocks.refreshSession.mockRejectedValue(new Error("network blip"));

    render(<InviteAccept token="tok_live" />);
    fireEvent.click(screen.getByRole("button", { name: /Accept invite/i }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/business/dashboard"));
  });

  it("does NOT refresh or navigate when the action refuses", async () => {
    mocks.acceptInviteAction.mockResolvedValue({
      ok: false,
      code: "WRONG_ACCOUNT",
      message: "This invite was sent to a different account.",
    });

    render(<InviteAccept token="tok_live" />);
    fireEvent.click(screen.getByRole("button", { name: /Accept invite/i }));

    await screen.findByRole("alert");

    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
