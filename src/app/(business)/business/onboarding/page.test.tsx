import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// The business registration wizard.
//
// Two properties are pinned here, and both were broken in ways that looked
// fine on screen.
//
// 1. WHERE IT SENDS THE MERCHANT (G1 section 3). The last button says "Go to
//    dashboard" and used to `router.push("/business/pending-approval")` - a
//    waiting room with a "check status" button and nothing else. That is the
//    lockout the portal layout's own dead `status === "pending"` guard was
//    accidentally NOT applying: the guard could never fire, but the wizard
//    walked people into the same room by hand. An unapproved merchant is
//    supposed to go straight into the portal and start building.
//
// 2. WHAT IT PERSISTS (G1 section 2). The hours step collected four times and
//    threw them away; the file `TODO(api): wire hours + documents once the
//    schema supports them` had been sitting over a column
//    (`businesses.opening_hours`) that has existed since 0002.
// ===========================================================================

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  registerBusiness: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/features/identity/actions", () => ({
  registerBusiness: mocks.registerBusiness,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { refreshSession: mocks.refreshSession } }),
}));

const OnboardingPage = (await import("./page")).default;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registerBusiness.mockResolvedValue({ ok: true, hoursSaved: true });
  mocks.refreshSession.mockResolvedValue({ data: {}, error: null });
});

function fillBasics(): void {
  fireEvent.change(screen.getByLabelText("Business name"), {
    target: { value: "Kape Diaria" },
  });
  fireEvent.change(screen.getByLabelText("Business type"), { target: { value: "Cafe" } });
  fireEvent.change(screen.getByLabelText("City"), { target: { value: "Cebu" } });
}

/**
 * Walks the wizard to the last step, optionally overriding the hours the
 * merchant leaves in place. The defaults the wizard prefills are deliberately
 * NOT the values used here: an assertion that expected the prefill could not
 * tell "we saved what they typed" from "we saved the placeholder".
 */
async function advanceToFinish(
  hours: { weekdayOpen?: string; weekdayClose?: string; weekendOpen?: string; weekendClose?: string } = {},
): Promise<void> {
  fillBasics();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  fireEvent.change(await screen.findByLabelText("Address"), {
    target: { value: "12 Real Street" },
  });

  const byLabel: Record<string, string | undefined> = {
    "weekday-open": hours.weekdayOpen,
    "weekday-close": hours.weekdayClose,
    "weekend-open": hours.weekendOpen,
    "weekend-close": hours.weekendClose,
  };
  for (const [id, value] of Object.entries(byLabel)) {
    if (value === undefined) continue;
    const input = document.getElementById(id);
    if (input === null) throw new Error(`the wizard has no time input #${id}`);
    fireEvent.change(input, { target: { value } });
  }

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("the hours step reaches the server (G1 section 2)", () => {
  it("CRITICAL: hands registration the times the merchant actually typed", async () => {
    render(<OnboardingPage />);
    await advanceToFinish({
      weekdayOpen: "07:30",
      weekdayClose: "19:45",
      weekendOpen: "10:00",
      weekendClose: "14:15",
    });

    fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));

    await waitFor(() => expect(mocks.registerBusiness).toHaveBeenCalled());
    expect(mocks.registerBusiness).toHaveBeenCalledWith({
      name: "Kape Diaria",
      type: "Cafe",
      city: "Cebu",
      address: "12 Real Street",
      hours: {
        weekdayOpen: "07:30",
        weekdayClose: "19:45",
        weekendOpen: "10:00",
        weekendClose: "14:15",
      },
    });
  });

  it("CRITICAL: passes an edited weekend pair rather than the prefill", async () => {
    // The narrow version of the same claim. The wizard prefills 09:00-15:00 for
    // weekends, so an assertion that only checked "hours were passed" would
    // stay green if the state wiring dropped the merchant's edits and sent the
    // defaults.
    render(<OnboardingPage />);
    await advanceToFinish({ weekendOpen: "11:00", weekendClose: "16:30" });

    fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));

    await waitFor(() => expect(mocks.registerBusiness).toHaveBeenCalled());
    const passed = mocks.registerBusiness.mock.calls[0]?.[0] as { hours: Record<string, string> };
    expect(passed.hours.weekendOpen).toBe("11:00");
    expect(passed.hours.weekendClose).toBe("16:30");
  });
});

describe("where the wizard leaves a newly registered merchant (G1 section 3)", () => {
  it("CRITICAL: sends them into the portal, not to the approval waiting room", async () => {
    render(<OnboardingPage />);
    await advanceToFinish();

    fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalled());
    // Asserted as "never the waiting room" as well as "the dashboard", because
    // a future edit that adds a second push would satisfy the positive check
    // alone while still stranding the merchant.
    expect(mocks.push).toHaveBeenCalledWith("/business/dashboard");
    expect(mocks.push).not.toHaveBeenCalledWith("/business/pending-approval");
  });

  it("still reaches the dashboard when only the hours write failed", async () => {
    // The business was created. Stranding the merchant on the wizard would
    // invite a second press of a button whose RPC is not idempotent.
    mocks.registerBusiness.mockResolvedValue({ ok: true, hoursSaved: false });
    render(<OnboardingPage />);
    await advanceToFinish();

    fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/business/dashboard"));
  });

  it("does not navigate at all when registration failed", async () => {
    mocks.registerBusiness.mockResolvedValue({ ok: false, message: "unknown city: Atlantis" });
    render(<OnboardingPage />);
    await advanceToFinish();

    fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("unknown city: Atlantis");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
