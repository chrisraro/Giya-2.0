import { deriveLocalDayTime } from "@/features/points/compute";
import { isHoursEntry } from "@/lib/hours";
import type { HoursEntry } from "@/lib/hours";

import { buildSignal } from "./fraud";
import type { FraudSignal } from "./fraud";

// ===========================================================================
// Doc 37 S5's closed-hours case (docs/30-modules/37-fraud-detection.md line
// 79/82): a receipt whose printed time falls when the business's own STATED
// hours say it was closed. The other two S5 cases (future-dated, too-old)
// are implemented in `server/process.ts`'s `validateParsedReceipt`; this one
// was the missing MVP piece (see the receipts README's former "S5
// closed-hours is not implemented" debt entry, which this file resolves).
//
// ZERO IO, exactly like fraud.ts and velocity.ts: `server/process.ts` reads
// `parsed.receiptDate` / `parsed.timeExtracted` / `parsed.dateAmbiguous`
// (`../parse.ts`) and `businesses.opening_hours` itself and hands all of it
// to `checkClosedHours`. Scoring and routing stay fraud.ts's job - this
// module only ever decides whether ONE signal fires, using the catalog's
// existing `timestamp_closed_hours` case (severity warn, score 0.4, doc 37's
// table).
//
// ---------------------------------------------------------------------------
// THE NORMALIZER CHOICE, AND WHY IT IS NOT `parseOpeningHours`
// ---------------------------------------------------------------------------
// `businesses/settings/hours.ts`'s `parseOpeningHours` is EDITOR-shaped: it
// substitutes `DEFAULT_OPEN`/`DEFAULT_CLOSE` ("09:00"/"21:00") for any
// unparseable time and defaults a missing `closed` key to open, because the
// settings FORM must always render seven fillable rows regardless of what is
// stored. Borrowing those defaults for a FRAUD CHECK silently converts
// "nobody has told us this business's hours" into "closed 09:00-21:00 every
// day the merchant never configured" - and doc 37's own governing decision
// for this whole area is that a false signal on a genuine purchase is the
// worst outcome this system can produce (OCR misreads receipts constantly,
// so every check here is built to fail to "did not run", never to
// "suspicious").
//
// `src/lib/hours.ts`'s `isHoursEntry` is the reader already built for the
// opposite posture: an entry with a bad HHMM string, or a day with no entry
// at all, reads as UNKNOWN, never as a fact. Reused here rather than a third
// re-implementation of the same regex. A day is only ever treated as data
// this module can act on when `isHoursEntry` accepts the RAW row for that
// day untouched - nothing here ever substitutes a default time or a default
// "closed".
//
// ---------------------------------------------------------------------------
// NULL MEANS "THE CHECK DID NOT RUN," NEVER "THE CHECK PASSED"
// ---------------------------------------------------------------------------
// The same D3 principle `../review/merchant-check.test.tsx` pins for the
// merchant-name check, now covering every way the inputs can be too thin to
// trust:
//
//   * no time was actually printed on the receipt (`timeExtracted` false -
//     `extractDate`'s noon default is a placeholder, not a fact);
//   * the printed date itself was ambiguous (`dateAmbiguous` true -
//     `parse.ts` resolved a two-way numeric date to the older reading, and
//     the two candidate readings are generally different WEEKDAYS, so the
//     weekday this check would compare against is not reliable either);
//   * `businesses.opening_hours` is empty, absent, or not an array at all -
//     `jsonb not null default '[]'` with NO DB-level shape constraint
//     (0002:218-219, confirmed at `../businesses/settings/hours.ts:9`), so an
//     empty array is the default state of every business that has never
//     opened the hours editor;
//   * every entry in the array that DOES pass `isHoursEntry` is closed, i.e.
//     nothing in the whole week is ever stated as open. A week that is
//     genuinely, validly closed every day is operationally identical to "no
//     usable configuration" from this check's point of view, and the failure
//     mode of treating it as real data (flagging literally every receipt at
//     that business) is exactly the one this file exists to prevent;
//   * there is no valid, well-formed entry for the RECEIPT's OWN weekday.
//     Missing (a partial week) and malformed (a `day` outside 1-7, or an
//     `open`/`close` that fails HHMM) are treated identically: no opinion,
//     not "closed".
//
// A day's own valid entry with no `closed` key at all but well-formed
// `open`/`close` IS trusted as an open window (`isHoursEntry`'s own rule):
// that is real data - two specific times were actually written down - not a
// substitution this module invented.
//
// NAMED RATHER THAN HIDDEN: `isHoursEntry` (`src/lib/hours.ts:34`) only
// early-returns on `closed === true`; it does not require `closed` to be a
// boolean at all. `closed: "yes"` or `closed: 1` is therefore NOT refused -
// it falls through to the same open/close validation a legitimate
// `closed: false` row goes through, and a row with well-formed times is
// trusted as OPEN. The direction is safe for a check built to never
// fabricate a closure (it can only under-count one), so this is left as
// `isHoursEntry`'s behavior rather than special-cased here - but it is real,
// and a previous version of this comment claimed the opposite.
//
// ---------------------------------------------------------------------------
// OVERNIGHT WINDOWS AND THE GRACE MARGIN
// ---------------------------------------------------------------------------
// `close <= open` means "past midnight" (0032 section 4: "close < open
// renders 'until 02:00 +1'"). A receipt printed at 01:00 belongs to
// TOMORROW's calendar weekday but TONIGHT's opening window, so the window
// this module tests against is built from BOTH the receipt's own weekday and
// the weekday before it - never the receipt's weekday alone. This is the
// case doc 37 S5 is most often got wrong on, so it is exhaustively covered
// in closed-hours.test.ts rather than only implied by the arithmetic.
//
// The 60-minute grace margin ("receipts print late, staff close late") is
// NOT in doc 37 - S5's only documented grace is the future-dated case's 24h
// timezone allowance (line 78). It is the receiving task brief's own
// decision, cited here as that and nothing more, so a reader checking this
// file against doc 37 does not go looking for a number the doc never states.
// ===========================================================================

