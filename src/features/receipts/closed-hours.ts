import { deriveLocalDayTime } from "@/features/points/compute";

import { parseOpeningHours } from "../businesses/settings/hours";
import type { OpeningHoursEntry } from "../businesses/settings/schemas";

import { buildSignal } from "./fraud";
import type { FraudSignal } from "./fraud";

// ===========================================================================
// Doc 37 S5's third case (docs/30-modules/37-fraud-detection.md): a receipt
// whose printed time falls when the business's own STATED hours say it was
// closed. The other two S5 cases (future-dated, too-old) are implemented in
// `server/process.ts`'s `validateParsedReceipt`; this one was the missing
// MVP piece (see the receipts README's "S5 closed-hours is not implemented"
// debt entry, which this file resolves).
//
// ZERO IO, exactly like fraud.ts and velocity.ts: `server/process.ts` reads
// `parsed.receiptDate` / `parsed.timeExtracted` (`../parse.ts`) and
// `businesses.opening_hours` itself and hands both to `checkClosedHours`.
// Scoring and routing stay fraud.ts's job - this module only ever decides
// whether ONE signal fires, using the catalog's existing
// `timestamp_closed_hours` case (severity warn, score 0.4, doc 37's table).
//
// NULL MEANS "THE CHECK DID NOT RUN," NEVER "THE CHECK PASSED" - the same D3
// principle `../review/merchant-check.test.tsx` pins for the merchant-name
// check. `checkClosedHours` returns null, not a signal, in every case where
// the comparison is not meaningful:
//
//   * no time was actually printed on the receipt (`timeExtracted` false -
//     `extractDate`'s noon default is a placeholder, not a fact);
//   * the business has no configured hours at all. `businesses.opening_hours`
//     is `jsonb not null default '[]'` with NO DB-level shape constraint
//     (0002:218-219, confirmed at `../businesses/settings/hours.ts:9`), so an
//     empty array is the default state of every business that has never
//     opened the hours editor - the overwhelming majority of the platform -
//     and must read as "we were never told," never as "closed every day."
//     `parseOpeningHours` on its own cannot make this distinction (it
//     normalizes ANY input, including `[]` or a page of garbage, into seven
//     rows defaulted to closed), so this module asks the question BEFORE
//     normalizing: the raw value has to be a non-empty array, and even then
//     the normalized week has to contain at least one open day, or the check
//     stands down rather than flagging every receipt at that business;
//   * the compared day resolves to a 24-hour business. `open === close` (doc
//     32 section 4's own convention, no extra flag) always resolves to "the
//     whole day is inside the window" under the arithmetic below, so this
//     needs no special case - it falls out of the general rule.
//
// OVERNIGHT WINDOWS. `close <= open` means "past midnight" (0032 section 4:
// "close < open renders 'until 02:00 +1'"). A receipt printed at 01:00
// belongs to TOMORROW's calendar weekday but TONIGHT's opening window, so the
// window this module tests against is built from BOTH the receipt's own
// weekday and the weekday before it - never the receipt's weekday alone. This
// is the case doc 37 S5 is most often got wrong on, so it is exhaustively
// covered in closed-hours.test.ts rather than only implied by the arithmetic.
//
// THE GRACE MARGIN. Doc 37 S5: "receipts print late, staff close late" - a
// flat 60 minutes on both ends of whichever window applies, added AFTER the
// overnight roll so a grace-widened overnight window still spans the correct
// wall-clock range rather than wrapping twice.
// ===========================================================================

const RECEIPT_TIMEZONE = "Asia/Manila";

/** Doc 37 S5's stated margin. */
export const CLOSED_HOURS_GRACE_MINUTES = 60;

const MINUTES_PER_DAY = 24 * 60;

