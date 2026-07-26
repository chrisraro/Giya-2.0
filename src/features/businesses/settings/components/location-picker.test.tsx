import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocationPicker } from "./location-picker";

// The merchant's pin. Leaflet itself is mocked away: it is loaded through
// `next/dynamic` and needs a real layout engine to do anything meaningful, and
// none of the behaviour worth testing here lives inside it. What is worth
// testing is everything AROUND the map - the paths a merchant can take when
// they will not or cannot use it.

vi.mock("./leaflet-map", () => ({
  LeafletMap: (props: { value: { lat: number; lng: number } | null; active: boolean }) => (
    <div data-testid="leaflet-map" data-active={String(props.active)}>
      {props.value ? `pin:${props.value.lat},${props.value.lng}` : "no-pin"}
    </div>
  ),
}));

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

const CEBU = { lat: 10.3156, lng: 123.8854 };

/** Matched loosely because the label becomes "Searching..." while in flight. */
function searchButton(): HTMLElement {
  return screen.getByRole("button", { name: /^search/i });
}

const fetchMock = vi.fn();

function geocodeResponds(data: unknown, status = 200) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (status >= 400 ? data : { data, meta: {} }),
  });
}

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof LocationPicker>> = {},
): { onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  render(
    <LocationPicker value={null} onChange={onChange} addressHint="12 Real Street" {...overrides} />,
  );
  return { onChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "test-key");
  // jsdom leaves `isSecureContext` undefined; the picker only reacts to an
  // explicit `false`, so the default here is "secure", as on https or localhost.
  vi.stubGlobal("isSecureContext", true);
  geocodeResponds({ results: [], address: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ===================================================== the non-visual path

describe("completing the task without touching the map", () => {
  it("searches on an explicit submit, not per keystroke", async () => {
    renderPicker();

    fireEvent.change(screen.getByLabelText("Search for your address"), {
      target: { value: "12 Real Street Cebu" },
    });

    // The Nominatim policy names client-side autocomplete as unacceptable use,
    // so typing must cost nothing at all.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(searchButton());
    await vi.advanceTimersByTimeAsync(1_100);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("q=12+Real+Street+Cebu");
  });

  it("searches on Enter without submitting the surrounding settings form", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const onChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <LocationPicker value={null} onChange={onChange} addressHint="" />
      </form>,
    );

    fireEvent.change(screen.getByLabelText("Search for your address"), {
      target: { value: "12 Real Street" },
    });
    fireEvent.keyDown(screen.getByLabelText("Search for your address"), { key: "Enter" });
    await vi.advanceTimersByTimeAsync(1_100);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Without preventDefault, Enter in a text input saves the whole profile
    // mid-search.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("places the pin from a picked result, so the map is never required", async () => {
    geocodeResponds({
      results: [{ id: "1", label: "12 Real Street, Cebu City", lat: CEBU.lat, lng: CEBU.lng }],
      address: null,
    });
    const { onChange } = renderPicker();

    fireEvent.change(screen.getByLabelText("Search for your address"), {
      target: { value: "12 Real Street" },
    });
    fireEvent.click(searchButton());
    await vi.advanceTimersByTimeAsync(1_100);

    const result = await screen.findByRole("button", { name: "12 Real Street, Cebu City" });
    fireEvent.click(result);

    expect(onChange).toHaveBeenCalledWith(CEBU);
  });

  it("says so plainly when nothing matched, and suggests the way forward", async () => {
    geocodeResponds({ results: [], address: null });
    renderPicker();

    fireEvent.change(screen.getByLabelText("Search for your address"), {
      target: { value: "nowhere at all" },
    });
    fireEvent.click(searchButton());
    await vi.advanceTimersByTimeAsync(1_100);

    expect(await screen.findByText(/No places matched/i)).toBeInTheDocument();
  });

  it("refuses a query too short to search without spending a request", async () => {
    renderPicker();

    fireEvent.change(screen.getByLabelText("Search for your address"), { target: { value: "ab" } });
    fireEvent.click(searchButton());
    await vi.advanceTimersByTimeAsync(1_100);

    expect(await screen.findByText(/at least 3 characters/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's own refusal rather than a generic failure", async () => {
    geocodeResponds({ error: { code: "RATE_LIMITED", message: "Address lookup is busy." } }, 429);
    renderPicker();

    fireEvent.change(screen.getByLabelText("Search for your address"), {
      target: { value: "12 Real Street" },
    });
    fireEvent.click(searchButton());
    await vi.advanceTimersByTimeAsync(1_100);

    expect(await screen.findByText("Address lookup is busy.")).toBeInTheDocument();
  });

  it("throttles two submits to one request a second rather than rejecting the second", async () => {
    renderPicker();

    fireEvent.change(screen.getByLabelText("Search for your address"), {
      target: { value: "12 Real Street" },
    });
    // Submitted with Enter rather than the button, because the button disables
    // itself while a lookup is in flight and this test is about the throttle
    // underneath it: the floor holds even for a merchant leaning on the key.
    const input = screen.getByLabelText("Search for your address");

    // The first lookup of the session is not delayed at all.
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: "Enter" });
    // Not yet: the second lookup waits out the policy's one-second window...
    await vi.advanceTimersByTimeAsync(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ...and then happens, rather than being refused with an error the merchant
    // did not cause and cannot act on.
    await vi.advanceTimersByTimeAsync(900);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// =========================================================== auto-detect

describe("auto-detect", () => {
  it("centres on the merchant's position", async () => {
    const getCurrentPosition = vi.fn(
      (success: PositionCallback) =>
        void success({ coords: { latitude: CEBU.lat, longitude: CEBU.lng } } as GeolocationPosition),
    );
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    const { onChange } = renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /use my current location/i }));

    expect(onChange).toHaveBeenCalledWith(CEBU);
  });

  it("asks for a fresh, high-accuracy fix rather than a cached one", () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /use my current location/i }));

    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      // A shopfront is a doorway, not a barangay, and a stale fix from the
      // other side of town is the wrong answer to "where am I now".
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });

  it.each([
    [1, /blocked/i],
    [2, /could not get a location fix/i],
    [3, /took too long/i],
  ])("explains error code %s and names the way out", async (code, pattern) => {
    const getCurrentPosition = vi.fn(
      (_success: PositionCallback, failure?: PositionErrorCallback | null) =>
        void failure?.({
          code,
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
          message: "",
        } as GeolocationPositionError),
    );
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /use my current location/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(pattern);
    // Every failure message points at search, so the button is never a dead end.
    expect(alert.textContent ?? "").toMatch(/search for your address/i);
  });

  it("says the connection is the problem on plain http, rather than blaming a permission", async () => {
    // Chrome fires PERMISSION_DENIED on an insecure origin, which would have us
    // telling a merchant to check a prompt that cannot appear. So the context is
    // checked first and gets its own message.
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    vi.stubGlobal("isSecureContext", false);
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /use my current location/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/secure \(https\) connection/i);
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("says so when the browser has no geolocation at all", async () => {
    vi.stubGlobal("navigator", {});
    renderPicker();

    fireEvent.click(screen.getByRole("button", { name: /use my current location/i }));

    expect((await screen.findByRole("alert")).textContent ?? "").toMatch(
      /cannot detect your location/i,
    );
  });
});

