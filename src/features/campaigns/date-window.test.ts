import { describe, it, expect, afterEach } from "vitest";

import { CAMPAIGN_TIMEZONE, startOfDayInZone, endOfDayExclusiveInZone } from "./date-window";
import { isCampaignLive } from "./lifecycle";
import type { Campaign } from "./types";

const makeCampaign = (overrides: Partial<Campaign> = {}): Campaign => ({
  type: "promotion",
  status: "active",
  startsAt: null,
  endsAt: null,
  timezone: CAMPAIGN_TIMEZONE,
  budget: {},
  ...overrides,
});

describe("startOfDayInZone", () => {
  it("resolves 2026-08-01 00:00 Asia/Manila to 2026-07-31T16:00:00.000Z (UTC+8)", () => {
    const result = startOfDayInZone("2026-08-01", CAMPAIGN_TIMEZONE);
    expect(result.toISOString()).toBe("2026-07-31T16:00:00.000Z");
  });

  it("rolls over year/month boundaries correctly (2026-01-01)", () => {
    const result = startOfDayInZone("2026-01-01", CAMPAIGN_TIMEZONE);
    expect(result.toISOString()).toBe("2025-12-31T16:00:00.000Z");
  });
});

describe("endOfDayExclusiveInZone", () => {
  it("resolves an end date of 2026-08-01 to 2026-08-02T00:00 Manila = 2026-08-01T16:00:00.000Z", () => {
    const result = endOfDayExclusiveInZone("2026-08-01", CAMPAIGN_TIMEZONE);
    expect(result.toISOString()).toBe("2026-08-01T16:00:00.000Z");
  });

  it("rolls over a month-end end date (2026-01-31 -> next day is 2026-02-01)", () => {
    const result = endOfDayExclusiveInZone("2026-01-31", CAMPAIGN_TIMEZONE);
    // 2026-02-01T00:00 Manila = 2026-01-31T16:00:00Z
    expect(result.toISOString()).toBe("2026-01-31T16:00:00.000Z");
  });
});

describe("isCampaignLive against a Manila-zoned schedule window", () => {
  const campaign = makeCampaign({
    status: "active",
    startsAt: startOfDayInZone("2026-07-01", CAMPAIGN_TIMEZONE),
    endsAt: endOfDayExclusiveInZone("2026-08-01", CAMPAIGN_TIMEZONE),
  });

  it("is live at 2026-08-01T23:59 Manila (2026-08-01T15:59:00Z)", () => {
    expect(isCampaignLive(campaign, new Date("2026-08-01T15:59:00.000Z"))).toBe(true);
  });

  it("is NOT live at 2026-08-02T00:00 Manila (2026-08-01T16:00:00Z) - the day after the advertised end date", () => {
    expect(isCampaignLive(campaign, new Date("2026-08-01T16:00:00.000Z"))).toBe(false);
  });

  it("is live for the entirety of the advertised end date (Aug 1), not just its first instant", () => {
    // Just after midnight Manila on Aug 1 itself.
    expect(isCampaignLive(campaign, new Date("2026-07-31T16:00:01.000Z"))).toBe(true);
    // Mid-afternoon Manila on Aug 1.
    expect(isCampaignLive(campaign, new Date("2026-08-01T06:00:00.000Z"))).toBe(true);
  });
});

describe("host timezone independence", () => {
  const originalTZ = process.env.TZ;

  afterEach(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  it("produces the same instants no matter what timezone the host/browser is running in", () => {
    process.env.TZ = "America/Los_Angeles";
    const laStart = startOfDayInZone("2026-08-01", CAMPAIGN_TIMEZONE);
    const laEnd = endOfDayExclusiveInZone("2026-08-01", CAMPAIGN_TIMEZONE);

    process.env.TZ = "Asia/Manila";
    const manilaStart = startOfDayInZone("2026-08-01", CAMPAIGN_TIMEZONE);
    const manilaEnd = endOfDayExclusiveInZone("2026-08-01", CAMPAIGN_TIMEZONE);

    process.env.TZ = "UTC";
    const utcStart = startOfDayInZone("2026-08-01", CAMPAIGN_TIMEZONE);
    const utcEnd = endOfDayExclusiveInZone("2026-08-01", CAMPAIGN_TIMEZONE);

    expect(laStart.getTime()).toBe(manilaStart.getTime());
    expect(utcStart.getTime()).toBe(manilaStart.getTime());
    expect(laEnd.getTime()).toBe(manilaEnd.getTime());
    expect(utcEnd.getTime()).toBe(manilaEnd.getTime());

    expect(manilaStart.toISOString()).toBe("2026-07-31T16:00:00.000Z");
    expect(manilaEnd.toISOString()).toBe("2026-08-01T16:00:00.000Z");
  });
});
