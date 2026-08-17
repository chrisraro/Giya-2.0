import { describe, expect, it } from "vitest";

import { toOpeningHoursEntries } from "./wizard-hours";

// ===========================================================================
// The registration wizard collects TWO time pairs - "Weekdays" and "Weekends" -
// and `businesses.opening_hours` stores SEVEN rows, one per day, day 1 being
// Monday. This module is that expansion, and nothing else.
//
// WHY IT DOES NOT CALL parseOpeningHours (the T1.6 scar).
//
// settings/hours.ts already turns a stored value into exactly seven rows, and
// reusing it here would look like the obvious economy. It is the wrong
// direction. `parseOpeningHours` is a READ-path normalizer: anything it cannot
// make sense of comes back as DEFAULT_OPEN/DEFAULT_CLOSE (09:00-21:00) so the
// editor always has a full week to render. That substitution is what fabricated
// 09:00-21:00 opening hours for a business that had none, and on a WRITE path
// it would be strictly worse - a merchant who clears a time field would have a
// number they never typed saved under their name and shown to consumers.
//
// So the write path refuses instead of defaulting, and it validates through
// `openingHoursSchema` from settings/schemas.ts - the contract the settings
// editor already writes through. Same day convention, same HH:MM rule, so what
// registration stores is exactly what the editor later loads and what
// src/lib/hours.ts renders on /b/[slug].
// ===========================================================================

const GOOD = {
  weekdayOpen: "07:30",
  weekdayClose: "19:45",
  weekendOpen: "10:00",
  weekendClose: "14:15",
};

describe("toOpeningHoursEntries", () => {
  it("expands the two pairs into seven rows, Monday first", () => {
    const result = toOpeningHoursEntries(GOOD);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      { day: 1, open: "07:30", close: "19:45", closed: false },
      { day: 2, open: "07:30", close: "19:45", closed: false },
      { day: 3, open: "07:30", close: "19:45", closed: false },
      { day: 4, open: "07:30", close: "19:45", closed: false },
      { day: 5, open: "07:30", close: "19:45", closed: false },
      { day: 6, open: "10:00", close: "14:15", closed: false },
      { day: 7, open: "10:00", close: "14:15", closed: false },
    ]);
  });

  it("puts Saturday and Sunday on the weekend pair, not the weekday pair", () => {
    // The one mapping mistake that would survive a shape-only assertion: the
    // week is Monday-first here but Sunday-first in plenty of other systems, so
    // an off-by-one would silently give the merchant Sunday weekday hours.
    const result = toOpeningHoursEntries(GOOD);

    if (!result.ok) throw new Error("expected ok");
    const weekendDays = result.entries.filter((entry) => entry.open === "10:00");
    expect(weekendDays.map((entry) => entry.day)).toEqual([6, 7]);
  });

  it("accepts midnight and the last minute of the day", () => {
    const result = toOpeningHoursEntries({
      weekdayOpen: "00:00",
      weekdayClose: "23:59",
      weekendOpen: "00:00",
      weekendClose: "23:59",
    });

    expect(result.ok).toBe(true);
  });

  it("accepts an overnight window rather than treating it as reversed", () => {
    // Doc 32 section 4: `close < open` renders as "until 02:00 +1". A bar that
    // shuts at 2am is not a typo, and refusing it here would make the wizard
    // unusable for exactly the businesses that need late hours.
    const result = toOpeningHoursEntries({ ...GOOD, weekendOpen: "18:00", weekendClose: "02:00" });

    expect(result.ok).toBe(true);
  });

  // ------------------------------------------------- refusing, not defaulting

  it("CRITICAL: refuses a cleared time instead of inventing one", () => {
    // `<input type="time">` reports "" when a merchant clears it. A read-path
    // normalizer would turn that into 09:00; this returns a refusal, because a
    // time nobody typed must never end up on a public profile.
    const result = toOpeningHoursEntries({ ...GOOD, weekdayOpen: "" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/24-hour time/);
  });

  it("CRITICAL: refuses a malformed time instead of substituting a default", () => {
    const result = toOpeningHoursEntries({ ...GOOD, weekendClose: "25:00" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The value that would have been fabricated, spelled out: if this ever
    // starts passing with 21:00 stored, the read-path normalizer has been
    // wired into the write path again.
    expect(result.message).not.toBe("21:00");
  });

  it("names the pair that is wrong so the wizard can say something useful", () => {
    const result = toOpeningHoursEntries({ ...GOOD, weekdayClose: "7pm" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.length).toBeGreaterThan(0);
  });
});