// ============================================================ the readout

describe("the readout", () => {
  it("says there is no pin rather than showing an empty coordinate", () => {
    renderPicker();

    expect(screen.getByText(/No pin yet/i)).toBeInTheDocument();
  });

  it("shows the coordinates as text so the merchant can confirm before saving", () => {
    renderPicker({ value: CEBU });

    expect(screen.getByText("10.315600, 123.885400")).toBeInTheDocument();
  });

  it("warns about a pin outside the Philippines without preventing the save", () => {
    renderPicker({ value: { lat: 1.3521, lng: 103.8198 } });

    const alert = screen.getByRole("alert");
    expect(alert.textContent ?? "").toMatch(/outside the Philippines/i);
    expect(alert.textContent ?? "").toMatch(/still save it/i);
  });

  it("does not warn about a pin inside the market", () => {
    renderPicker({ value: CEBU });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the pin on request", () => {
    const { onChange } = renderPicker({ value: CEBU });

    fireEvent.click(screen.getByRole("button", { name: "Remove pin" }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("offers no Remove pin control when there is nothing to remove", () => {
    renderPicker();

    expect(screen.queryByRole("button", { name: "Remove pin" })).not.toBeInTheDocument();
  });
});

// ======================================================= mobile and no-key

describe("the map frame", () => {
  it("starts inert, so a swipe past it scrolls the page instead of panning", () => {
    renderPicker({ value: CEBU });

    expect(screen.getByTestId("leaflet-map").dataset.active).toBe("false");
    expect(screen.getByRole("button", { name: /tap to move the map/i })).toBeInTheDocument();
  });

  it("hands gestures over on a deliberate tap, and offers a way to lock it again", () => {
    renderPicker({ value: CEBU });

    fireEvent.click(screen.getByRole("button", { name: /tap to move the map/i }));

    expect(screen.getByTestId("leaflet-map").dataset.active).toBe("true");
    expect(screen.getByRole("button", { name: "Lock the map" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeInTheDocument();
  });

  it("renders no map, and says why, when there is no tile key", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_KEY", "");
    renderPicker({ value: CEBU });

    expect(screen.queryByTestId("leaflet-map")).not.toBeInTheDocument();
    expect(screen.getByText(/map is not available in this environment/i)).toBeInTheDocument();
    // Search and detect need no basemap, so both survive.
    expect(screen.getByLabelText("Search for your address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use my current location/i })).toBeInTheDocument();
    expect(screen.getByText("10.315600, 123.885400")).toBeInTheDocument();
  });
});
