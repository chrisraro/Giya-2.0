import { describe, expect, it } from "vitest";

import { CLOSED_HOURS_GRACE_MINUTES, checkClosedHours } from "./closed-hours";

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

describe("checkClosedHours: the null-not-a-verdict cases", () => {
  it("never runs when the receipt carries no extracted time", () => {
    // 2026-07-20 is a Monday, 10:00 Manila - well inside a Monday 08:00-20:00
    // window, so ONLY `timeExtracted` explains a null here.
    const result = checkClosedHours({
      receiptDate: manila("2026-07-20", 10, 0),
      timeExtracted: false,
      openingHours: week({ 1: { open: "08:00", close: "20:00", closed: false } }),
    });
    expect(result).toBeNull();
  });

  it("never runs when the business has no configured hours at all", () => {
    // 23:00 - clearly outside any reasonable window - and still null,
    // because the business has never opened the hours editor.
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-20", 23, 0),
        timeExtracted: true,
        openingHours: [],
      }),
    ).toBeNull();
  });

  it("treats a non-array or missing opening_hours the same as empty", () => {
    for (const openingHours of [null, undefined, "not an array", 42, {}]) {
      expect(
        checkClosedHours({
          receiptDate: manila("2026-07-20", 23, 0),
          timeExtracted: true,
          openingHours,
        }),
      ).toBeNull();
    }
  });

  it("treats an unparseable non-empty array as 'no hours configured', never as 'closed'", () => {
    // Every entry here fails `parseOpeningHours`'s validation, so it
    // normalizes to seven defaulted-closed rows - which must NOT be read as
    // "this business is closed every day of the week."
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-20", 23, 0),
        timeExtracted: true,
        openingHours: [{ garbage: true }, "nonsense", 7],
      }),
    ).toBeNull();
  });

  it("treats a genuinely all-closed configured week the same way, conservatively", () => {
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-20", 23, 0),
        timeExtracted: true,
        openingHours: week(),
      }),
    ).toBeNull();
  });
});

