"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";

import { MapAttribution } from "@/components/maps/map-chrome";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatCoordinates,
  isInsidePhilippines,
  isValidCoordinates,
  roundCoordinate,
  type Coordinates,
} from "@/lib/maps/coordinates";
import {
  GEOCODE_MIN_INTERVAL_MS,
  MIN_QUERY_LENGTH,
  REVERSE_GEOCODE_DEBOUNCE_MS,
  sanitiseQuery,
  type GeocodeResponse,
  type GeocodeResult,
} from "@/lib/maps/geocode-contract";
import { BUSINESS_MAP_ZOOM, isTileSourceConfigured, type MapColorScheme } from "@/lib/maps/tile-source";
import { cn } from "@/lib/utils";

import type { MapControls } from "./leaflet-map";

// ===========================================================================
// THE MERCHANT'S MAP PIN.
//
// Three ways in, because no single one of them works for everybody:
//
//   Search      Type the address, press Search, pick a result. The only path
//               that needs neither GPS nor a steady finger, and therefore the
//               one the whole control degrades to. It is an EXPLICIT submit
//               rather than an as-you-type box, and that is a licence
//               requirement rather than a taste call - see
//               src/lib/maps/geocode.ts for the clause and the reasoning.
//   Detect      One tap, if the merchant is standing in their shop. Every way
//               this can fail is handled below with copy that says what to do
//               next, because a location button that goes quiet is worse than
//               no button.
//   The map     Drag the pin, or tap the spot. The precise correction, for the
//               common case where the geocoder lands the pin on the far side of
//               the street.
//
// ACCESSIBILITY. Search and Detect are ordinary buttons, the results are a list
// of buttons, and the confirmed address and coordinates are text in a live
// region. A merchant can complete this task start to finish without ever
// touching the map: search, pick, read the address back, save. The map is the
// precision tool, not the only tool. Its own container is labelled and says so.
//
// MOBILE SCROLL. The map does not respond to touch until it is deliberately
// activated, so swiping past it scrolls the page like any other block. The
// reasoning is in ./leaflet-map.tsx.
// ===========================================================================

/**
 * Leaflet and its stylesheet live in their own chunk and are fetched only when
 * this section renders. Static-importing ./leaflet-map anywhere would undo
 * that, and would also break the build, since Leaflet touches `window` at
 * module scope and `ssr: false` is what stops it running on the server.
 */
const LeafletMap = dynamic(() => import("./leaflet-map").then((module) => module.LeafletMap), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

/**
 * Where to look when there is no pin yet: the whole archipelago, not a guess at
 * a city. A merchant in Davao opening a map centred on Manila has to recognise
 * that it is wrong before they can fix it; a map of the country is obviously a
 * starting point and invites the search box, which is the path we want anyway.
 */
const PHILIPPINES_VIEW: Coordinates = { lat: 12.8797, lng: 121.774 };
const PHILIPPINES_ZOOM = 5;

export interface LocationPickerProps {
  readonly value: Coordinates | null;
  readonly onChange: (value: Coordinates | null) => void;
  /**
   * The address the merchant has typed into the fields above, used to prefill
   * the search box. Saves retyping the thing they just typed.
   */
  readonly addressHint: string;
}

interface View {
  readonly center: Coordinates;
  readonly zoom: number;
  /** Bumped on every re-centre so identical coordinates still move the map. */
  readonly nonce: number;
}

type GeolocationFailure =
  | "unsupported"
  | "insecure"
  | "denied"
  | "unavailable"
  | "timeout";

/**
 * Every way the browser can decline to give us a position, answered with what
 * the merchant should do instead. None of these is a dead end: search is always
 * there, and every message says so.
 *
 * `insecure` is the one that is usually missed. Geolocation is a secure-context
 * API, and on plain http Chrome does not report "insecure" - it fires
 * PERMISSION_DENIED, which would have us telling a merchant to check a
 * permission prompt that never appeared and cannot appear. So the context is
 * checked BEFORE the call, and gets its own message.
 */
const GEOLOCATION_MESSAGES: Record<GeolocationFailure, string> = {
  unsupported: "This browser cannot detect your location. Search for your address instead.",
  insecure:
    "Detecting your location needs a secure (https) connection, and this page is not on one. Open Giya over https, or search for your address instead.",
  denied:
    "Location is blocked for this site. Allow it in your browser's site settings and try again, or search for your address instead.",
  unavailable:
    "Your device could not get a location fix. Try again near a window or outdoors, or search for your address instead.",
  timeout: "Finding your location took too long. Try again, or search for your address instead.",
};

function messageForPositionError(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return GEOLOCATION_MESSAGES.denied;
  if (error.code === error.TIMEOUT) return GEOLOCATION_MESSAGES.timeout;
  return GEOLOCATION_MESSAGES.unavailable;
}

/**
 * Reads doc 13's envelope. Returns the payload, or a message that is already
 * safe to show a merchant: the API's own `error.message` values are written for
 * end users, so they are passed through rather than replaced with a generic.
 */
async function callGeocode(params: URLSearchParams): Promise<GeocodeResponse | { error: string }> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/geocode?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    return { error: "Could not reach the address service. Check your connection and try again." };
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error?: { message?: unknown } }).error?.message === "string"
        ? (body as { error: { message: string } }).error.message
        : "Address lookup failed. Try again in a moment.";
    return { error: message };
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("data" in body) ||
    typeof (body as { data?: unknown }).data !== "object" ||
    (body as { data: unknown }).data === null
  ) {
    return { error: "Address lookup returned something unexpected. Try again in a moment." };
  }

  const data = (body as { data: { results?: unknown; address?: unknown } }).data;

  return {
    results: Array.isArray(data.results) ? (data.results as GeocodeResult[]) : [],
    address: typeof data.address === "string" ? data.address : null,
  };
}

