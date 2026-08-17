import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// The merchant sign-in screen, and the SECOND copy of the dead approval guard.
//
// G1 section 3 was written about the portal layout's
// `if (portal.business.status === "pending")`, which compares against a value
// `businesses_status_check` forbids and therefore could never fire. The
// identical construct lived here too - same impossible "pending", same
// unreachable /business/pending-approval, same `(staff as any)` cast over an
// embedded select nothing tested - and this file had no test at all, so no
// mutant could ever have been red-verified against it.
//
// This page had it WORSE than the layout, because here the dead comparison was
// the only reason the `business_staff` read existed. The round trip ran on
// every sign-in and its result was discarded by a branch that never taxed.
// ===========================================================================

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
  from: vi.fn(),
  registerCurrentDevice: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/features/identity/actions", () => ({
  registerCurrentDevice: mocks.registerCurrentDevice,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: mocks.signInWithPassword,
      signInWithOAuth: mocks.signInWithOAuth,
    },
    from: mocks.from,
  }),
}));

const BusinessLoginPage = (await import("./page")).default;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.signInWithPassword.mockResolvedValue({
    data: { user: { id: "user-1" }, session: { access_token: "t" } },
    error: null,
  });
  mocks.registerCurrentDevice.mockResolvedValue(undefined);
  mocks.signInWithOAuth.mockResolvedValue({ error: null });
  // Deliberately throws. Nothing on this path may read a table any more, and a
  // mock that returned a plausible row would let a reintroduced query pass
  // unnoticed.
  mocks.from.mockImplementation((table: string) => {
    throw new Error(`the login page must not query "${table}"`);
  });
});

async function signIn(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "owner@kapediaria.ph" },
  });
  // Exact, not /password/i: the "Forgot password?" link matches that regex too.
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2hunter2" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("where a merchant lands after signing in (G1 section 3)", () => {
  it("CRITICAL: goes to the portal, never to the approval waiting room", async () => {
    render(<BusinessLoginPage />);
    await signIn();

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    expect(mocks.push).toHaveBeenCalledWith("/business/dashboard");
    // Asserted as an absence too: a future edit that adds a second push would
    // satisfy the positive check alone while still stranding the merchant in a
    // room whose only control is a "check status" button.
    expect(mocks.push).not.toHaveBeenCalledWith("/business/pending-approval");
  });

  it("CRITICAL: reads no table to decide it", async () => {
    // The `business_staff` + `businesses(status)` read existed ONLY to feed the
    // impossible `status === "pending"` comparison. Membership and suspension
    // are decided by the portal layout, on the server, from table truth. If a
    // query comes back here, the mocked `from` throws and this fails.
    render(<BusinessLoginPage />);
    await signIn();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/business/dashboard"));
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("still registers the device before navigating", async () => {
    render(<BusinessLoginPage />);
    await signIn();

    await waitFor(() => expect(mocks.registerCurrentDevice).toHaveBeenCalled());
  });

  it("does not navigate when the credentials were refused", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Invalid login credentials" },
    });
    render(<BusinessLoginPage />);
    await signIn();

    expect(await screen.findByText("Invalid login credentials")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("survives a device-registration failure rather than blocking the sign-in", async () => {
    // registerCurrentDevice is best effort by design (see its own comment): a
    // device row that could not be written is not a reason to fail a login.
    mocks.registerCurrentDevice.mockRejectedValue(new Error("network"));
    render(<BusinessLoginPage />);
    await signIn();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/business/dashboard"));
  });
});
