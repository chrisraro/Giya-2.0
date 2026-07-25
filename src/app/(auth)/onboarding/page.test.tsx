import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The consumer onboarding wizard, tested for exactly one property: it always
// stamps profiles.onboarded_at before it lets anyone leave.
//
// That used to be optional. "Skip for now" called the completion action only
// if a city had been picked, which was harmless while nothing read the
// column. The consumer layout now gates on it, so an exit that does not stamp
// means /home redirects straight back here - forever. This file is the fence
// around that loop.

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  completeConsumerOnboarding: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/features/identity/actions", () => ({
  completeConsumerOnboarding: mocks.completeConsumerOnboarding,
}));

const OnboardingPage = (await import("./page")).default;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.completeConsumerOnboarding.mockResolvedValue({ ok: true });
});

/** Walks the wizard to its last step by clicking Continue. */
function advanceToFinish(): void {
  // Step 0 (welcome) -> 1 (city) -> 2 (interests) -> 3 (notifications).
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("radio", { name: /Cebu/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("Skip for now", () => {
  it("CRITICAL: stamps completion even with no city chosen, so the gate cannot loop", async () => {
    render(<OnboardingPage />);

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    await waitFor(() =>
      expect(mocks.completeConsumerOnboarding).toHaveBeenCalledWith({
        cityName: null,
        pushEnabled: false,
      }),
    );
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/home"));
  });

  it("keeps a city the consumer did pick before skipping", async () => {
    render(<OnboardingPage />);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("radio", { name: /Davao/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    await waitFor(() =>
      expect(mocks.completeConsumerOnboarding).toHaveBeenCalledWith({
        cityName: "Davao",
        pushEnabled: false,
      }),
    );
  });

  it("stays put and explains itself when the stamp fails", async () => {
    // Navigating forward on a failed stamp would bounce the user back here
    // with the error already gone.
    mocks.completeConsumerOnboarding.mockResolvedValue({ ok: false, message: "Network is down" });

    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Network is down");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("Finish", () => {
  it("stamps completion and moves to /home", async () => {
    render(<OnboardingPage />);
    advanceToFinish();

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    await waitFor(() =>
      expect(mocks.completeConsumerOnboarding).toHaveBeenCalledWith({
        cityName: "Cebu",
        pushEnabled: false,
      }),
    );
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/home"));
  });

  it("stays put and explains itself when the stamp fails", async () => {
    mocks.completeConsumerOnboarding.mockResolvedValue({ ok: false, message: "Network is down" });

    render(<OnboardingPage />);
    advanceToFinish();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Network is down");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