const RECEIPT_TIMEZONE = "Asia/Manila";

/** The task brief's grace margin - see the header note on why this is NOT
 * attributed to doc 37. */
export const CLOSED_HOURS_GRACE_MINUTES = 60;

const MINUTES_PER_DAY = 24 * 60;

function minutesOf(hhmm: string): number {
  const [hourText, minuteText] = hhmm.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

/**
 * The valid, well-formed `isHoursEntry` row for `day`, or null when there is
 * none - a missing day and a malformed one are indistinguishable on purpose
 * (see the header). Takes the FIRST match, matching
 * `parseOpeningHours`'s own tie-break for a hand-edited duplicate day.
 */
function validDayEntry(openingHours: unknown, day: number): HoursEntry | null {
  if (!Array.isArray(openingHours)) return null;
  for (const raw of openingHours) {
    if (isHoursEntry(raw) && raw.day === day) return raw;
  }
  return null;
}

/** Whether ANY row in the raw array is a valid, well-formed, OPEN entry.
 * False for an entirely empty/garbage array and for a genuinely well-formed
 * but entirely-closed week alike - both read as "nothing to check against"
 * (see the header's third bullet). */
function hasAnyValidOpenDay(openingHours: unknown): boolean {
  if (!Array.isArray(openingHours)) return false;
  return openingHours.some((raw) => isHoursEntry(raw) && raw.closed !== true);
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
function dayWindow(entry: HoursEntry, dayIndex: number): [number, number] | null {
  if (entry.closed === true) return null;
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

export interface ClosedHoursCheckInput {
  /** `parse.ts`'s reading of the printed receipt, as a UTC instant. */
  receiptDate: Date;
  /**
   * `../parse.ts`'s `ParsedReceipt.timeExtracted`: whether `receiptDate`'s
   * time-of-day came from a real HH:mm token on the receipt, as opposed to
   * `extractDate`'s noon default. False must never drive this check.
   */
  timeExtracted: boolean;
  /**
   * `../parse.ts`'s `ParsedReceipt.dateAmbiguous`: whether `parse.ts`
   * resolved a two-way numeric date to the older of two real readings. The
   * two candidate readings are generally different weekdays, so a weekday
   * derived from an ambiguous date is not reliable enough to check against
   * stated hours (C3).
   */
  dateAmbiguous: boolean;
  /**
   * `businesses.opening_hours`, exactly as read from Postgres: `jsonb not
   * null default '[]'`, no DB-level shape constraint (0002:218-219). Passed
   * through `unknown` on purpose - this module decides for itself whether
   * each entry is usable rather than trusting a caller's cast.
   */
  openingHours: unknown;
}

/**
 * Doc 37 S5's closed-hours case, as a ready-to-persist `FraudSignal`, or null
 * when the check could not meaningfully run (see the header) or when the
 * receipt's time falls inside the business's stated hours (with the grace
 * margin applied).
 */
export function checkClosedHours(input: ClosedHoursCheckInput): FraudSignal | null {
  if (!input.timeExtracted) return null;
  if (input.dateAmbiguous) return null;
  // An Invalid Date reaching this function is unreachable in the pipeline
  // today (every upstream `receiptDate` use degrades via `getTime()` ->
  // `NaN` rather than producing one), but `Intl.DateTimeFormat.formatToParts`
  // THROWS on one, and `processReceipt`'s one promise is that it never does.
  // Checked explicitly rather than relied on staying unreachable.
  if (Number.isNaN(input.receiptDate.getTime())) return null;
  if (!hasAnyValidOpenDay(input.openingHours)) return null;

  const { weekday, minutesOfDay } = deriveLocalDayTime(input.receiptDate, RECEIPT_TIMEZONE);

  const today = validDayEntry(input.openingHours, weekday);
  // No trustworthy entry for the RECEIPT's OWN day: missing (a partial week)
  // and malformed are the same "we don't know" here, never "closed".
  if (today === null) return null;

  const yesterday = validDayEntry(input.openingHours, previousWeekday(weekday));

  const windows: Array<[number, number]> = [];
  const todayWindow = dayWindow(today, 0);
  if (todayWindow !== null) windows.push(todayWindow);
  if (yesterday !== null) {
    const yesterdayWindow = dayWindow(yesterday, -1);
    if (yesterdayWindow !== null) windows.push(yesterdayWindow);
  }

  const withinStatedHours = windows.some(
    ([open, close]) =>
      minutesOfDay >= open - CLOSED_HOURS_GRACE_MINUTES &&
      minutesOfDay <= close + CLOSED_HOURS_GRACE_MINUTES,
  );
  if (withinStatedHours) return null;

  // Doc 37 line 82's evidence contract is `{kind, receipt_date,
  // opening_hours_day: {day, open, close}}`, and that example is an OPEN
  // day - it says nothing about the far more common firing path, a day
  // `today` itself states is closed. `closed` is added here (the doc's
  // example does not forbid it) because omitting the one field that
  // explains the finding is the worse deviation: without it, a Sunday-closed
  // business's Sunday receipt would render evidence naming Monday-Saturday's
  // OWN open/close times next to a receipt time those hours plainly contain,
  // which reads as the detector being broken rather than as the real reason
  // (N1). `open`/`close` are only read - and only present in the evidence -
  // on the OPEN branch: `HoursEntry.open`/`close` are typed `string` but are
  // genuinely `undefined` at runtime on a bare `{day, closed:true}` row
  // (`isHoursEntry` never validates them once `closed === true` short-
  // circuits it), so branching on `closed` first is what keeps this from
  // ever reading through that unsound typing (N3).
  const openingHoursDay =
    today.closed === true
      ? { day: weekday, closed: true }
      : { day: weekday, closed: false, open: today.open, close: today.close };

  return buildSignal("timestamp_closed_hours", {
    kind: "closed_hours",
    receipt_date: input.receiptDate.toISOString(),
    opening_hours_day: openingHoursDay,
  });
}
