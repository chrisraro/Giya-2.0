import { describe, expect, it } from "vitest";

import { isCampaignLive, isLiveAt } from "./lifecycle";

// The one "is this campaign live" rule (doc 34 section 3) in the shape DB rows
// arrive in: ISO strings, snake_case. Starts inclusive, ends exclusive.
const NOW = new Date("2026-08-10T00:00:00.000Z");

const base = { status: "active", starts_at: null, ends_at: null, deleted_at: null };

describe("isLiveAt", () => {
  it("is live when active with an open window", () => {
    expect(isLiveAt(base, NOW)).toBe(true);
  });

  it("excludes non-active statuses", () => {
    for (const status of ["draft", "scheduled", "paused", "ended", "archived"]) {
      expect(isLiveAt({ ...base, status }, NOW)).toBe(false);
    }
  });

  it("excludes a soft-deleted row", () => {
    expect(isLiveAt({ ...base, deleted_at: "2026-08-01T00:00:00Z" }, NOW)).toBe(false);
  });

  it("excludes a scheduled (future starts_at) row", () => {
    expect(isLiveAt({ ...base, starts_at: "2026-08-10T00:00:01Z" }, NOW)).toBe(false);
  });

  it("treats starts_at as inclusive", () => {
    expect(isLiveAt({ ...base, starts_at: "2026-08-10T00:00:00Z" }, NOW)).toBe(true);
  });

  it("treats ends_at as exclusive", () => {
    expect(isLiveAt({ ...base, ends_at: "2026-08-10T00:00:00Z" }, NOW)).toBe(false);
    expect(isLiveAt({ ...base, ends_at: "2026-08-10T00:00:01Z" }, NOW)).toBe(true);
  });

  it("accepts Date bounds and an omitted deleted_at", () => {
    expect(
      isLiveAt({ status: "active", starts_at: new Date(NOW), ends_at: null }, NOW),
    ).toBe(true);
  });

  it("fails closed on an unparseable bound", () => {
    expect(isLiveAt({ ...base, starts_at: "not-a-date" }, NOW)).toBe(false);
    expect(isLiveAt({ ...base, ends_at: "not-a-date" }, NOW)).toBe(false);
  });

  it("agrees with isCampaignLive at the boundaries", () => {
    const startsAt = new Date("2026-08-10T00:00:00.000Z");
    const endsAt = new Date("2026-08-11T00:00:00.000Z");
    for (const at of [
      new Date("2026-08-09T23:59:59.999Z"),
      startsAt,
      new Date("2026-08-10T23:59:59.999Z"),
      endsAt,
    ]) {
      const campaign = {
        type: "promotion" as const,
        status: "active" as const,
        startsAt,
        endsAt,
        timezone: "Asia/Manila",
        budget: {} as never,
      };
      expect(
        isLiveAt(
          { status: "active", starts_at: startsAt, ends_at: endsAt, deleted_at: null },
          at,
        ),
      ).toBe(isCampaignLive(campaign, at));
    }
  });
});
