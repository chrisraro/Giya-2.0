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
  // Doc 30 section 5.3's staff-facing row, raised for the first time by task
  // 1.2 (0040): a campaign auto-paused itself because its `max_total_points`
  // budget (doc 34 section 5) is fully spent. See the header note below on
  // why this one kind is addressed to a business owner rather than a
  // consumer.
  "campaign_budget_exhausted",
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

/**
 * The delivery channels this schema can hold, matching the check constraint on
 * `notifications.channel` in 0030_notification_delivery.sql. 'push' is in the
 * vocabulary and in no kind's channel list: there are still no VAPID keys and no
 * FCM registration, so a kind that claimed push would fan out rows nothing sends.
 */
export type NotificationChannel = "in_app" | "push" | "email";

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
  /**
   * Doc 30 section 5.3's "Default channels" column, narrowed to what this build
   * can actually deliver. `in_app` is on every kind and always will be: doc 33
   * calls the inbox "the guaranteed fallback channel on every platform".
   *
   * WHICH KINDS EMAIL, AND WHY THE LIST IS ONE ITEM LONG
   *
   * An email is the only channel here that PERSISTS somewhere the reader did
   * not choose. It sits in an inbox, it is searchable, it is forwarded, it is
   * scanned by a mail provider, and it cannot be recalled. Every other channel
   * this app has is a surface the consumer opens on purpose. So the bar for
   * adding a kind to this list is not "would a message be nice here" but "would
   * the consumer be worse off if they only found out the next time they opened
   * the app" - and for four of these five, the honest answer is no:
   *
   *   points_awarded    NO. The reward IS the notification, and the consumer is
   *                     holding their phone in the shop when it lands: they
   *                     scanned a receipt seconds ago and the wallet already
   *                     shows the balance. An email per receipt is also the
   *                     fastest way for a loyalty app to be filed as
   *                     promotional by a mail provider, which would then bury
   *                     the one message below that genuinely needs to arrive.
   *   receipt_in_review NO. "A person will look at this within a day" is not
   *                     actionable, and it doubles the traffic on the same
   *                     receipt: this message would be followed by either
   *                     silence (approved) or the rejection email below. Two
   *                     emails to say one thing.
   *   reward_claimed    NO. The consumer just tapped Claim. They are in the app,
   *                     on the claim screen, looking at the code.
   *   reward_expiring   NO, and not yet either: it is a nudge rather than an
   *                     outcome, which puts it close enough to marketing that it
   *                     needs doc 30 section 5.5's preference gating to be real
   *                     for a channel that does not have it yet.
   *
   *   receipt_rejected  YES, and it is the whole list. It is the only kind where
   *                     the consumer expected something and got nothing, where
   *                     there is a next step only they can take (retake the
   *                     photo, or ask the shop to look again), and - the part
   *                     that decides it - where the absence of the good outcome
   *                     is itself the reason they might not open the app to find
   *                     out. Every other kind is delivered by the consumer's own
   *                     curiosity. This one is not.
   *
   * The copy is safe to persist, and that had to be checked separately: doc 33's
   * "never expose fraud signal internals" matters more in an inbox than on a
   * screen. It holds because the rejection strings come from
   * ../receipts/components/receipt-copy.ts, which is swept string by string
   * against doc 37's vocabulary, and the email renders the row rather than
   * writing new words. See src/lib/email/render.ts.
   *
   * It is far easier to add a kind to this list than to un-send what it sent.
   */
  channels: readonly NotificationChannel[];
}

export const NOTIFICATION_KIND_REGISTRY: Record<NotificationKind, NotificationKindEntry> = {
  points_awarded: {
    icon: "check_circle",
    tone: "reward",
    transactional: true,
    channels: ["in_app"],
  },
  receipt_rejected: {
    icon: "info",
    tone: "muted",
    transactional: true,
    channels: ["in_app", "email"],
  },
  receipt_in_review: {
    icon: "hourglass_top",
    tone: "waiting",
    transactional: true,
    channels: ["in_app"],
  },
  reward_claimed: { icon: "redeem", tone: "reward", transactional: true, channels: ["in_app"] },
  reward_expiring: { icon: "schedule", tone: "waiting", transactional: true, channels: ["in_app"] },
  // "muted", never "reward": nothing here is a celebration, and Mango is
  // rewards language only (see this file's tone doc above). Emails too - see
  // the header note by this kind's audience for why it earns the second
  // channel most kinds here deliberately do not get.
  campaign_budget_exhausted: {
    icon: "warning",
    tone: "muted",
    transactional: true,
    channels: ["in_app", "email"],
  },
};

/** Whether a kind is delivered by email as well as to the inbox. */
export function kindEmails(kind: string): boolean {
  return isNotificationKind(kind)
    ? NOTIFICATION_KIND_REGISTRY[kind].channels.includes("email")
    : false;
}

// EVERY KIND BUT ONE IS ADDRESSED TO A CONSUMER, and that is why this slice
// otherwise ships no business-side notification surface.
//
// The one thing a merchant needed to be told, before task 1.2, was that a
// receipt is waiting for review - and the business portal already tells them
// that, twice and from live data: the sidebar badge
// (src/components/business/sidebar.tsx, fed by the portal LAYOUT so it is on
// every portal screen) and the dashboard's ReviewQueueTile, both derived from
// `countPendingReview` over the real queue, both capped at 99+, both linking
// to /business/receipts.
//
// A merchant inbox for THAT signal would be a second, worse copy of it:
// derived from rows rather than from the queue, so it would drift the moment
// a colleague cleared an item, and it would need a `receipt_needs_review` kind
// addressed to every owner and manager, i.e. a fan-out with no reader that the
// existing badge does not already have - a receipt waiting for review is a
// QUEUE, and a queue is better shown as a count on the door than as a message
// in a box.
//
// `campaign_budget_exhausted` (task 1.2, 0040) is different in kind, not just
// audience: doc 34 section 5's exhaustion is a ONE-TIME EVENT (a campaign
// crossing from "has budget" to "fully spent, now paused"), not a standing
// count anything on the portal already renders continuously - by the time an
// owner next opens the dashboard, the campaign that ran out and auto-paused
// itself is easy to miss among everything else that changed. It is doc 30
// section 5.3's first staff-facing kind to actually ship; `staff_invite` and
// `verification_decision` remain reserved names for the slices that will
// raise them.

/** Fallback for a kind the database holds and this build does not know (a row
 * written by a newer deploy, read by an older one). Never leaves a row blank. */
const UNKNOWN_KIND_ENTRY: NotificationKindEntry = {
  icon: "notifications",
  tone: "neutral",
  transactional: true,
  // Inbox only. An unknown kind is one this build cannot render, let alone
  // decide is worth an inbox in someone's email, and the fallback for "I do not
  // know what this is" must never be "send it to their inbox anyway".
  channels: ["in_app"],
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
