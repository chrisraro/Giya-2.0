import { describe, expect, it } from "vitest";

import { manilaDaySeries } from "./manila-day";
import {
  countVisits,
  entriesWithin,
  formatCount,
  formatPoints,
  periodDelta,
  relativeTime,
  sumPoints,
  visitsByDay,
  visitsChartLabel,
  type LedgerEntry,
} from "./metrics";

const ALICE = "consumer-a";
const BOB = "consumer-b";

function entry(consumerId: string, createdAt: string, points = 10): LedgerEntry {
  return { consumerId, points, createdAt };
}

describe("countVisits", () => {
  it("counts nothing for a merchant with no ledger rows", () => {
    expect(countVisits([])).toBe(0);
  });

  it("collapses several same-day entries from one consumer into ONE visit", () => {
    // Doc 40's anti-gaming rule: "splitting one purchase into three receipts
    // buys points, never extra visits."
    expect(
      countVisits([
        entry(ALICE, "2026-07-26T01:00:00Z"),
        entry(ALICE, "2026-07-26T05:00:00Z"),
        entry(ALICE, "2026-07-26T09:00:00Z"),
      ]),
    ).toBe(1);
  });

  it("counts the same consumer on two Manila days as two visits", () => {
    expect(
      countVisits([
        entry(ALICE, "2026-07-25T10:00:00Z"),
        entry(ALICE, "2026-07-25T17:00:00Z"), // already the 26th in Manila
      ]),
    ).toBe(2);
  });

  it("counts two consumers on the same day as two visits", () => {
    expect(
      countVisits([entry(ALICE, "2026-07-26T01:00:00Z"), entry(BOB, "2026-07-26T02:00:00Z")]),
    ).toBe(2);
  });
});

describe("visitsByDay", () => {
  const days = manilaDaySeries("2026-07-26", 7);

  it("returns a bar for every day, including the empty ones", () => {
    const series = visitsByDay([], days);
    expect(series).toHaveLength(7);
    expect(series.map((point) => point.value)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(series.map((point) => point.day)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
  });

  it("places each entry on its Manila day and dedupes per consumer", () => {
    const series = visitsByDay(
      [
        entry(ALICE, "2026-07-25T10:00:00Z"), // Sat 25th Manila
        entry(ALICE, "2026-07-25T11:00:00Z"), // same day, same consumer
        entry(BOB, "2026-07-25T17:00:00Z"), // Sun 26th Manila
      ],
      days,
    );
    expect(series.map((point) => point.value)).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  it("ignores entries outside the requested days rather than folding them in", () => {
    const series = visitsByDay([entry(ALICE, "2026-01-01T00:00:00Z")], days);
    expect(series.every((point) => point.value === 0)).toBe(true);
  });
});

describe("sumPoints and entriesWithin", () => {
  it("sums nothing to zero", () => {
    expect(sumPoints([])).toBe(0);
  });

  it("splits a 14-day fetch into its two 7-day halves", () => {
    const all = manilaDaySeries("2026-07-26", 14);
    const previous = all.slice(0, 7);
    const current = all.slice(7);

    const entries = [
      entry(ALICE, "2026-07-15T02:00:00Z", 5), // in the previous half
      entry(BOB, "2026-07-26T02:00:00Z", 30), // in the current half
    ];

    expect(sumPoints(entriesWithin(entries, previous))).toBe(5);
    expect(sumPoints(entriesWithin(entries, current))).toBe(30);
  });
});

describe("periodDelta", () => {
  // THE FIXTURE THIS REPLACED SAID "+12% vs last week" TO EVERY MERCHANT,
  // INCLUDING ONES WHOSE DATABASE WAS EMPTY. These tests are the fence.
  it("reports no comparison when the previous window is empty", () => {
    expect(periodDelta(0, 0)).toEqual({ text: "No comparison yet", tone: "muted" });
  });

  it("still reports no comparison when THIS window has data but the previous one does not", () => {
    // A first-ever week is not "+100%", and it is certainly not "+12%".
    // Percentage change against zero is undefined and is rendered as such.
    const delta = periodDelta(40, 0);
    expect(delta.tone).toBe("muted");
    expect(delta.text).toBe("No comparison yet");
    expect(delta.text).not.toMatch(/%/);
  });

  it("computes a real rise", () => {
    expect(periodDelta(112, 100)).toEqual({ text: "+12% vs previous 7 days", tone: "trend" });
  });

  it("computes a real fall", () => {
    expect(periodDelta(75, 100)).toEqual({ text: "-25% vs previous 7 days", tone: "trend" });
  });

  it("says so plainly when nothing moved", () => {
    expect(periodDelta(100, 100)).toEqual({
      text: "Level with the previous 7 days",
      tone: "trend",
    });
  });

  it("reports a total collapse rather than hiding it", () => {
    expect(periodDelta(0, 40)).toEqual({ text: "-100% vs previous 7 days", tone: "trend" });
  });
});

describe("formatting", () => {
  it("groups thousands and marks a capped read with a plus", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(4320)).toBe("4,320");
    expect(formatCount(10000, true)).toBe("10,000+");
  });

  it("pluralises points", () => {
    expect(formatPoints(1)).toBe("1 point");
    expect(formatPoints(25)).toBe("25 points");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-07-26T12:00:00Z");

  it("buckets recent instants", () => {
    expect(relativeTime(new Date("2026-07-26T11:59:40Z"), now)).toBe("Just now");
    expect(relativeTime(new Date("2026-07-26T11:45:00Z"), now)).toBe("15 min ago");
    expect(relativeTime(new Date("2026-07-26T11:00:00Z"), now)).toBe("1 hour ago");
    expect(relativeTime(new Date("2026-07-26T09:00:00Z"), now)).toBe("3 hours ago");
    expect(relativeTime(new Date("2026-07-24T12:00:00Z"), now)).toBe("2 days ago");
    expect(relativeTime(new Date("2026-07-12T12:00:00Z"), now)).toBe("2 weeks ago");
  });

  it("falls back to the Manila date once relative wording stops helping", () => {
    expect(relativeTime(new Date("2026-01-05T12:00:00Z"), now)).toBe("2026-01-05");
  });

  it("never reports a future instant as a negative age", () => {
    expect(relativeTime(new Date("2026-07-26T12:05:00Z"), now)).toBe("Just now");
  });
});

describe("visitsChartLabel", () => {
  const days = manilaDaySeries("2026-07-26", 7);

  it("names no busiest day when every bar is zero", () => {
    const label = visitsChartLabel(visitsByDay([], days), days);
    expect(label).toBe("Visits per day for the last 7 days, no visits recorded yet");
    expect(label).not.toMatch(/highest/);
  });

  it("names the real busiest day when there is one", () => {
    const series = visitsByDay(
      [
        entry(ALICE, "2026-07-25T10:00:00Z"),
        entry(BOB, "2026-07-25T11:00:00Z"),
        entry(ALICE, "2026-07-25T17:00:00Z"),
      ],
      days,
    );
    expect(visitsChartLabel(series, days)).toBe(
      "Visits per day for the last 7 days, highest Saturday",
    );
  });
});
