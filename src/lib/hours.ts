// Renders a business's `opening_hours` jsonb column (an array of per-weekday
// entries) as a single-line summary for the public business page's header.
// The jsonb shape is not enforced by a DB constraint, so every value coming
// out of Postgres is treated as `unknown` here and validated defensively -
// any malformed or missing data degrades to "Hours not set" rather than
// throwing.
//
// `isHoursEntry` and `HoursEntry` are exported for a second, stricter reader:
// `src/features/receipts/closed-hours.ts` (doc 37 S5's closed-hours fraud
// check). That module needs the SAME "malformed or missing means we don't
// know" posture this file already has, and deliberately NOT the posture
// `src/features/businesses/settings/hours.ts`'s `parseOpeningHours` has - that
// normalizer substitutes default times and defaults a missing day to closed,
// which is correct for an EDITOR (it must always render seven fillable rows)
// and wrong for a CHECK that would otherwise fabricate a "closed 09:00-21:00"
// fact nobody ever entered and score a real purchase against it.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// 1 (Monday) - 7 (Sunday), matching the `days` convention already used by
// src/features/menu/schemas.ts's availabilityWindowSchema.
export type HoursEntry = {
  day: number;
  open: string;
  close: string;
  closed?: boolean;
};

export function isHoursEntry(value: unknown): value is HoursEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.day !== "number" || candidate.day < 1 || candidate.day > 7) return false;
  if (candidate.closed === true) return true;

  return (
    typeof candidate.open === "string" &&
    HHMM.test(candidate.open) &&
    typeof candidate.close === "string" &&
    HHMM.test(candidate.close)
  );
}

const MANILA_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Returns today's 1 (Monday) - 7 (Sunday) weekday number in Asia/Manila. */
function currentManilaWeekday(now: Date): number {
  const weekdayShort = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    weekday: "short",
  }).format(now);

  return MANILA_WEEKDAY[weekdayShort] ?? 1;
}

/**
 * Formats a business's opening_hours jsonb into a short header caption:
 * "Open today until 22:00", "Closed today", or "Hours not set" when the
 * value is empty, malformed, or has no entry for today. `now` defaults to
 * the real current time and is only overridden by tests.
 */
export function formatHoursSummary(openingHours: unknown, now: Date = new Date()): string {
  if (!Array.isArray(openingHours) || openingHours.length === 0) return "Hours not set";

  const today = currentManilaWeekday(now);
  const todayEntry = openingHours.find(
    (entry): entry is HoursEntry => isHoursEntry(entry) && entry.day === today,
  );

  if (!todayEntry) return "Hours not set";
  if (todayEntry.closed) return "Closed today";

  return `Open today until ${todayEntry.close}`;
}
