import { describe, expect, it } from "vitest";

import { CLOSED_HOURS_GRACE_MINUTES, checkClosedHours } from "./closed-hours";
import type { ClosedHoursCheckInput } from "./closed-hours";

// ===========================================================================
// Doc 37 S5's closed-hours case, in isolation from the pipeline.
//
// Dates below are chosen so their Manila weekday is unambiguous and verified
// against `Intl.DateTimeFormat` directly (Asia/Manila, UTC+8, no DST, so an
// explicit +08:00 offset resolves to exactly one instant regardless of the
// host machine's own timezone):
//
//   2026-07-20 Mon, 07-21 Tue, 07-22 Wed, 07-23 Thu,
//   2026-07-24 Fri, 07-25 Sat, 07-26 Sun.
//
// (0002/0032's convention: day 1 = Monday ... day 7 = Sunday.)
// ===========================================================================

function manila(dateStr: string, hour: number, minute: number): Date {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return new Date(`${dateStr}T${hh}:${mm}:00+08:00`);
}

/** Every test states only what it is about; `timeExtracted`/`dateAmbiguous`
 * default to the values that let the check run at all. */
function check(overrides: Partial<ClosedHoursCheckInput> & { receiptDate: Date }): ReturnType<
  typeof checkClosedHours
> {
  return checkClosedHours({
    timeExtracted: true,
    dateAmbiguous: false,
    openingHours: [],
    ...overrides,
  });
}

interface DayEntry {
  day: number;
  open: string;
  close: string;
  closed: boolean;
}

const CLOSED: Omit<DayEntry, "day"> = { open: "09:00", close: "21:00", closed: true };

/** A full week, every day closed unless overridden by weekday number. */
function week(overrides: Record<number, Partial<Omit<DayEntry, "day">>> = {}): DayEntry[] {
  return [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    day,
    ...CLOSED,
    ...(overrides[day] ?? {}),
  }));
}

