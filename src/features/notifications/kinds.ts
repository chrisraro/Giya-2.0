// The notification kind registry. Doc 20-data/25-schema-platform.md names this
// exact file as its home ("registry lives in src/features/notifications/kinds.ts
// with per-kind template + deep link; adding a kind is code + doc, not
// schema") and doc 30-modules/30-platform-core.md section 5.3 is the table it
// mirrors.
//
// Pure: no React, no database, no network. Everything here is a lookup a
// server component, a client island and a test can all share.
//
// WHAT IS AND IS NOT IN THIS FILE
//
// The per-kind TEMPLATE is deliberately NOT here. Doc 30 section 5.2 step 2 has
// the fan-out render title/body from the kind's template, and for the three
// receipt kinds that template already exists, tested string by string, in
// src/features/receipts/components/receipt-copy.ts - the consumer-safe copy
// matrix whose whole job is to say what happened without saying which detector
// tripped. Restating those strings here would create a second set that could
// drift into leaking exactly what the first set is careful not to, so the
// receipts slice composes its own messages (server/notify.ts) and this file
// owns only what is genuinely cross-kind: identity, presentation, and the deep
// link accessor.
//
// What IS here is what the inbox needs to render a row it did not compose: an
// icon, a tone, and a safe way to read the stored route.

/**
 * Every value `notifications.kind` may hold, and the same list the check
 * constraint in 0026_notifications.sql enforces. The two are kept in step by
 * hand and by `notification-kinds.test.ts`; adding a kind is a code change here
 * plus a migration there, which is the deliberate cost of enumerating the
 * vocabulary in the database (see the migration for why that trade is right on
 * this table and wrong on audit_logs).
 */
export const NOTIFICATION_KINDS = [
  "points_awarded",
  "receipt_rejected",
  "receipt_in_review",
  "reward_claimed",
  "reward_expiring",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/**
 * Which MD3 role family a row wears. Returned as a NAME rather than a class
 * string, exactly as `receiptTone` does in the receipts slice, so this module
 * stays free of presentation details and the components keep ownership of
 * their tokens.
 *
 * "reward" is the Mango (tertiary) family and is REWARDS LANGUAGE ONLY per doc
 * 16. That is why `points_awarded` and `reward_claimed` carry it and
 * `receipt_rejected` carries "muted": a rejection dressed in the celebration
 * colour would be the design system lying about the message.
 */
export type NotificationTone = "reward" | "waiting" | "muted" | "neutral";

export interface NotificationKindEntry {
  /** Material Symbols icon name, matching the one receipt-copy.ts uses for the
   * same outcome so the inbox row and the status screen agree. */
  icon: string;
  tone: NotificationTone;
  /**
   * Doc 30 section 5.4's classification. Every kind here is transactional: it
   * is the outcome of something the recipient did, so doc 30 section 5.5's
   * marketing opt-in does not gate it. Recorded rather than assumed because
   * the first marketing kind (`campaign_push`) lands in the campaign send
   * slice and will be the first `false`.
   */
  transactional: boolean;
}

export const NOTIFICATION_KIND_REGISTRY: Record<NotificationKind, NotificationKindEntry> = {
  points_awarded: { icon: "check_circle", tone: "reward", transactional: true },
  receipt_rejected: { icon: "info", tone: "muted", transactional: true },
  receipt_in_review: { icon: "hourglass_top", tone: "waiting", transactional: true },
  reward_claimed: { icon: "redeem", tone: "reward", transactional: true },
  reward_expiring: { icon: "schedule", tone: "waiting", transactional: true },
};

// EVERY KIND ABOVE IS ADDRESSED TO A CONSUMER, and that is why this slice ships
// no business-side notification surface.
//
// The one thing a merchant needs to be told today is that a receipt is waiting
// for review, and the business portal already tells them, twice and from live
// data: the sidebar badge (src/components/business/sidebar.tsx, fed by the
// portal LAYOUT so it is on every portal screen) and the dashboard's
// ReviewQueueTile, both derived from `countPendingReview` over the real queue,
// both capped at 99+, both linking to /business/receipts.
//
// A merchant inbox would be a second, worse copy of that signal: derived from
// rows rather than from the queue, so it would drift the moment a colleague
// cleared an item, and it would need a `receipt_needs_review` kind addressed to
// every owner and manager, i.e. a fan-out with no reader that the existing
// badge does not already have. Doc 30 section 5.3 does register staff-facing
// kinds (staff_invite, verification_decision, campaign_budget_exhausted), and
// each of them lands with the slice that raises it - none of them is a receipt
// waiting for review, because that one is a QUEUE, and a queue is better shown
// as a count on the door than as a message in a box.

/** Fallback for a kind the database holds and this build does not know (a row
 * written by a newer deploy, read by an older one). Never leaves a row blank. */
const UNKNOWN_KIND_ENTRY: NotificationKindEntry = {
  icon: "notifications",
  tone: "neutral",
  transactional: true,
};

export function notificationKindEntry(kind: string): NotificationKindEntry {
  return isNotificationKind(kind) ? NOTIFICATION_KIND_REGISTRY[kind] : UNKNOWN_KIND_ENTRY;
}

/**
 * The deep link, read out of `notifications.data` (doc 30 section 5.3: `data`
 * is always `{route, params}`).
 *
 * TREATED AS UNTRUSTED, even though only the service role can write it. `data`
 * is a jsonb column, the row is rendered as an anchor, and the cost of being
 * wrong is an open redirect off a link the consumer has every reason to trust.
 * So: a string, absolute-path-relative (one leading slash, and NOT two, which
 * is how `//evil.example` becomes a protocol-relative URL), and nothing else.
 * Anything failing that reads as "no link", and the inbox renders the row as
 * plain text rather than as a link somewhere unexpected.
 */
export function notificationRoute(data: unknown): string | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const route = (data as Record<string, unknown>).route;
  if (typeof route !== "string") return null;
  if (!route.startsWith("/") || route.startsWith("//")) return null;
  return route;
}
