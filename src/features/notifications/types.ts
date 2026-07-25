import type { NotificationKind } from "./kinds";

/**
 * One inbox row as every surface renders it. Explicitly mapped from the
 * database row rather than passed through (doc 13: "Response DTOs are ...
 * explicitly mapped from DB rows - never `select *` straight to JSON"), which
 * is what lets `data` be collapsed to the one field a row actually uses.
 *
 * `kind` is narrowed to the union here rather than left as the column's `text`.
 * A row written by a newer deploy than this build carries a kind this type does
 * not name; `toNotificationDTO` keeps it as a raw string in that case rather
 * than inventing a value, so the field is typed `NotificationKind | string` at
 * exactly the one place that uncertainty is real.
 */
export interface NotificationDTO {
  id: string;
  kind: NotificationKind | string;
  title: string;
  body: string;
  /** The deep link, already validated by `notificationRoute`. Null = not a link. */
  route: string | null;
  /** Sender tenant; null = the platform itself. */
  businessId: string | null;
  /** ISO timestamp, or null while unread. Null is what the badge counts. */
  readAt: string | null;
  createdAt: string;
}
