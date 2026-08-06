import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The city picker is now shared by the onboarding wizard and /profile/edit.
// While it lived inline in onboarding it was covered only through that page's
// tests, which exercise one path: click a row, submit. These are its own.

const mocks = vi.hoisted(() => ({
  // Deliberately not alphabetical and deliberately including a city that was
  // never in the six-item literal this picker replaced.
  cities: [{ name: "Cebu City" }, { name: "Davao City" }, { name: "Naga (Camarines Sur)" }],
  /** Counts the ref_cities reads, so mount lifetime is assertable. */
  cityFetch: vi.fn(),
}));

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

const { CityPicker, useCityPicker } = await import("./city-picker");

function Harness({ initial = null }: { initial?: string | null }) {
  const [city, setCity] = React.useState<string | null>(initial);
  const picker = useCityPicker();
  return (
    <>
      <CityPicker state={picker} value={city} onChange={setCity} />
      <output data-testid="chosen">{city ?? "none"}</output>
    </>
  );
}

/**
 * A harness that can UNMOUNT the picker while keeping the state hook alive -
 * exactly the shape the onboarding wizard has, where the city step exists only
 * while `step === 1`.
 */
function ToggleHarness() {
  const [visible, setVisible] = React.useState(true);
  const [city, setCity] = React.useState<string | null>(null);
  const picker = useCityPicker();
  return (
    <>
      <button type="button" onClick={() => setVisible((v) => !v)}>
        toggle
      </button>
      {visible ? <CityPicker state={picker} value={city} onChange={setCity} /> : null}
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CityPicker", () => {
  it("offers whatever ref_cities holds", async () => {
    render(<Harness />);

    expect(await screen.findByRole("radio", { name: /Naga/ })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(mocks.cities.length);
  });

  it("reports the chosen city to its caller", async () => {
    render(<Harness />);

    fireEvent.click(await screen.findByRole("radio", { name: /Davao/ }));

    expect(screen.getByTestId("chosen")).toHaveTextContent("Davao City");
  });

  it("marks exactly the chosen row as checked", async () => {
    render(<Harness initial="Cebu City" />);

    const chosen = await screen.findByRole("radio", { name: /Cebu/ });
    expect(chosen).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /Davao/ })).toHaveAttribute("aria-checked", "false");
  });

  it("filters case-insensitively, so typing lowercase still finds a city", async () => {
    render(<Harness />);
    await screen.findByRole("radio", { name: /Cebu/ });

    fireEvent.change(screen.getByLabelText("Search city"), { target: { value: "davao" } });

    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(1));
    expect(screen.getByRole("radio", { name: /Davao/ })).toBeInTheDocument();
  });

  it("says so when nothing matches, rather than showing an empty box", async () => {
    render(<Harness />);
    await screen.findByRole("radio", { name: /Cebu/ });

    fireEvent.change(screen.getByLabelText("Search city"), { target: { value: "Atlantis" } });

    expect(await screen.findByText(/No cities match "Atlantis"/)).toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("keeps a tab stop in the group when nothing is chosen yet", async () => {
    // Without the roving fallback the whole radiogroup is tabIndex -1 and a
    // keyboard user cannot reach it at all.
    render(<Harness />);

    const rows = await screen.findAllByRole("radio");
    expect(rows.map((row) => row.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
  });

  it("moves the tab stop to the chosen row once there is one", async () => {
    render(<Harness initial="Davao City" />);

    const rows = await screen.findAllByRole("radio");
    expect(rows.map((row) => row.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("selects with ArrowDown and wraps at the end", async () => {
    render(<Harness />);
    const first = await screen.findByRole("radio", { name: /Cebu/ });

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByTestId("chosen")).toHaveTextContent("Davao City");

    fireEvent.keyDown(screen.getByRole("radio", { name: /Davao/ }), { key: "ArrowDown" });
    expect(screen.getByTestId("chosen")).toHaveTextContent("Naga (Camarines Sur)");

    fireEvent.keyDown(screen.getByRole("radio", { name: /Naga/ }), { key: "ArrowDown" });
    expect(screen.getByTestId("chosen")).toHaveTextContent("Cebu City");
  });

  it("selects with ArrowUp and wraps at the start", async () => {
    render(<Harness initial="Cebu City" />);
    const first = await screen.findByRole("radio", { name: /Cebu/ });

    fireEvent.keyDown(first, { key: "ArrowUp" });

    expect(screen.getByTestId("chosen")).toHaveTextContent("Naga (Camarines Sur)");
  });

  it("selects with Enter and with Space", async () => {
    render(<Harness />);
    const naga = await screen.findByRole("radio", { name: /Naga/ });

    fireEvent.keyDown(naga, { key: "Enter" });
    expect(screen.getByTestId("chosen")).toHaveTextContent("Naga (Camarines Sur)");

    fireEvent.keyDown(screen.getByRole("radio", { name: /Cebu/ }), { key: " " });
    expect(screen.getByTestId("chosen")).toHaveTextContent("Cebu City");
  });

  it("arrow keys walk the FILTERED list, not the full one", async () => {
    // The bug this rules out: arrowing off the end of a two-row filtered list
    // into a city that is not on screen.
    render(<Harness />);
    await screen.findByRole("radio", { name: /Cebu/ });
    fireEvent.change(screen.getByLabelText("Search city"), { target: { value: "City" } });
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(2));

    const cebu = screen.getByRole("radio", { name: /Cebu/ });
    fireEvent.keyDown(cebu, { key: "ArrowDown" });
    expect(screen.getByTestId("chosen")).toHaveTextContent("Davao City");

    fireEvent.keyDown(screen.getByRole("radio", { name: /Davao/ }), { key: "ArrowDown" });
    expect(screen.getByTestId("chosen")).toHaveTextContent("Cebu City");
  });

  it("lets two pickers coexist by taking a distinct search field id", () => {
    function TwoPickers() {
      const picker = useCityPicker();
      return (
        <>
          <CityPicker
            state={picker}
            value={null}
            onChange={() => {}}
            searchInputId="a"
            searchLabel="A"
          />
          <CityPicker
            state={picker}
            value={null}
            onChange={() => {}}
            searchInputId="b"
            searchLabel="B"
          />
        </>
      );
    }
    render(<TwoPickers />);

    expect(screen.getByLabelText("A")).toHaveAttribute("id", "a");
    expect(screen.getByLabelText("B")).toHaveAttribute("id", "b");
  });
});

// The state hook is separate from the component because the onboarding wizard
// unmounts the city step whenever you move to another step. These pin what that
// separation buys, against a harness with the same mount lifetime.
describe("useCityPicker held above an unmounting picker", () => {
  it("CRITICAL: reads ref_cities once, not once per mount", async () => {
    render(<ToggleHarness />);
    await screen.findByRole("radio", { name: /Cebu/ });
    expect(mocks.cityFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    await screen.findByRole("radio", { name: /Cebu/ });

    expect(mocks.cityFetch).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: keeps the typed search across an unmount", async () => {
    render(<ToggleHarness />);
    await screen.findByRole("radio", { name: /Cebu/ });
    fireEvent.change(screen.getByLabelText("Search city"), { target: { value: "Davao" } });
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));

    expect(screen.getByLabelText("Search city")).toHaveValue("Davao");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("shows the list immediately on remount, with no empty-state flash", async () => {
    render(<ToggleHarness />);
    await screen.findByRole("radio", { name: /Cebu/ });

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));

    expect(screen.queryByText(/No cities match/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(mocks.cities.length);
  });
});
