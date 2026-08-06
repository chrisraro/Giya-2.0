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
  // Stands in for ref_cities. Deliberately includes a city that is NOT one of
  // the six the wizard used to hardcode, so a regression back to a literal
  // list fails here instead of shipping.
  cities: [{ name: "Cebu" }, { name: "Davao" }, { name: "Naga" }],
  /** Counts the ref_cities reads, so mount lifetime is assertable. */
  cityFetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("@/features/identity/actions", () => ({
  completeConsumerOnboarding: mocks.completeConsumerOnboarding,
}));

// The city step reads ref_cities through the browser client now, so the list
// arrives asynchronously and every step that touches it has to await it.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => {
            mocks.cityFetch();
            return Promise.resolve({ data: mocks.cities, error: null });
          },
        }),
      }),
    }),
  }),
}));

const OnboardingPage = (await import("./page")).default;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.completeConsumerOnboarding.mockResolvedValue({ ok: true });
});

/** Walks the wizard to its last step by clicking Continue. */
async function advanceToFinish(): Promise<void> {
  // Step 0 (welcome) -> 1 (city) -> 2 (interests) -> 3 (notifications).
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(await screen.findByRole("radio", { name: /Cebu/ }));
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
    fireEvent.click(await screen.findByRole("radio", { name: /Davao/ }));
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
    await advanceToFinish();

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
    await advanceToFinish();
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Network is down");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

// ref_cities held six rows until 0027_reference_data.sql seeded all 149
// chartered Philippine cities, and this wizard held its own copy of those six
// as a literal, so the seed reached nobody: a consumer in Naga had no way to
// say where they live. The picker is now fed by the table.
describe("City step", () => {
  it("offers whatever ref_cities holds, not a hardcoded six", async () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("radio", { name: /Naga/ })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(mocks.cities.length);
  });

  // The city step is mounted only while `step === 1`. Before the picker was
  // extracted, the ref_cities read and the search text both lived in the page
  // component, which stays mounted for the whole wizard; moving them into the
  // step would refetch on every return to it, flash the "No cities match" empty
  // state during each refetch, and drop whatever had been typed. These two pin
  // the original behaviour so the extraction cannot quietly cost it.
  /**
   * Walks to the city step and picks a city, which is also what UNLOCKS
   * Continue: `canContinue` is `step !== 1 || city !== null`, so the wizard
   * cannot be left forwards from here until something is chosen.
   */
  async function reachCityStepAndChoose(city: RegExp): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("radio", { name: city }));
  }

  it("CRITICAL: reads ref_cities ONCE per wizard, not once per visit to the step", async () => {
    render(<OnboardingPage />);
    await reachCityStepAndChoose(/Cebu/);
    expect(mocks.cityFetch).toHaveBeenCalledTimes(1);

    // Forward to Interests and back to City: the step unmounts and remounts.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("radio", { name: /Cebu/ });

    expect(mocks.cityFetch).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: keeps the typed search when you leave the step and come back", async () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("radio", { name: /Cebu/ });

    fireEvent.change(screen.getByLabelText("Search city"), { target: { value: "Nag" } });
    const naga = await screen.findByRole("radio", { name: /Naga/ });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.click(naga);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByLabelText("Search city")).toHaveValue("Nag");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("never flashes the empty state on a return visit", async () => {
    // The refetch regression showed `No cities match ""` for a frame every time
    // the step remounted, because the list started empty again.
    render(<OnboardingPage />);
    await reachCityStepAndChoose(/Cebu/);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByText(/No cities match/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(mocks.cities.length);
  });

  it("passes the chosen city through to the completion action", async () => {
    render(<OnboardingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Naga/ }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    await waitFor(() =>
      expect(mocks.completeConsumerOnboarding).toHaveBeenCalledWith({
        cityName: "Naga",
        pushEnabled: false,
      }),
    );
  });
});
