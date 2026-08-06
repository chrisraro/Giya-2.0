"use client";

import * as React from "react";

import { TextField } from "@/components/ui/text-field";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// The city picker, extracted from the onboarding wizard rather than forked.
//
// It lived inline in src/app/(auth)/onboarding/page.tsx as a local `CityStep`
// plus a `useCities` hook, with the search string, the roving-focus refs and the
// arrow-key handler split between the step and the page component around it.
// /profile/edit needs the same control, and a second copy would be a second
// place for the ref_cities read, the filter and the keyboard behaviour to drift.
// So the whole thing moved here as a controlled component and onboarding now
// renders it; onboarding's own tests (page.test.tsx) are the proof the move
// changed no behaviour.
//
// Controlled on purpose: the selected city is state the CALLER owns.
// Onboarding gates its Continue button on it and sends it to
// completeConsumerOnboarding; the edit form sends it to saveConsumerProfile.
//
// THE LOADED LIST AND THE SEARCH TEXT ARE ALSO THE CALLER'S, through
// `useCityPicker()`, and that is not decoration. The onboarding wizard mounts
// the city step only while `step === 1`. When this component owned the fetch and
// the search string internally, every trip to Interests and back UNMOUNTED it:
// ref_cities was read again on each return, the list started empty so the
// "No cities match" empty state flashed during the refetch, and whatever had
// been typed was gone. None of that happened before the extraction, because both
// pieces of state lived in the page component, which stays mounted for the whole
// wizard. Splitting the hook out puts them back there without giving anyone a
// second copy of the query.
//
// The roving-focus refs stay internal: they are DOM handles for the rows this
// render produced, and they are meaningless across an unmount.

/**
 * The active cities from `ref_cities`, by name, alphabetically.
 *
 * Reads the table rather than holding a literal. This used to be
 * `const CITIES = ["Cebu", "Manila", "Davao", "Iloilo", "Baguio",
 * "Cagayan de Oro"]`, a client-side copy of the six-row stub seed in
 * 0002_identity.sql; 0027_reference_data.sql seeds all 149 chartered Philippine
 * cities and that seed reached nobody through a literal, so a consumer in Naga
 * or Bacolod had no way to say where they live.
 *
 * `ref_cities` carries a public select policy (`ref_cities_public_select`), so
 * the browser client can read it without a session - which onboarding needs,
 * since it runs before the profile exists.
 *
 * The names are unique by construction (0027 disambiguates San Fernando, San
 * Carlos, Talisay and Naga with a parenthesised province) because both writers
 * resolve the chosen name with `.ilike(...).maybeSingle()`, which raises on a
 * tie.
 */
export interface CityPickerState {
  /** Every active city name, alphabetically. Empty until the read lands. */
  readonly cities: string[];
  readonly search: string;
  readonly setSearch: (value: string) => void;
}

/**
 * Hold this in a component that stays mounted for as long as the picker should
 * remember anything - the wizard shell, the edit form - and hand it to
 * `<CityPicker state={...} />`. See the note at the top of this file for the
 * regression that makes the placement load-bearing rather than stylistic.
 */
export function useCityPicker(): CityPickerState {
  const [cities, setCities] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await createClient()
        .from("ref_cities")
        .select("name")
        .eq("is_active", true)
        .order("name");
      if (!cancelled && data) setCities(data.map((row) => row.name));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { cities, search, setSearch };
}

export interface CityPickerProps {
  /** From `useCityPicker()`, held by a component that outlives this one. */
  readonly state: CityPickerState;
  /** The chosen city NAME, or null when none is chosen yet. */
  readonly value: string | null;
  readonly onChange: (city: string) => void;
  /** Id for the search input; distinct per screen so two can coexist. */
  readonly searchInputId?: string;
  readonly searchLabel?: string;
  readonly groupLabel?: string;
}

export function CityPicker({
  state,
  value,
  onChange,
  searchInputId = "city-search",
  searchLabel = "Search city",
  groupLabel = "Your city",
}: CityPickerProps) {
  const { cities, search, setSearch } = state;
  const itemRefs = React.useRef<Record<string, HTMLDivElement | null>>({});

  const filtered = React.useMemo(
    () => cities.filter((city) => city.toLowerCase().includes(search.trim().toLowerCase())),
    [cities, search],
  );

  // Roving tabindex: the selected row is the tab stop, and when the selection is
  // filtered out of view the first row stands in, so the group is never a
  // keyboard dead end.
  const selectedVisible = value !== null && filtered.includes(value);

  function moveSelection(direction: 1 | -1): void {
    if (filtered.length === 0) return;
    const current = filtered.findIndex((city) => city === value);
    const from = current === -1 ? 0 : current;
    const next = filtered[(from + direction + filtered.length) % filtered.length];
    if (next === undefined) return;
    onChange(next);
    itemRefs.current[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      <TextField
        id={searchInputId}
        label={searchLabel}
        placeholder="Type a city name"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div
        role="radiogroup"
        aria-label={groupLabel}
        className="flex max-h-64 flex-col gap-2 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <p className="py-4 text-center text-body-m text-on-surface-variant">
            No cities match &quot;{search}&quot;.
          </p>
        ) : (
          filtered.map((city, index) => {
            const isSelected = city === value;
            const isRovingFallback = !selectedVisible && index === 0;
            return (
              <div
                key={city}
                ref={(el) => {
                  itemRefs.current[city] = el;
                }}
                role="radio"
                aria-checked={isSelected}
                tabIndex={isSelected || isRovingFallback ? 0 : -1}
                onClick={() => onChange(city)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onChange(city);
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveSelection(1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveSelection(-1);
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-center justify-between rounded-md3-md border px-4 py-3 text-left",
                  "outline-none transition-colors duration-200 ease-standard",
                  "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
                  isSelected
                    ? "border-primary bg-primary-container/40"
                    : "border-outline-variant bg-surface hover:bg-surface-container",
                )}
              >
                <span className="text-body-l text-on-surface">{city}</span>
                {isSelected ? (
                  <span aria-hidden className="material-symbols-rounded is-filled text-primary">
                    check_circle
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
