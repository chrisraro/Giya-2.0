import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_REGISTRY,
  isNotificationKind,
  kindEmails,
  notificationKindEntry,
  notificationRoute,
} from "./kinds";
import type { NotificationKind } from "./kinds";

// The kind registry. Small file, three properties worth pinning:
//   1. it matches the database's check constraint,
//   2. Mango stays rewards language,
//   3. the stored deep link cannot become an open redirect.

/**
 * The exact value list in the database's `notifications_kind_check`
 * constraint, transcribed: the five 0026_notifications.sql originally shipped
 * plus `campaign_budget_exhausted` (0040, task 1.2) and `points_expiring`
 * (0044, task 1.3). The migration is the enforcement and this array is the
 * alarm: a kind added to one and not the other means either a 23514 on a real
 * event or a dead constant, and both are silent until someone scans a receipt,
 * a campaign runs out of budget, or a consumer's points near expiry.
 */
const DATABASE_KINDS = [
  "points_awarded",
  "receipt_rejected",
  "receipt_in_review",
  "reward_claimed",
  "reward_expiring",
  "campaign_budget_exhausted",
  "points_expiring",
];

describe("the kind list matches the database", () => {
  it("CRITICAL: is exactly the database's notifications_kind_check constraint (0026 + 0040)", () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual([...DATABASE_KINDS].sort());
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
      "campaign_budget_exhausted",
      "points_expiring",
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

// ===========================================================================
// Channels
// ===========================================================================
//
// The email list is one item long and the registry argues each inclusion and
// each exclusion at length. These tests pin the OUTCOME of that argument,
// because the argument lives in a comment and a comment does not fail a build.
//
// The bar, restated: an email is the only channel here that persists somewhere
// the reader did not choose. It sits in an inbox, it is searchable, it is
// forwarded, and it cannot be recalled. It is far easier to add a kind to this
// list than to un-send what it sent.

describe("channels", () => {
  it("delivers every kind to the inbox, which is the guaranteed channel", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_REGISTRY[kind].channels).toContain("in_app");
    }
  });

  it("emails exactly three kinds: the rejection the consumer must act on, the budget alert the owner must act on, and the expiry warning the consumer must act on before its deadline", () => {
    const emailing = NOTIFICATION_KINDS.filter((kind) => kindEmails(kind));
    expect([...emailing].sort()).toEqual([
      "campaign_budget_exhausted",
      "points_expiring",
      "receipt_rejected",
    ]);
  });

  it("does not email the good news, which the consumer opens the app for anyway", () => {
    expect(kindEmails("points_awarded")).toBe(false);
    expect(kindEmails("reward_claimed")).toBe(false);
  });

  it("does not email a receipt routed to a human, which is not actionable", () => {
    expect(kindEmails("receipt_in_review")).toBe(false);
  });

  // There are no VAPID keys and no service worker push registration, so a kind
  // that claimed push would fan out rows nothing sends.
  it("claims no push channel, because nothing can deliver one", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KIND_REGISTRY[kind].channels).not.toContain("push");
    }
  });

  // The fallback for "I do not know what this is" must never be "send it to
  // their inbox anyway".
  it("never emails a kind this build does not know", () => {
    expect(kindEmails("campaign_push")).toBe(false);
    expect(notificationKindEntry("campaign_push").channels).toEqual(["in_app"]);
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
