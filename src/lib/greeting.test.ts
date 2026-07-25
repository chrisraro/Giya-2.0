import { describe, expect, it } from "vitest";

import { filipinoGreeting, manilaDateCaption, manilaHour } from "./greeting";

// The whole point of this module is that the greeting follows MANILA's clock,
// not the server's. Every case below is written as a UTC instant and asserted
// against what a consumer in Cebu would be looking at, which is the only thing
// that makes these tests meaningful: run them with TZ=UTC (CI) or TZ=Asia/Manila
// (a local machine here) and they must agree.

/** Asia/Manila is UTC+8 year round, with no daylight saving. */
function manilaWallClock(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 6, 26, hour - 8, minute));
}

describe("manilaHour", () => {
  it("reads midnight in Manila as 0, not 24", () => {
    expect(manilaHour(manilaWallClock(0))).toBe(0);
  });

  it("reads noon in Manila as 12", () => {
    expect(manilaHour(manilaWallClock(12))).toBe(12);
  });

  it("reads 11pm in Manila as 23", () => {
    expect(manilaHour(manilaWallClock(23))).toBe(23);
  });

  it("is a Manila hour, not a UTC hour", () => {
    // 20:00 UTC is 4am the next day in Manila.
    expect(manilaHour(new Date("2026-07-26T20:00:00Z"))).toBe(4);
  });
});

describe("filipinoGreeting", () => {
  it("greets the small hours and the morning with umaga", () => {
    expect(filipinoGreeting(manilaWallClock(0))).toBe("Magandang umaga");
    expect(filipinoGreeting(manilaWallClock(6))).toBe("Magandang umaga");
    expect(filipinoGreeting(manilaWallClock(11, 59))).toBe("Magandang umaga");
  });

  it("greets the noon hour with tanghali", () => {
    expect(filipinoGreeting(manilaWallClock(12))).toBe("Magandang tanghali");
    expect(filipinoGreeting(manilaWallClock(12, 59))).toBe("Magandang tanghali");
  });

  it("greets the afternoon with hapon", () => {
    expect(filipinoGreeting(manilaWallClock(13))).toBe("Magandang hapon");
    expect(filipinoGreeting(manilaWallClock(17, 59))).toBe("Magandang hapon");
  });

  it("greets the evening with gabi", () => {
    expect(filipinoGreeting(manilaWallClock(18))).toBe("Magandang gabi");
    expect(filipinoGreeting(manilaWallClock(23))).toBe("Magandang gabi");
  });

  it("CRITICAL: says gabi for a Manila evening even though it is still morning in UTC", () => {
    // 11:00 UTC is 7pm in Manila. A server in UTC must not wish a consumer in
    // Cebu "magandang umaga" over their dinner.
    expect(filipinoGreeting(new Date("2026-07-26T11:00:00Z"))).toBe("Magandang gabi");
  });

  it("carries no name of its own", () => {
    expect(filipinoGreeting(manilaWallClock(9))).not.toContain(",");
  });
});

describe("manilaDateCaption", () => {
  it("names the Manila day, not the UTC day", () => {
    // 20:00 UTC on the 26th is already the 27th in Manila.
    const caption = manilaDateCaption(new Date("2026-07-26T20:00:00Z"));
    expect(caption).toContain("27");
    expect(caption).toContain("July");
  });
});
