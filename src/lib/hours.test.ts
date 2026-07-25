import { describe, it, expect } from "vitest";

import { formatHoursSummary } from "./hours";

// 2024-01-01T04:00:00Z is 2024-01-01 12:00 in Asia/Manila (UTC+8), a Monday
// (weekday 1). 2024-01-02T04:00:00Z is the following Tuesday (weekday 2).
const MONDAY = new Date("2024-01-01T04:00:00Z");
const TUESDAY = new Date("2024-01-02T04:00:00Z");

describe("formatHoursSummary", () => {
  it("returns 'Hours not set' when opening_hours is undefined", () => {
    expect(formatHoursSummary(undefined, MONDAY)).toBe("Hours not set");
  });

  it("returns 'Hours not set' when opening_hours is null", () => {
    expect(formatHoursSummary(null, MONDAY)).toBe("Hours not set");
  });

  it("returns 'Hours not set' when opening_hours is an empty array", () => {
    expect(formatHoursSummary([], MONDAY)).toBe("Hours not set");
  });

  it("returns 'Hours not set' when opening_hours is not an array", () => {
    expect(formatHoursSummary({ monday: "9-5" }, MONDAY)).toBe("Hours not set");
  });

  it("returns 'Hours not set' when there is no entry for today's weekday", () => {
    const hours = [{ day: 2, open: "09:00", close: "18:00" }];
    expect(formatHoursSummary(hours, MONDAY)).toBe("Hours not set");
  });

  it("returns 'Hours not set' when today's entry is malformed (missing close)", () => {
    const hours = [{ day: 1, open: "09:00" }];
    expect(formatHoursSummary(hours, MONDAY)).toBe("Hours not set");
  });

  it("returns 'Hours not set' when today's entry has an out-of-range day", () => {
    const hours = [{ day: 8, open: "09:00", close: "18:00" }];
    expect(formatHoursSummary(hours, MONDAY)).toBe("Hours not set");
  });

  it("returns 'Closed today' when today's entry is marked closed", () => {
    const hours = [{ day: 1, open: "09:00", close: "18:00", closed: true }];
    expect(formatHoursSummary(hours, MONDAY)).toBe("Closed today");
  });

  it("returns 'Open today until <close>' when today's entry is open", () => {
    const hours = [{ day: 1, open: "09:00", close: "22:00" }];
    expect(formatHoursSummary(hours, MONDAY)).toBe("Open today until 22:00");
  });

  it("picks the entry matching the current weekday out of several", () => {
    const hours = [
      { day: 1, open: "09:00", close: "18:00" },
      { day: 2, open: "10:00", close: "20:00" },
    ];
    expect(formatHoursSummary(hours, TUESDAY)).toBe("Open today until 20:00");
  });
});
