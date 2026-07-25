// Pure, timezone-correct day-boundary helpers for campaign schedule windows
// (docs/30-modules/34-campaign-engine.md section 3). ZERO IO: given a
// "YYYY-MM-DD" wall-clock date string and an IANA time zone name, these
// compute the UTC instant of that day's start/end AS INTERPRETED IN THAT
// ZONE, regardless of the host machine's own timezone. This is what lets an
// owner using a browser in any timezone pick "Aug 1" and have it mean Aug 1
// in the campaign's own timezone (Asia/Manila today), not Aug 1 in whatever
// zone their browser happens to be running in.
//
// `isCampaignLive` (./lifecycle.ts) treats `startsAt` as inclusive and
// `endsAt` as EXCLUSIVE, so an owner picking "End date: Aug 1" must store an
// `endsAt` of "Aug 2 00:00:00" in the campaign's zone (not "Aug 1 00:00:00",
// which would make the campaign expire before its advertised last day even
// begins).

/** The single timezone campaigns operate in today. Every caller reads the
 * zone from here rather than hardcoding "Asia/Manila" inline, so the day a
 * business gets its own timezone column this is the one constant that
 * changes (threaded through as a parameter, not read implicitly). */
export const CAMPAIGN_TIMEZONE = "Asia/Manila";

const DATE_STRING_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LONG_OFFSET_PATTERN = /GMT([+-])(\d{2}):(\d{2})/;

interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function parseDateString(dateString: string): CalendarDate {
  const match = DATE_STRING_PATTERN.exec(dateString);
  if (!match) {
    throw new Error(`Invalid date string "${dateString}"; expected "YYYY-MM-DD"`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  return { year: Number(yearStr), month: Number(monthStr), day: Number(dayStr) };
}

function formatDateString({ year, month, day }: CalendarDate): string {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** The calendar date one day after `dateString`. Pure calendar arithmetic
 * (via `Date.UTC`'s day-rollover), unrelated to any timezone - it never
 * looks at wall-clock hours, just the Y/M/D triple. */
function nextCalendarDateString(dateString: string): string {
  const { year, month, day } = parseDateString(dateString);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return formatDateString({
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  });
}

/** Minutes east of UTC for `timeZone` at the instant `at` (e.g. +480 for
 * Asia/Manila's UTC+8; negative west of UTC). Reads Intl's "longOffset"
 * form ("GMT+08:00") rather than a zone abbreviation, which would be
 * ambiguous and locale-dependent. */
function offsetMinutesAt(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const offsetName = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = LONG_OFFSET_PATTERN.exec(offsetName);
  if (!match) return 0;
  const [, sign, hoursStr, minutesStr] = match;
  const magnitude = Number(hoursStr) * 60 + Number(minutesStr);
  return sign === "-" ? -magnitude : magnitude;
}

/**
 * The UTC instant corresponding to `hour:00:00` wall-clock time on
 * `dateString`, as read in `timeZone`. This never consults the host's own
 * timezone (unlike `new Date("YYYY-MM-DDT00:00:00")`, which resolves in
 * whatever zone the JS engine is running in) - `timeZone` is the only zone
 * that matters, always passed in explicitly.
 *
 * Resolves the zone's UTC offset via a fixed-point pass (look up the offset
 * from a first guess, then re-look-up from the corrected instant) so a DST
 * transition landing near the target instant still resolves against the
 * offset that instant actually falls under. Irrelevant for Asia/Manila
 * (UTC+8, no DST) but keeps this correct for any IANA zone.
 */
function zonedWallTimeToUtc(dateString: string, hour: number, timeZone: string): Date {
  const { year, month, day } = parseDateString(dateString);
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, 0, 0, 0);

  const firstOffset = offsetMinutesAt(new Date(naiveUtcMs), timeZone);
  const candidateMs = naiveUtcMs - firstOffset * 60_000;

  const secondOffset = offsetMinutesAt(new Date(candidateMs), timeZone);
  return new Date(naiveUtcMs - secondOffset * 60_000);
}

/**
 * Start of `dateString` (00:00:00) in `timeZone`, as a UTC instant. This is
 * the campaign's inclusive lower bound - `isCampaignLive` treats `startsAt`
 * as inclusive.
 */
export function startOfDayInZone(dateString: string, timeZone: string): Date {
  return zonedWallTimeToUtc(dateString, 0, timeZone);
}

/**
 * The instant one full day after `dateString` (00:00:00 of the NEXT day) in
 * `timeZone`, as a UTC instant. This is the campaign's EXCLUSIVE upper
 * bound (`isCampaignLive` treats `endsAt` as exclusive: `at >= endsAt` is
 * not live), so an owner picking "End date: Aug 1" keeps the campaign live
 * through all of Aug 1 in the zone - live at 23:59:59 on Aug 1, not live
 * from 00:00:00 on Aug 2 onward.
 */
export function endOfDayExclusiveInZone(dateString: string, timeZone: string): Date {
  return zonedWallTimeToUtc(nextCalendarDateString(dateString), 0, timeZone);
}