export function LocationPicker({ value, onChange, addressHint }: LocationPickerProps) {
  const { resolvedTheme } = useTheme();
  // `resolvedTheme` is undefined until next-themes has read the DOM, so the
  // first paint would otherwise request a light tile and immediately replace
  // it with a dark one. Defaulting to light costs one wasted request at most
  // and only on the very first render of the session.
  const scheme: MapColorScheme = resolvedTheme === "dark" ? "dark" : "light";

  const mapConfigured = isTileSourceConfigured();

  const [view, setView] = React.useState<View>(() =>
    value
      ? { center: value, zoom: BUSINESS_MAP_ZOOM, nonce: 0 }
      : { center: PHILIPPINES_VIEW, zoom: PHILIPPINES_ZOOM, nonce: 0 },
  );
  const [mapActive, setMapActive] = React.useState(false);
  const controlsRef = React.useRef<MapControls | null>(null);

  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<readonly GeocodeResult[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [searchMessage, setSearchMessage] = React.useState<string | null>(null);

  const [locating, setLocating] = React.useState(false);
  const [locationError, setLocationError] = React.useState<string | null>(null);

  /**
   * The address text, tagged with the exact pin it describes. Tagged rather
   * than stored bare so that the moment the pin moves, the old address stops
   * being displayed - a label that lags its coordinates by one debounce window
   * is a label that is confidently wrong, and this readout is the thing the
   * merchant is being asked to confirm.
   */
  const [resolved, setResolved] = React.useState<{ key: string; label: string | null } | null>(null);

  const lastRequestAt = React.useRef(0);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const reverseTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Set when the pin was placed from a search result, whose label we already
   * have. Without it, picking a result would immediately spend a reverse
   * lookup to re-derive the address the merchant just chose by name.
   */
  const skipNextReverse = React.useRef(false);

  React.useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (reverseTimer.current) clearTimeout(reverseTimer.current);
    },
    [],
  );

  const pinKey = value ? `${value.lat},${value.lng}` : null;
  const resolvedAddress = resolved !== null && resolved.key === pinKey ? resolved.label : null;

  // --- reverse geocode, debounced on the pin coming to rest ---------------
  React.useEffect(() => {
    if (reverseTimer.current) clearTimeout(reverseTimer.current);
    if (!value || !pinKey) return;
    if (skipNextReverse.current) {
      skipNextReverse.current = false;
      return;
    }

    const target = value;
    const key = pinKey;
    reverseTimer.current = setTimeout(() => {
      reverseTimer.current = null;
      lastRequestAt.current = Date.now();
      void callGeocode(
        new URLSearchParams({ lat: String(target.lat), lng: String(target.lng) }),
      ).then((outcome) => {
        // A failed reverse lookup is deliberately silent. The pin is valid and
        // saveable without a name for it, and an error banner here would tell
        // the merchant something is wrong when nothing is.
        if ("error" in outcome) return;
        setResolved({ key, label: outcome.address });
      });
    }, REVERSE_GEOCODE_DEBOUNCE_MS);
  }, [value, pinKey]);

  function moveTo(next: Coordinates, options: { fromSearch?: boolean } = {}) {
    const rounded = { lat: roundCoordinate(next.lat), lng: roundCoordinate(next.lng) };
    if (!isValidCoordinates(rounded)) return;

    skipNextReverse.current = options.fromSearch === true;
    onChange(rounded);
    setView((previous) => ({
      center: rounded,
      zoom: Math.max(previous.zoom, BUSINESS_MAP_ZOOM),
      nonce: previous.nonce + 1,
    }));
  }

  // --- search -------------------------------------------------------------
  async function runSearch(clean: string) {
    lastRequestAt.current = Date.now();
    const outcome = await callGeocode(new URLSearchParams({ q: clean }));
    setSearching(false);

    if ("error" in outcome) {
      setResults([]);
      setSearchMessage(outcome.error);
      return;
    }

    setResults(outcome.results);
    setSearchMessage(
      outcome.results.length === 0
        ? "No places matched that. Try a nearby landmark, or drop the pin on the map."
        : null,
    );
  }

  function submitSearch() {
    const clean = sanitiseQuery(query);
    if (!clean) {
      setResults([]);
      setSearchMessage(`Type at least ${MIN_QUERY_LENGTH} characters to search.`);
      return;
    }

    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearching(true);
    setSearchMessage(null);

    // Throttled rather than refused: a merchant who presses Search twice gets
    // their second search, a second later, instead of an error telling them
    // about a rate limit they did not know existed.
    const wait = Math.max(0, GEOCODE_MIN_INTERVAL_MS - (Date.now() - lastRequestAt.current));
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      void runSearch(clean);
    }, wait);
  }

  function pickResult(result: GeocodeResult) {
    const rounded = { lat: roundCoordinate(result.lat), lng: roundCoordinate(result.lng) };
    setResults([]);
    setSearchMessage(null);
    // The result already carries its own address, so it is adopted directly
    // rather than spending a reverse lookup to re-derive what the merchant just
    // picked by name. Keyed to the rounded pair, because that is what `moveTo`
    // is about to store.
    setResolved({ key: `${rounded.lat},${rounded.lng}`, label: result.label });
    setQuery(result.label);
    moveTo(rounded, { fromSearch: true });
  }

  // --- detect -------------------------------------------------------------
  function detectLocation() {
    setLocationError(null);

    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setLocationError(GEOLOCATION_MESSAGES.unsupported);
      return;
    }
    // Checked before the call, not after: see GEOLOCATION_MESSAGES.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      setLocationError(GEOLOCATION_MESSAGES.insecure);
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        moveTo({ lat: position.coords.latitude, lng: position.coords.longitude });
      },
      (error) => {
        setLocating(false);
        setLocationError(messageForPositionError(error));
      },
      // High accuracy because a shopfront is a doorway, not a barangay; 15s
      // because a cold GPS fix indoors genuinely takes that long; no cached
      // position, because a merchant pressing this button is asking where they
      // are NOW and a stale fix from another part of town is the wrong answer.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  const outsideMarket = value !== null && !isInsidePhilippines(value);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body-s text-on-surface-variant">
        Drop a pin so customers get directions instead of guessing. Search your address, detect where
        you are now, or tap the map.
      </p>

      {/* Not a <form>: this whole picker lives inside the settings form, and a
          nested form is invalid HTML. Enter is handled on the input instead,
          and every button here is type="button" so none of them can submit the
          profile by accident. */}
      <div className="flex flex-col gap-2">
        <label htmlFor="location-search" className="text-label-l text-on-surface">
          Search for your address
        </label>
        <div className="flex gap-2">
          <input
            id="location-search"
            type="text"
            value={query}
            placeholder={addressHint || "Street, barangay, city"}
            enterKeyHint="search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // Without this, Enter in a text input submits the surrounding
              // settings form and saves the profile mid-search.
              event.preventDefault();
              submitSearch();
            }}
            className={cn(
              "h-12 min-w-0 flex-1 rounded-md3-xs border border-outline bg-surface px-4 text-body-l text-on-surface",
              "placeholder:text-on-surface-variant",
              "outline-none transition-colors duration-200 ease-standard",
              "focus:border-primary focus:ring-1 focus:ring-primary",
            )}
          />
          <Button type="button" variant="tonal" size="touch" onClick={submitSearch} disabled={searching}>
            {searching ? "Searching..." : "Search"}
          </Button>
        </div>
        <p className="text-label-s text-on-surface-variant">
          Address search uses OpenStreetMap&apos;s free geocoder, which allows one lookup a second,
          so results appear when you press Search rather than as you type.
        </p>
      </div>

      {results.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md3-sm border border-outline-variant p-1">
          {results.map((result) => (
            <li key={result.id}>
              <button
                type="button"
                onClick={() => pickResult(result)}
                className={cn(
                  "w-full rounded-md3-xs px-3 py-3 text-left text-body-m text-on-surface",
                  "outline-none transition-colors duration-200 ease-standard hover:bg-surface-container",
                  "focus-visible:ring-2 focus-visible:ring-primary",
                )}
              >
                {result.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* `aria-live` without `role="status"`, here and on the readout below.
          The live-region behaviour is identical, and it leaves `role="status"`
          meaning exactly one thing inside the settings form: the save
          confirmation. Two elements answering to the same landmark role in one
          form is a thing a screen-reader user has to disambiguate by listening. */}
      {searchMessage ? (
        <p aria-live="polite" aria-atomic="true" className="text-body-s text-on-surface-variant">
          {searchMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outlined" size="touch" onClick={detectLocation} disabled={locating}>
          <span aria-hidden className="material-symbols-rounded">
            my_location
          </span>
          {locating ? "Finding you..." : "Use my current location"}
        </Button>
        {value ? (
          <Button
            type="button"
            variant="text"
            size="touch"
            onClick={() => {
              onChange(null);
              setResolved(null);
            }}
          >
            Remove pin
          </Button>
        ) : null}
      </div>

      {locationError ? (
        <p role="alert" className="text-body-s text-error">
          {locationError}
        </p>
      ) : null}

      {mapConfigured ? (
        <div className="relative h-64 w-full overflow-hidden rounded-md3-md border border-outline-variant bg-surface-container">
          <LeafletMap
            center={view.center}
            viewNonce={view.nonce}
            zoom={view.zoom}
            value={value}
            onChange={(next) => moveTo(next)}
            scheme={scheme}
            active={mapActive}
            onReady={(controls) => {
              controlsRef.current = controls;
            }}
          />

          {/* The activation gate. While it is up the map has no gesture
              handlers at all, so a swipe that starts here scrolls the page
              instead of panning the map - which is the failure this exists to
              prevent. It is a real button, so it is also the keyboard entry
              point into the map. */}
          {mapActive ? null : (
            <button
              type="button"
              onClick={() => setMapActive(true)}
              className={cn(
                "absolute inset-0 z-[500] flex items-end justify-center bg-scrim/20 p-3",
                "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
              )}
            >
              <span className="rounded-full bg-surface-container-highest px-4 py-2 text-label-l text-on-surface shadow-md">
                Tap to move the map
              </span>
            </button>
          )}

          {mapActive ? (
            <div className="absolute right-2 top-2 z-[500] flex flex-col gap-2">
              <MapControlButton label="Zoom in" icon="add" onClick={() => controlsRef.current?.zoomIn()} />
              <MapControlButton
                label="Zoom out"
                icon="remove"
                onClick={() => controlsRef.current?.zoomOut()}
              />
              <MapControlButton label="Lock the map" icon="lock" onClick={() => setMapActive(false)} />
            </div>
          ) : null}

          <MapAttribution className="absolute bottom-1 right-1 z-[500]" />
        </div>
      ) : (
        <p className="rounded-md3-sm border border-outline-variant bg-surface-container p-4 text-body-s text-on-surface-variant">
          The map is not available in this environment, so there is no picture to tap. Searching for
          your address and detecting your location both still work, and the coordinates they produce
          are shown below before you save.
        </p>
      )}

      {/* The non-visual path to everything the map conveys: what was chosen,
          and exactly where it is. A live region, because on the search and
          detect paths this text is the only feedback there is. */}
      <div aria-live="polite" aria-atomic="true" className="flex flex-col gap-1">
        {value ? (
          <>
            <p className="text-body-m text-on-surface">
              {resolvedAddress ?? "Pin placed. No street address is on record for this exact spot."}
            </p>
            <p className="text-body-s text-on-surface-variant">
              Coordinates <span className="font-mono">{formatCoordinates(value)}</span>
            </p>
          </>
        ) : (
          <p className="text-body-m text-on-surface-variant">
            No pin yet. Your profile will show your written address only.
          </p>
        )}
      </div>

      {outsideMarket ? (
        <p role="alert" className="text-body-s text-error">
          This pin is outside the Philippines. You can still save it, but check it first: it is
          usually a sign the wrong search result was picked.
        </p>
      ) : null}
    </div>
  );
}

function MapControlButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      // 48px, per doc 16's touch-target floor. Leaflet's own zoom control is
      // 26px, which is why it is switched off in ./leaflet-map.tsx.
      className={cn(
        "flex size-12 items-center justify-center rounded-full bg-surface-container-highest text-on-surface shadow-md",
        "outline-none transition-colors duration-200 ease-standard hover:bg-surface-container-high",
        "focus-visible:ring-2 focus-visible:ring-primary",
      )}
    >
      <span aria-hidden className="material-symbols-rounded">
        {icon}
      </span>
    </button>
  );
}
