import { describe, expect, it } from "vitest";

import {
  MANILA_UTC_OFFSET_MINUTES,
  manilaDayOf,
  manilaDaySeries,
  manilaDayStart,
  manilaDayWindow,
  manilaWeekdayLong,
  manilaWeekdayShort,
  shiftManilaDay,
} from "./manila-day";

// These tests are the fence around doc 40's "Timezone rule (canon)". If any of
// them go red, this module and private.manila_day() have stopped agreeing about
// what a day is, and every visit count in the product is quietly wrong.

describe("manilaDayOf", () => {
  it("is UTC+8, matching private.manila_day", () => {
    expect(MANILA_UTC_OFFSET_MINUTES).toBe(480);
  });

  it("puts a late-evening UTC instant on the NEXT Manila day", () => {
    // 0023's own worked example: 17:00Z on the 25th is 01:00 Manila on the 26th
    // and is a different visit day from 10:00Z on the 25th.
    expect(manilaDayOf(new Date("2026-07-25T17:00:00Z"))).toBe("2026-07-26");
    expect(manilaDayOf(new Date("2026-07-25T10:00:00Z"))).toBe("2026-07-25");
  });

  it("treats 16:00Z as the exact day boundary", () => {
    expect(manilaDayOf(new Date("2026-07-25T15:59:59.999Z"))).toBe("2026-07-25");
    expect(manilaDayOf(new Date("2026-07-25T16:00:00.000Z"))).toBe("2026-07-26");
  });

  it("has no DST discontinuity across a northern-hemisphere clock change", () => {
    // Manila has never observed DST since 1978, so March and October behave
    // identically. A tz database lookup would not; a fixed offset cannot drift.
    expect(manilaDayOf(new Date("2026-03-29T16:00:00Z"))).toBe("2026-03-30");
    expect(manilaDayOf(new Date("2026-10-25T16:00:00Z"))).toBe("2026-10-26");
  });
});

describe("manilaDayStart", () => {
  it("resolves to 16:00Z on the previous UTC date", () => {
    expect(manilaDayStart("2026-07-26").toISOString()).toBe("2026-07-25T16:00:00.000Z");
  });

  it("round-trips through manilaDayOf", () => {
    expect(manilaDayOf(manilaDayStart("2026-01-01"))).toBe("2026-01-01");
  });
});

describe("shiftManilaDay", () => {
  it("walks forwards and backwards across a month boundary", () => {
    expect(shiftManilaDay("2026-07-31", 1)).toBe("2026-08-01");
    expect(shiftManilaDay("2026-08-01", -1)).toBe("2026-07-31");
  });

  it("walks across a leap day", () => {
    expect(shiftManilaDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftManilaDay("2028-03-01", -1)).toBe("2028-02-29");
  });
});

describe("manilaDaySeries", () => {
  it("returns consecutive days ending on the given day, oldest first", () => {
    expect(manilaDaySeries("2026-07-26", 7)).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
    ]);
  });
});

describe("manilaDayWindow", () => {
  it("is the half-open UTC interval doc 40 specifies", () => {
    const window = manilaDayWindow(["2026-07-20", "2026-07-26"]);
    expect(window.startIso).toBe("2026-07-19T16:00:00.000Z");
    // Exclusive end = the start of the day AFTER the last one in the run.
    expect(window.endIso).toBe("2026-07-26T16:00:00.000Z");
  });

  it("refuses an empty run rather than inventing a range", () => {
    expect(() => manilaDayWindow([])).toThrow();
  });
});

describe("weekday captions", () => {
  it("names the day the calendar names", () => {
    expect(manilaWeekdayShort("2026-07-26")).toBe("Sun");
    expect(manilaWeekdayLong("2026-07-26")).toBe("Sunday");
    expect(manilaWeekdayShort("2026-07-27")).toBe("Mon");
    expect(manilaWeekdayLong("2026-07-27")).toBe("Monday");
  });
});