// ---------------------------------------------------------------------------
// C1 — the exact false-positive shapes the review demonstrated by execution
// against the previous (rejected) implementation. Each of these MUST return
// null: absent or malformed data reads as "the check did not run," never as
// "closed," because a false signal on a real purchase is the worst outcome
// this system can produce.
// ---------------------------------------------------------------------------
describe("checkClosedHours: C1 — malformed/partial opening_hours never fabricates a signal", () => {
  it("never invents hours from an unparseable time (numeric day, bad HHMM)", () => {
    // The previous implementation's normalizer (`parseOpeningHours`)
    // substituted 09:00-21:00 for "8am"/"10pm" and signalled at 22:30.
    const openingHours = [{ day: 1, open: "8am", close: "10pm" }];
    expect(
      check({ receiptDate: manila("2026-07-20", 22, 30), openingHours }), // Monday 22:30
    ).toBeNull();
  });

  it("never signals a day the raw array never covers (a Mon-Fri-only week, Saturday receipt)", () => {
    const mondayToFriday = [1, 2, 3, 4, 5].map((day) => ({
      day,
      open: "09:00",
      close: "21:00",
      closed: false,
    }));
    expect(
      check({ receiptDate: manila("2026-07-25", 13, 0), openingHours: mondayToFriday }), // Saturday 13:00
    ).toBeNull();
  });

  it("never treats seven bare {day:N} rows (no open/close/closed at all) as open", () => {
    const bareRows = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day }));
    expect(
      check({ receiptDate: manila("2026-07-20", 23, 30), openingHours: bareRows }), // Monday 23:30
    ).toBeNull();
  });

  it("trusts a well-formed entry with a MISSING closed key (real times, not a substitution)", () => {
    // Distinct from the bare-row case above: real open/close strings were
    // actually written down, so `isHoursEntry` treats the day as open - this
    // is the one shape that is legitimately data, not fiction, and firing
    // here is correct, not a bug.
    const openingHours = [{ day: 1, open: "09:00", close: "21:00" }];
    const signal = check({ receiptDate: manila("2026-07-20", 23, 0), openingHours }); // Monday 23:00, past close+grace
    expect(signal).not.toBeNull();
    expect(check({ receiptDate: manila("2026-07-20", 12, 0), openingHours })).toBeNull(); // inside it
  });

  it("treats a genuinely well-formed but entirely-closed week the same as unconfigured", () => {
    // Every entry here is individually VALID (real day, real closed:true) -
    // the point is that a week with no open day anywhere is operationally
    // indistinguishable from "nobody has told us this business's hours" and
    // must not flag literally every receipt at that business.
    expect(
      check({ receiptDate: manila("2026-07-20", 23, 0), openingHours: week() }),
    ).toBeNull();
  });

  it("never signals a day the receipt falls on that simply has no entry", () => {
    const onlyTuesday = [{ day: 2, open: "09:00", close: "21:00", closed: false }];
    expect(
      check({ receiptDate: manila("2026-07-20", 23, 0), openingHours: onlyTuesday }), // Monday
    ).toBeNull();
  });

  it("never runs on an empty, non-array, or absent opening_hours", () => {
    for (const openingHours of [[], null, undefined, "not an array", 42, {}]) {
      expect(
        checkClosedHours({
          receiptDate: manila("2026-07-20", 23, 0),
          timeExtracted: true,
          dateAmbiguous: false,
          openingHours,
        }),
      ).toBeNull();
    }
  });

  it("never runs when the receipt carries no extracted time, even inside real hours", () => {
    const result = check({
      receiptDate: manila("2026-07-20", 10, 0), // Monday 10:00, inside the window below
      timeExtracted: false,
      openingHours: week({ 1: { open: "08:00", close: "20:00", closed: false } }),
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C3 — an ambiguous date's weekday is not reliable, so the check must not run.
// ---------------------------------------------------------------------------
describe("checkClosedHours: C3 — an ambiguous date never drives the check", () => {
  it("returns null when dateAmbiguous is true, even for an otherwise-clear violation", () => {
    const openingHours = week({ 1: { open: "08:00", close: "20:00", closed: false } });
    // Same instant that WOULD signal (see the "fires a warn signal" test
    // below) if dateAmbiguous were false.
    const result = check({
      receiptDate: manila("2026-07-20", 2, 0),
      dateAmbiguous: true,
      openingHours,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M4 — an Invalid Date must degrade quietly, matching every other
// `receiptDate` use in `validateParsedReceipt`, rather than letting
// `Intl.DateTimeFormat.formatToParts` throw through the pipeline.
// ---------------------------------------------------------------------------
describe("checkClosedHours: M4 — an Invalid Date degrades quietly", () => {
  it("returns null rather than throwing", () => {
    const openingHours = week({ 1: { open: "08:00", close: "20:00", closed: false } });
    expect(() =>
      check({ receiptDate: new Date(Number.NaN), openingHours }),
    ).not.toThrow();
    expect(check({ receiptDate: new Date(Number.NaN), openingHours })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// C2 — the evidence carries the exact window the receipt was measured
// against (doc 37 line 82), not a convenience shape of this module's own
// invention.
// ---------------------------------------------------------------------------
describe("checkClosedHours: C2 — evidence matches doc 37 line 82 exactly", () => {
  it("emits {kind, receipt_date, opening_hours_day: {day, closed, open, close}} on the OPEN branch", () => {
    const receiptDate = manila("2026-07-20", 2, 0); // Monday 02:00
    const openingHours = week({ 1: { open: "08:00", close: "20:00", closed: false } });
    const signal = check({ receiptDate, openingHours });

    expect(signal).toEqual({
      signal: "timestamp_anomaly",
      severity: "warn",
      score: 0.4,
      evidence: {
        kind: "closed_hours",
        receipt_date: receiptDate.toISOString(),
        opening_hours_day: { day: 1, closed: false, open: "08:00", close: "20:00" },
      },
    });
  });

  it("N1: carries closed:true and NO open/close when the day itself is stated closed - never a window that contradicts the finding", () => {
    // Tuesday closed outright in this fixture, but `week()`'s CLOSED default
    // still fills real-looking open/close strings ("09:00"/"21:00", the same
    // way a merchant's editor-authored row would after they toggle a day
    // shut - `businesses/settings/hours.ts`'s own stated reason for keeping
    // them). The receipt below (12:00) falls INSIDE those default times on
    // purpose: a naive `{open, close}`-only evidence shape would read as the
    // detector contradicting its own finding ("1:00 PM is plainly inside
    // 09:00-21:00" was the exact review finding, N1) - this is the test that
    // would have caught it, not one that asserts the contradiction as
    // correct.
    const openingHours = week({ 1: { open: "08:00", close: "20:00", closed: false } });
    const signal = check({ receiptDate: manila("2026-07-21", 12, 0), openingHours }); // Tuesday noon
    expect(signal?.evidence).toMatchObject({ opening_hours_day: { day: 2, closed: true } });

    const openingHoursDay = (
      signal?.evidence as { opening_hours_day?: Record<string, unknown> }
    ).opening_hours_day;
    expect(openingHoursDay).not.toHaveProperty("open");
    expect(openingHoursDay).not.toHaveProperty("close");
  });

  it("N1/N3 second variant: a closed row with NO open/close at all (legal per isHoursEntry) is handled the same way", () => {
    // `{day, closed:true}` with no `open`/`close` keys is a legal
    // `isHoursEntry` row - `src/lib/hours.ts:34` returns true on
    // `closed === true` before ever looking at open/close. `HoursEntry.open`/
    // `close` are typed `string` but are genuinely `undefined` here at
    // runtime; reading them into the evidence unconditionally (N3) is what
    // let N1's second variant through. Monday is real, open data so
    // `hasAnyValidOpenDay` lets the check run at all.
    const openingHours = [
      { day: 1, open: "08:00", close: "20:00", closed: false },
      { day: 2, closed: true },
    ];
    const signal = check({ receiptDate: manila("2026-07-21", 12, 0), openingHours }); // Tuesday noon
    expect(signal?.evidence).toMatchObject({ opening_hours_day: { day: 2, closed: true } });
    const openingHoursDay = (
      signal?.evidence as { opening_hours_day?: Record<string, unknown> }
    ).opening_hours_day;
    expect(openingHoursDay).not.toHaveProperty("open");
    expect(openingHoursDay).not.toHaveProperty("close");
  });
});

// ---------------------------------------------------------------------------
// Confirmed-correct arithmetic (verified by the reviewer via direct
// execution) - preserved unchanged in behaviour, updated only for the new
// required `dateAmbiguous` field and the new evidence shape.
// ---------------------------------------------------------------------------
describe("checkClosedHours: ordinary same-day windows", () => {
  const MONDAY_8_TO_20 = week({ 1: { open: "08:00", close: "20:00", closed: false } });

  it("passes with no signal comfortably inside the window", () => {
    expect(
      check({ receiptDate: manila("2026-07-20", 12, 30), openingHours: MONDAY_8_TO_20 }),
    ).toBeNull();
  });

  it("fires a warn signal, at doc 37's catalog score, for a receipt well outside hours", () => {
    const signal = check({
      receiptDate: manila("2026-07-20", 2, 0), // 02:00 Monday
      openingHours: MONDAY_8_TO_20,
    });
    expect(signal).toMatchObject({ signal: "timestamp_anomaly", severity: "warn", score: 0.4 });
  });

  it("fires for a receipt on a day the business states it is closed", () => {
    const signal = check({
      receiptDate: manila("2026-07-21", 12, 0), // Tuesday noon, closed in this fixture
      openingHours: MONDAY_8_TO_20,
    });
    expect(signal?.evidence).toMatchObject({ opening_hours_day: { day: 2 } });
  });

  describe("the grace margin, exactly at its edges", () => {
    it("is inside the window AT the grace boundary on the open side", () => {
      // open 08:00 - 60min grace = 07:00, inclusive.
      expect(
        check({ receiptDate: manila("2026-07-20", 7, 0), openingHours: MONDAY_8_TO_20 }),
      ).toBeNull();
    });

    it("fires one minute earlier than the open-side grace boundary", () => {
      expect(
        check({ receiptDate: manila("2026-07-20", 6, 59), openingHours: MONDAY_8_TO_20 }),
      ).not.toBeNull();
    });

    it("is inside the window AT the grace boundary on the close side", () => {
      // close 20:00 + 60min grace = 21:00, inclusive.
      expect(
        check({ receiptDate: manila("2026-07-20", 21, 0), openingHours: MONDAY_8_TO_20 }),
      ).toBeNull();
    });

    it("fires one minute later than the close-side grace boundary", () => {
      expect(
        check({ receiptDate: manila("2026-07-20", 21, 1), openingHours: MONDAY_8_TO_20 }),
      ).not.toBeNull();
    });

    it("is the task brief's own margin (60 minutes) - not attributed to doc 37 (M1)", () => {
      expect(CLOSED_HOURS_GRACE_MINUTES).toBe(60);
    });
  });
});

describe("checkClosedHours: overnight windows crossing midnight", () => {
  // Saturday (day 6) 18:00 - Sunday 02:00, every other day closed. This is
  // the case doc 37 S5 is most likely got wrong: a receipt just after
  // midnight belongs to SUNDAY's calendar weekday but SATURDAY's window.
  const SATURDAY_NIGHT = week({ 6: { open: "18:00", close: "02:00", closed: false } });

  it("passes for a receipt the same evening, well before midnight", () => {
    expect(
      check({ receiptDate: manila("2026-07-25", 23, 0), openingHours: SATURDAY_NIGHT }),
    ).toBeNull();
  });

  it("passes for a receipt in the small hours of the NEXT calendar day", () => {
    expect(
      check({ receiptDate: manila("2026-07-26", 1, 0), openingHours: SATURDAY_NIGHT }),
    ).toBeNull();
  });

  it("still fires for a Sunday receipt once the overnight spillover has run out", () => {
    const signal = check({
      receiptDate: manila("2026-07-26", 11, 0),
      openingHours: SATURDAY_NIGHT,
    });
    expect(signal?.evidence).toMatchObject({ opening_hours_day: { day: 7 } });
  });

  it("still fires for a Saturday AFTERNOON receipt, before the evening window opens", () => {
    const signal = check({
      receiptDate: manila("2026-07-25", 14, 0),
      openingHours: SATURDAY_NIGHT,
    });
    expect(signal?.evidence).toMatchObject({ opening_hours_day: { day: 6 } });
  });

  it("honours grace across the overnight boundary on both ends", () => {
    // 17:00 Saturday = open (18:00) - 60min grace, inclusive.
    expect(
      check({ receiptDate: manila("2026-07-25", 17, 0), openingHours: SATURDAY_NIGHT }),
    ).toBeNull();
    // 03:00 Sunday = close (02:00) + 60min grace, inclusive.
    expect(
      check({ receiptDate: manila("2026-07-26", 3, 0), openingHours: SATURDAY_NIGHT }),
    ).toBeNull();
    // One minute past grace on each side fires.
    expect(
      check({ receiptDate: manila("2026-07-25", 16, 59), openingHours: SATURDAY_NIGHT }),
    ).not.toBeNull();
    expect(
      check({ receiptDate: manila("2026-07-26", 3, 1), openingHours: SATURDAY_NIGHT }),
    ).not.toBeNull();
  });
});

describe("checkClosedHours: the 24-hour business", () => {
  // doc 32 section 4's convention: open === close means the whole day, no
  // separate flag. Every day open this way.
  const ALWAYS_OPEN = week({
    1: { open: "00:00", close: "00:00", closed: false },
    2: { open: "00:00", close: "00:00", closed: false },
    3: { open: "00:00", close: "00:00", closed: false },
    4: { open: "00:00", close: "00:00", closed: false },
    5: { open: "00:00", close: "00:00", closed: false },
    6: { open: "00:00", close: "00:00", closed: false },
    7: { open: "00:00", close: "00:00", closed: false },
  });

  it("never fires, at any hour of any day", () => {
    for (const [dateStr, hour, minute] of [
      ["2026-07-20", 3, 0],
      ["2026-07-21", 12, 0],
      ["2026-07-25", 23, 59],
      ["2026-07-26", 0, 0],
    ] as const) {
      expect(
        check({ receiptDate: manila(dateStr, hour, minute), openingHours: ALWAYS_OPEN }),
      ).toBeNull();
    }
  });

  it("still fires on a day the 24-hour business explicitly closes", () => {
    // Sunday closed outright; Saturday's 24h window ends exactly at
    // Sunday's midnight, so only the grace minute bleeds past it.
    const withSundayClosed = week({
      6: { open: "00:00", close: "00:00", closed: false },
      7: { open: "00:00", close: "00:00", closed: true },
    });
    const signal = check({
      receiptDate: manila("2026-07-26", 11, 0), // Sunday
      openingHours: withSundayClosed,
    });
    expect(signal?.evidence).toMatchObject({ opening_hours_day: { day: 7 } });
  });
});
