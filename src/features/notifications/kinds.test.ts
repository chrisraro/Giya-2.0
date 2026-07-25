import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_REGISTRY,
  isNotificationKind,
  notificationKindEntry,
  notificationRoute,
} from "./kinds";
import type { NotificationKind } from "./kinds";

// The kind registry. Small file, three properties worth pinning:
//   1. it matches the database's check constraint,
//   2. Mango stays rewards language,
//   3. the stored deep link cannot become an open redirect.

/**
 * The exact value list in 0026_notifications.sql's `kind` check constraint,
 * transcribed. The migration is the enforcement and this array is the alarm: a
 * kind added to one and not the other means either a 23514 on a real event or a
 * dead constant, and both are silent until someone scans a receipt.
 */
const MIGRATION_0026_KINDS = [
  "points_awarded",
  "receipt_rejected",
  "receipt_in_review",
  "reward_claimed",
  "reward_expiring",
];

describe("the kind list matches the database", () => {
  it("CRITICAL: is exactly 0026_notifications.sql's check constraint", () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual([...MIGRATION_0026_KINDS].sort());
  });

  it("has a registry entry for every kind, so no row can render blank", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_REGISTRY[kind]).toBeDefined();
      expect(NOTIFICATION_KIND_REGISTRY[kind].icon.length).toBeGreaterThan(0);
    }
  });

  it("recognises its own kinds and nothing else", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(isNotificationKind(kind)).toBe(true);
    }
    expect(isNotificationKind("campaign_push")).toBe(false);
    expect(isNotificationKind("")).toBe(false);
  });

  it("falls back rather than failing for a kind a newer deploy wrote", () => {
    const entry = notificationKindEntry("announcement");
    expect(entry.icon).toBe("notifications");
    expect(entry.tone).toBe("neutral");
  });
});

describe("Mango is rewards language (doc 16)", () => {
  /** The tones this app renders with tertiary tokens. */
  const MANGO_TONES = ["reward"];

  it("CRITICAL: receipt_rejected never wears the reward tone", () => {
    expect(MANGO_TONES).not.toContain(NOTIFICATION_KIND_REGISTRY.receipt_rejected.tone);
  });

  it("CRITICAL: no outcome that is not a reward wears it either", () => {
    const notRewards: NotificationKind[] = [
      "receipt_rejected",
      "receipt_in_review",
      "reward_expiring",
    ];
    for (const kind of notRewards) {
      expect(
        MANGO_TONES,
        `${kind} must not use the Mango (reward) tone`,
      ).not.toContain(NOTIFICATION_KIND_REGISTRY[kind].tone);
    }
  });

  it("does reach the two kinds that are genuinely rewards language", () => {
    expect(NOTIFICATION_KIND_REGISTRY.points_awarded.tone).toBe("reward");
    expect(NOTIFICATION_KIND_REGISTRY.reward_claimed.tone).toBe("reward");
  });
});

describe("every kind this slice raises is transactional", () => {
  // Doc 30 section 5.4/5.5: marketing kinds need marketing_opt_in, and a
  // transactional in_app row ignores toggles. The first `false` here will be
  // campaign_push, and it must arrive with the preference check, not before it.
  it("is classed transactional, so no preference gate is silently skipped", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_REGISTRY[kind].transactional).toBe(true);
    }
  });
});

describe("notificationRoute", () => {
  it("reads an app-relative route out of the data payload", () => {
    expect(notificationRoute({ route: "/scan/abc", params: { receipt_id: "abc" } })).toBe(
      "/scan/abc",
    );
  });

  it("CRITICAL: refuses a protocol-relative route, which is an off-site redirect", () => {
    expect(notificationRoute({ route: "//evil.example/steal" })).toBeNull();
  });

  it("CRITICAL: refuses an absolute URL", () => {
    expect(notificationRoute({ route: "https://evil.example/steal" })).toBeNull();
    expect(notificationRoute({ route: "javascript:alert(1)" })).toBeNull();
  });

  it("refuses a relative path with no leading slash", () => {
    expect(notificationRoute({ route: "scan/abc" })).toBeNull();
  });

  it("answers null for every shape that is not a route", () => {
    expect(notificationRoute({})).toBeNull();
    expect(notificationRoute({ route: 12 })).toBeNull();
    expect(notificationRoute(null)).toBeNull();
    expect(notificationRoute("/scan/abc")).toBeNull();
    expect(notificationRoute([{ route: "/scan/abc" }])).toBeNull();
    expect(notificationRoute(undefined)).toBeNull();
  });
});