function minutesOf(hhmm: string): number {
  const [hourText, minuteText] = hhmm.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

/**
 * One day's opening window as an ABSOLUTE minute range, where minute 0 is
 * the RECEIPT's own midnight - so a `dayIndex` of -1 (the day before the
 * receipt) and 0 (the receipt's own day) both land on the same timeline a
 * single `minutesOfDay` value (0-1439) can be tested against. Null for a day
 * the business states it is closed.
 *
 * `close <= open` (in the entry's own 0-1439 terms) rolls the close past
 * `dayIndex`'s day, which is what lets an evening window spill into the next
 * day's early hours. `open === close` rolls a full 1440 minutes forward,
 * i.e. the entire day - the 24-hour case, with no separate flag needed.
 */
function dayWindow(entry: OpeningHoursEntry, dayIndex: number): [number, number] | null {
  if (entry.closed) return null;
  const base = dayIndex * MINUTES_PER_DAY;
  const openMinute = minutesOf(entry.open);
  const closeMinute = minutesOf(entry.close);
  const open = base + openMinute;
  const close = base + (closeMinute <= openMinute ? closeMinute + MINUTES_PER_DAY : closeMinute);
  return [open, close];
}

/** 1 (Monday) - 7 (Sunday), wrapping Monday's "yesterday" to Sunday. */
function previousWeekday(weekday: number): number {
  return weekday === 1 ? 7 : weekday - 1;
}

function formatHHMM(minutesOfDay: number): string {
  const normalized = ((minutesOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export interface ClosedHoursCheckInput {
  /** `parse.ts`'s reading of the printed receipt, as a UTC instant. */
  receiptDate: Date;
  /**
   * `../parse.ts`'s `ParsedReceipt.timeExtracted`: whether `receiptDate`'s
   * time-of-day came from a real HH:mm token on the receipt, as opposed to
   * `extractDate`'s noon default. False (or a defaulted noon) must never
   * drive this check - see the D3 note above.
   */
  timeExtracted: boolean;
  /**
   * `businesses.opening_hours`, exactly as read from Postgres: `jsonb not
   * null default '[]'`, no DB-level shape constraint (0002:218-219). Passed
   * through `unknown` on purpose - this module decides for itself whether the
   * value is usable rather than trusting a caller's cast.
   */
  openingHours: unknown;
}

/**
 * Doc 37 S5's closed-hours case, as a ready-to-persist `FraudSignal`, or null
 * when the check could not meaningfully run (see the header for the three
 * reasons) or when the receipt's time falls inside the business's stated
 * hours (with the grace margin applied).
 */
export function checkClosedHours(input: ClosedHoursCheckInput): FraudSignal | null {
  if (!input.timeExtracted) return null;
  if (!Array.isArray(input.openingHours) || input.openingHours.length === 0) return null;

  const hours = parseOpeningHours(input.openingHours);
  // A raw array that normalizes to "closed every day" is indistinguishable
  // from garbage input `parseOpeningHours` could not read (see the header) -
  // treated the same as no configured hours, never as a week-long closure.
  if (hours.every((entry) => entry.closed)) return null;

  const { weekday, minutesOfDay } = deriveLocalDayTime(input.receiptDate, RECEIPT_TIMEZONE);

  const today = hours.find((entry) => entry.day === weekday) ?? null;
  const yesterday = hours.find((entry) => entry.day === previousWeekday(weekday)) ?? null;

  const windows: Array<[number, number]> = [];
  if (today !== null) {
    const window = dayWindow(today, 0);
    if (window !== null) windows.push(window);
  }
  if (yesterday !== null) {
    const window = dayWindow(yesterday, -1);
    if (window !== null) windows.push(window);
  }

  const withinStatedHours = windows.some(
    ([open, close]) =>
      minutesOfDay >= open - CLOSED_HOURS_GRACE_MINUTES &&
      minutesOfDay <= close + CLOSED_HOURS_GRACE_MINUTES,
  );
  if (withinStatedHours) return null;

  return buildSignal("timestamp_closed_hours", {
    kind: "closed_hours",
    receipt_time: formatHHMM(minutesOfDay),
    weekday,
  });
}