describe("checkClosedHours: ordinary same-day windows", () => {
  const MONDAY_8_TO_20 = week({ 1: { open: "08:00", close: "20:00", closed: false } });

  it("passes with no signal comfortably inside the window", () => {
    // 2026-07-20 is a Monday, 12:30.
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-20", 12, 30),
        timeExtracted: true,
        openingHours: MONDAY_8_TO_20,
      }),
    ).toBeNull();
  });

  it("fires a warn signal, at doc 37's catalog score, for a receipt well outside hours", () => {
    const signal = checkClosedHours({
      receiptDate: manila("2026-07-20", 2, 0), // 02:00 Monday
      timeExtracted: true,
      openingHours: MONDAY_8_TO_20,
    });
    expect(signal).toEqual({
      signal: "timestamp_anomaly",
      severity: "warn",
      score: 0.4,
      evidence: { kind: "closed_hours", receipt_time: "02:00", weekday: 1 },
    });
  });

  it("fires for a receipt on a day the business states it is closed", () => {
    // Tuesday defaults to closed in this fixture, and Monday's normal
    // daytime hours cannot spill into it.
    const signal = checkClosedHours({
      receiptDate: manila("2026-07-21", 12, 0), // Tuesday noon
      timeExtracted: true,
      openingHours: MONDAY_8_TO_20,
    });
    expect(signal?.evidence).toMatchObject({ weekday: 2 });
  });

  describe("the grace margin, exactly at its edges", () => {
    it("is inside the window AT the grace boundary on the open side", () => {
      // open 08:00 - 60min grace = 07:00, inclusive.
      expect(
        checkClosedHours({
          receiptDate: manila("2026-07-20", 7, 0),
          timeExtracted: true,
          openingHours: MONDAY_8_TO_20,
        }),
      ).toBeNull();
    });

    it("fires one minute earlier than the open-side grace boundary", () => {
      const signal = checkClosedHours({
        receiptDate: manila("2026-07-20", 6, 59),
        timeExtracted: true,
        openingHours: MONDAY_8_TO_20,
      });
      expect(signal).not.toBeNull();
    });

    it("is inside the window AT the grace boundary on the close side", () => {
      // close 20:00 + 60min grace = 21:00, inclusive.
      expect(
        checkClosedHours({
          receiptDate: manila("2026-07-20", 21, 0),
          timeExtracted: true,
          openingHours: MONDAY_8_TO_20,
        }),
      ).toBeNull();
    });

    it("fires one minute later than the close-side grace boundary", () => {
      const signal = checkClosedHours({
        receiptDate: manila("2026-07-20", 21, 1),
        timeExtracted: true,
        openingHours: MONDAY_8_TO_20,
      });
      expect(signal).not.toBeNull();
    });

    it("uses exactly doc 37 S5's stated margin (60 minutes)", () => {
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
    // 2026-07-25 is a Saturday, 23:00.
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-25", 23, 0),
        timeExtracted: true,
        openingHours: SATURDAY_NIGHT,
      }),
    ).toBeNull();
  });

  it("passes for a receipt in the small hours of the NEXT calendar day", () => {
    // 2026-07-26 is the Sunday after that Saturday, 01:00 - Sunday's OWN
    // entry is closed, so only Saturday's overnight spillover explains this.
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-26", 1, 0),
        timeExtracted: true,
        openingHours: SATURDAY_NIGHT,
      }),
    ).toBeNull();
  });

  it("still fires for a Sunday receipt once the overnight spillover has run out", () => {
    // 02:00 + 60min grace = 03:00 is the last legal minute; 11:00 Sunday is
    // long past it and Sunday's own entry is closed.
    const signal = checkClosedHours({
      receiptDate: manila("2026-07-26", 11, 0),
      timeExtracted: true,
      openingHours: SATURDAY_NIGHT,
    });
    expect(signal?.evidence).toMatchObject({ weekday: 7, receipt_time: "11:00" });
  });

  it("still fires for a Saturday AFTERNOON receipt, before the evening window opens", () => {
    // 14:00 Saturday is neither in Saturday's own 18:00-02:00 window (even
    // with grace, open - 60min = 17:00) nor in Friday's spillover (Friday is
    // closed in this fixture).
    const signal = checkClosedHours({
      receiptDate: manila("2026-07-25", 14, 0),
      timeExtracted: true,
      openingHours: SATURDAY_NIGHT,
    });
    expect(signal?.evidence).toMatchObject({ weekday: 6, receipt_time: "14:00" });
  });

  it("honours grace across the overnight boundary on both ends", () => {
    // 17:00 Saturday = open (18:00) - 60min grace, inclusive.
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-25", 17, 0),
        timeExtracted: true,
        openingHours: SATURDAY_NIGHT,
      }),
    ).toBeNull();
    // 03:00 Sunday = close (02:00) + 60min grace, inclusive.
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-26", 3, 0),
        timeExtracted: true,
        openingHours: SATURDAY_NIGHT,
      }),
    ).toBeNull();
    // One minute past grace on each side fires.
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-25", 16, 59),
        timeExtracted: true,
        openingHours: SATURDAY_NIGHT,
      }),
    ).not.toBeNull();
    expect(
      checkClosedHours({
        receiptDate: manila("2026-07-26", 3, 1),
        timeExtracted: true,
        openingHours: SATURDAY_NIGHT,
      }),
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
        checkClosedHours({
          receiptDate: manila(dateStr, hour, minute),
          timeExtracted: true,
          openingHours: ALWAYS_OPEN,
        }),
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
    const signal = checkClosedHours({
      receiptDate: manila("2026-07-26", 11, 0), // Sunday
      timeExtracted: true,
      openingHours: withSundayClosed,
    });
    expect(signal?.evidence).toMatchObject({ weekday: 7 });
  });
});
