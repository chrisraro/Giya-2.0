import type { OpeningHoursEntry } from "./schemas";
import type { BusinessSocials } from "./types";

// Pure parsing for the two jsonb columns the settings screen edits. No server,
// DB or React imports - same rule as src/features/campaigns/types.ts - so the
// form component can import the weekday labels without dragging a Supabase
// client (and its env requirements) into a jsdom render.
//
// Neither `socials` nor `opening_hours` has a DB-level shape constraint, so
// every value coming out of Postgres is treated as `unknown` here and validated
// defensively. Malformed data degrades to an empty field rather than throwing a
// render, exactly as src/lib/hours.ts does for the same column on the public
// business page.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Index 0 is day 1 (Monday), matching the `day` convention used across the app. */
export const WEEKDAY_LABELS: readonly string[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export const DEFAULT_OPEN = "09:00";
export const DEFAULT_CLOSE = "21:00";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function parseSocials(value: unknown): BusinessSocials {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { facebook: null, instagram: null, tiktok: null };
  }
  const record = value as Record<string, unknown>;
  return {
    facebook: readString(record.facebook),
    instagram: readString(record.instagram),
    tiktok: readString(record.tiktok),
  };
}

/**
 * Normalizes `opening_hours` into exactly seven rows, day 1 (Monday) through 7,
 * so the editor always renders a full week. A day the stored value does not
 * cover, or covers malformed, comes back as closed with the default times -
 * never as a missing row the merchant has to notice is missing.
 */
export function parseOpeningHours(value: unknown): OpeningHoursEntry[] {
  const byDay = new Map<number, OpeningHoursEntry>();

  if (Array.isArray(value)) {
    for (const raw of value) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      const day = entry.day;
      if (typeof day !== "number" || day < 1 || day > 7 || byDay.has(day)) continue;

      const open = typeof entry.open === "string" && HHMM.test(entry.open) ? entry.open : DEFAULT_OPEN;
      const close =
        typeof entry.close === "string" && HHMM.test(entry.close) ? entry.close : DEFAULT_CLOSE;

      byDay.set(day, { day, open, close, closed: entry.closed === true });
    }
  }

  return [1, 2, 3, 4, 5, 6, 7].map(
    (day) => byDay.get(day) ?? { day, open: DEFAULT_OPEN, close: DEFAULT_CLOSE, closed: true },
  );
}
