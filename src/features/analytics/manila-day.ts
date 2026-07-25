// ===========================================================================
// THE MANILA DAY, IN TYPESCRIPT.
//
// Doc 40 ("Timezone rule (canon)") defines the day of any event as
// `(event_ts at time zone 'Asia/Manila')::date`, wrapped in SQL as
// `private.manila_day(timestamptz)` (supabase/migrations/0018) so that live
// queries and the nightly rollup can never disagree about what a day is.
//
// This module is that function's ONLY mirror on the app side, and it exists
// because doc 40 also says how a range filter must be expressed:
//
//   "Range filters translate a Manila date range to a UTC timestamptz
//    half-open interval ONCE, AT THE QUERY EDGE (day D => [D 00:00+08,
//    D+1 00:00+08)), so hot-path queries stay sargable on created_at indexes;
//    manila_day() appears only in GROUP BYs over pre-filtered sets, never as a
//    WHERE-clause function over a whole table."
//
// PostgREST cannot call `private.manila_day` (the `private` schema is not
// exposed) and cannot express a functional GROUP BY, so the query edge is
// here: `manilaDayWindow` produces the half-open UTC interval the Supabase
// query filters on, and `manilaDayOf` buckets the returned rows using the
// exact same offset. One offset constant, one definition of a day.
//
// Asia/Manila is UTC+8 all year with no DST, which is why a fixed offset is
// exact rather than an approximation. `private.manila_day` is declared
// IMMUTABLE in 0018 for the same reason.
// ===========================================================================

/** Asia/Manila is UTC+8 year round. No DST has ever been observed since 1978. */
export const MANILA_UTC_OFFSET_MINUTES = 8 * 60;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * A Manila calendar day as `YYYY-MM-DD`.
 *
 * A string rather than a `Date` on purpose: a `Date` is an instant, and an
 * instant carries a timezone question that this type exists to have already
 * answered. Two rows with the same `ManilaDay` are the same business day, and
 * string equality is the whole comparison.
 */
export type ManilaDay = string;

/** Weekday captions, indexed by `Date#getUTCDay()`. */
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * The Manila calendar day an instant falls on.
 *
 * The mirror of `private.manila_day(timestamptz)`: shift the instant by the
 * fixed +08:00 offset and read off the resulting calendar date. A receipt
 * submitted at 2026-07-25T17:00Z is 2026-07-26 01:00 in Manila and belongs to
 * the 26th, which is the distinction the whole module exists to preserve.
 */
export function manilaDayOf(instant: Date): ManilaDay {
  return new Date(instant.getTime() + MANILA_UTC_OFFSET_MINUTES * MINUTE_MS)
    .toISOString()
    .slice(0, 10);
}

/** The UTC instant at which a Manila day begins (its 00:00+08:00). */
export function manilaDayStart(day: ManilaDay): Date {
  return new Date(`${day}T00:00:00.000+08:00`);
}

/** The Manila day `offset` days after `day` (negative offsets go backwards). */
export function shiftManilaDay(day: ManilaDay, offset: number): ManilaDay {
  return new Date(manilaDayStart(day).getTime() + offset * DAY_MS + MANILA_UTC_OFFSET_MINUTES * MINUTE_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * `count` consecutive Manila days ending on `lastDay`, oldest first.
 *
 * The chart's x axis and the KPI window are built from the same call, so the
 * tile and the bars can never describe different stretches of time.
 */
export function manilaDaySeries(lastDay: ManilaDay, count: number): ManilaDay[] {
  const days: ManilaDay[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    days.push(shiftManilaDay(lastDay, -offset));
  }
  return days;
}

/**
 * The half-open UTC interval `[first 00:00+08, last+1 00:00+08)` covering a
 * run of Manila days. This is doc 40's "translate once, at the query edge":
 * everything downstream of it filters on a plain `created_at` comparison and
 * stays on the table's own index.
 */
export function manilaDayWindow(days: readonly ManilaDay[]): { startIso: string; endIso: string } {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("manilaDayWindow needs at least one day");
  }
  return {
    startIso: manilaDayStart(first).toISOString(),
    endIso: manilaDayStart(shiftManilaDay(last, 1)).toISOString(),
  };
}

/** Short weekday caption for a chart axis, e.g. `Mon`. */
export function manilaWeekdayShort(day: ManilaDay): string {
  const index = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return WEEKDAY_SHORT[index] ?? day;
}

/** Full weekday name for an accessible chart description, e.g. `Monday`. */
export function manilaWeekdayLong(day: ManilaDay): string {
  const index = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return WEEKDAY_LONG[index] ?? day;
}
