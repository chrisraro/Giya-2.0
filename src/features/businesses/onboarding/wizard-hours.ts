import { openingHoursSchema, type OpeningHoursEntry } from "../settings/schemas";

// ===========================================================================
// The registration wizard's two time pairs -> `businesses.opening_hours`.
//
// Pure. No server, DB or React imports, same rule as ../settings/hours.ts, so
// the wizard can import it into a jsdom render without dragging a Supabase
// client and its env requirements along.
//
// WHY THIS IS NOT ../settings/hours.ts's parseOpeningHours.
//
// That function also produces exactly seven rows, day 1 through 7, and reusing
// it here would look like the obvious economy. It runs the wrong DIRECTION.
// `parseOpeningHours` reads: it exists so the editor always has a full week to
// render, so anything it cannot make sense of degrades to
// DEFAULT_OPEN/DEFAULT_CLOSE (09:00-21:00). Feeding a write path through it is
// what the T1.6 scar is about - an editor-shaped normalizer on a read path
// fabricated 09:00-21:00 hours for a business that had none.
//
// On the way IN, that substitution is worse, not better. A merchant who clears
// a time field sends "" (which is what `<input type="time">` reports), and
// defaulting would put an opening time they never chose on their public
// profile. So this refuses instead, through `openingHoursSchema` - the same
// contract the settings editor writes through, so registration and the editor
// cannot drift into storing two different shapes in one column.
// ===========================================================================

/** The four values the "Location and hours" step collects, as typed. */
export interface WizardHoursInput {
  readonly weekdayOpen: string;
  readonly weekdayClose: string;
  readonly weekendOpen: string;
  readonly weekendClose: string;
}

export type WizardHoursResult =
  | { ok: true; entries: OpeningHoursEntry[] }
  | { ok: false; message: string };

/**
 * Days 1-5 are Monday to Friday and take the weekday pair; days 6-7 are
 * Saturday and Sunday and take the weekend pair. Day 1 is Monday, which is the
 * convention the whole app uses (../settings/hours.ts's WEEKDAY_LABELS,
 * src/lib/hours.ts's renderer) and NOT the Sunday-first convention
 * `Date.getDay()` uses.
 */
const WEEKEND_DAYS = new Set([6, 7]);

/**
 * Expands the wizard's answers into the seven rows the column stores, or
 * refuses with a sentence a merchant can act on.
 *
 * Every day is written as open. The wizard has no per-day closed toggle - it
 * asks two questions, not fourteen - so claiming a merchant told us they close
 * on Sundays would be inventing an answer to a question nobody asked. The
 * settings editor is where a day gets shut, and it loads these seven rows and
 * shows every one of them.
 */
export function toOpeningHoursEntries(input: WizardHoursInput): WizardHoursResult {
  const entries = [1, 2, 3, 4, 5, 6, 7].map((day) => {
    const weekend = WEEKEND_DAYS.has(day);
    return {
      day,
      open: weekend ? input.weekendOpen : input.weekdayOpen,
      close: weekend ? input.weekendClose : input.weekdayClose,
      closed: false,
    };
  });

  // Overnight windows pass on purpose: `close < open` is a bar that shuts at
  // 2am, and doc 32 section 4 renders it as "until 02:00 +1". openingHoursSchema
  // deliberately carries no ordering check for the same reason.
  const parsed = openingHoursSchema.safeParse(entries);
  if (!parsed.success) {
    // `||` and not `??`, matching src/features/identity/actions.ts: a Zod issue
    // with an empty message is falsy but not nullish, and `??` would let ""
    // through to render as a blank alert.
    return {
      ok: false,
      message: parsed.error.issues[0]?.message || "Check your opening and closing times.",
    };
  }

  return { ok: true, entries: parsed.data };
}
