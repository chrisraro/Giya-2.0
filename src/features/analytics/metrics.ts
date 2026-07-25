import {
  manilaDayOf,
  manilaWeekdayLong,
  manilaWeekdayShort,
  type ManilaDay,
} from "./manila-day";
import type { DailyCount, KpiDelta } from "./types";

// ===========================================================================
// PURE METRIC ARITHMETIC.
//
// Every function here takes rows and returns numbers or strings. No Supabase
// client, no clock of its own, no formatting decisions hidden inside a query.
// Doc 40 closes its reference queries with "the SQL here is documentation of
// intent, the code is the artifact", and this file is the artifact.
// ===========================================================================

/** A ledger row, narrowed to the columns any metric here actually reads. */
export interface LedgerEntry {
  consumerId: string;
  points: number;
  createdAt: string;
}

/**
 * Doc 40 VISIT: "a distinct `(user_id, business_id, manila_day)` with >= 1
 * approved receipt. Multiple same-day approved receipts at the same business
 * = 1 visit ... splitting one purchase into three receipts buys points, never
 * extra visits."
 *
 * The business_id half of the key is already answered by the caller (every
 * query that produced these rows was scoped to one business), so the dedup
 * key here is `(consumerId, manilaDay)`.
 */
export function countVisits(entries: readonly LedgerEntry[]): number {
  return visitKeys(entries).size;
}

function visitKeys(entries: readonly LedgerEntry[]): Set<string> {
  const seen = new Set<string>();
  for (const entry of entries) {
    seen.add(`${entry.consumerId}|${manilaDayOf(new Date(entry.createdAt))}`);
  }
  return seen;
}

/**
 * Visits per Manila day across an explicit run of days.
 *
 * `days` is passed in rather than derived from the rows so that a day with no
 * activity still produces a bar. A chart of seven zeros is the correct picture
 * of a merchant's first week and is worth far more than an invented one.
 */
export function visitsByDay(
  entries: readonly LedgerEntry[],
  days: readonly ManilaDay[],
): DailyCount[] {
  const perDay = new Map<ManilaDay, Set<string>>();
  for (const day of days) perDay.set(day, new Set());

  for (const entry of entries) {
    const day = manilaDayOf(new Date(entry.createdAt));
    perDay.get(day)?.add(entry.consumerId);
  }

  return days.map((day) => ({
    day: manilaWeekdayShort(day),
    value: perDay.get(day)?.size ?? 0,
  }));
}

/** Doc 40: "Points issued = `sum(points) where type='earn'`". */
export function sumPoints(entries: readonly LedgerEntry[]): number {
  return entries.reduce((total, entry) => total + entry.points, 0);
}

/** Ledger rows whose Manila day falls inside `days`. */
export function entriesWithin(
  entries: readonly LedgerEntry[],
  days: readonly ManilaDay[],
): LedgerEntry[] {
  const wanted = new Set(days);
  return entries.filter((entry) => wanted.has(manilaDayOf(new Date(entry.createdAt))));
}

// ---------------------------------------------------------------- comparison

/**
 * The honest period comparison.
 *
 * A percentage change needs a previous period with something in it. When the
 * previous window is empty the change is not "0%", not "+100%" and not
 * "+12% vs last week": it is arithmetically undefined, and the only truthful
 * rendering is to say there is nothing to compare against yet. That is a
 * `muted` delta, so it reads as context rather than as a measurement or an
 * error.
 *
 * The wording says "previous 7 days", not "last week", because the windows
 * this compares are ROLLING seven-day windows. Comparing a partial Monday-to-
 * today week against a complete Monday-to-Sunday one manufactures a decline
 * every Monday morning, which is precisely the class of invented trend this
 * change exists to remove.
 */
export function periodDelta(current: number, previous: number): KpiDelta {
  if (previous <= 0) {
    return { text: "No comparison yet", tone: "muted" };
  }

  const percent = Math.round(((current - previous) / previous) * 100);
  if (percent === 0) {
    return { text: "Level with the previous 7 days", tone: "trend" };
  }

  const sign = percent > 0 ? "+" : "-";
  return { text: `${sign}${Math.abs(percent)}% vs previous 7 days`, tone: "trend" };
}

// ---------------------------------------------------------------- formatting

/**
 * Philippine thousands grouping, pinned to a fixed locale so the server and
 * the client hydrate to the same string.
 */
export function formatCount(value: number, capped = false): string {
  return `${value.toLocaleString("en-PH")}${capped ? "+" : ""}`;
}

/** `1` -> `1 point`, everything else -> `N points`. */
export function formatPoints(value: number): string {
  return `${value.toLocaleString("en-PH")} ${Math.abs(value) === 1 ? "point" : "points"}`;
}

/**
 * Coarse relative time for the activity feed.
 *
 * Deliberately coarse: the feed is server-rendered, so a "2 min ago" is stale
 * the moment it is painted. Buckets this wide stay true for as long as the
 * page is likely to be open, and nothing here claims a precision the render
 * model cannot keep.
 */
export function relativeTime(instant: Date, now: Date): string {
  const elapsedMs = now.getTime() - instant.getTime();
  if (elapsedMs < 0) return "Just now";

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;

  return manilaDayOf(instant);
}

/**
 * Accessible description of the visits chart.
 *
 * When every bar is zero the label says so instead of naming a "highest" day,
 * because "highest Monday" over a row of zeros is a claim about a pattern that
 * does not exist.
 */
export function visitsChartLabel(counts: readonly DailyCount[], days: readonly ManilaDay[]): string {
  const total = counts.reduce((sum, entry) => sum + entry.value, 0);
  if (total === 0) return "Visits per day for the last 7 days, no visits recorded yet";

  let busiestIndex = 0;
  counts.forEach((entry, index) => {
    const busiest = counts[busiestIndex];
    if (busiest !== undefined && entry.value > busiest.value) busiestIndex = index;
  });

  const busiestDay = days[busiestIndex];
  const name = busiestDay === undefined ? counts[busiestIndex]?.day : manilaWeekdayLong(busiestDay);
  return `Visits per day for the last 7 days, highest ${name ?? "unknown"}`;
}
