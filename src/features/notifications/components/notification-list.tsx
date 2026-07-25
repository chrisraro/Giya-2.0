import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import { openNotification } from "../actions";
import { notificationKindEntry } from "../kinds";
import type { NotificationTone } from "../kinds";
import type { NotificationDTO } from "../types";

// The inbox list (doc 30 section 5.6: "grouped by day; tap -> deep link + mark
// read. Empty state: illustration + 'You're all caught up.'").
//
// A plain server component with NO client JavaScript. Each row is a form
// posting the notification's id to `openNotification`, which marks it read on
// the server and then redirects to the row's own stored deep link. That is the
// whole interaction, and doing it this way means mark-read cannot lose a race
// with navigation: a consumer never arrives at the deep link with the row still
// bold behind them.
//
// TOKENS ONLY, both themes. The one tone that reaches tertiary (Mango) is
// "reward", which the kind registry assigns to points_awarded and
// reward_claimed and never to receipt_rejected, because doc 16 makes Mango
// rewards language and a rejection dressed in the celebration colour would be
// the design system lying about the message.

/** Icon plate colours per tone. Tertiary appears once, deliberately. */
const TONE_PLATE: Record<NotificationTone, string> = {
  reward: "bg-tertiary-container text-on-tertiary-container",
  waiting: "bg-secondary-container text-on-secondary-container",
  muted: "bg-surface-container-high text-on-surface-variant",
  neutral: "bg-surface-container-high text-on-surface-variant",
};

/**
 * Manila day label for the group headings. "Today" and "Yesterday" beat a date
 * for the two groups that carry almost every unread row, and doc 40 fixes
 * Asia/Manila as the day boundary for everything in this system.
 */
const MANILA = "Asia/Manila";

function manilaDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function dayHeading(iso: string, now: Date): string {
  const day = manilaDay(iso);
  if (day === manilaDay(now.toISOString())) return "Today";
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (day === manilaDay(yesterday.toISOString())) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MANILA,
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

function timeLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MANILA,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Contiguous runs of the same Manila day, in the order the rows arrived
 * (newest first), so the grouping never reorders anything. */
export function groupByDay(
  notifications: readonly NotificationDTO[],
  now: Date,
): { heading: string; items: NotificationDTO[] }[] {
  const groups: { heading: string; items: NotificationDTO[] }[] = [];
  for (const item of notifications) {
    const heading = dayHeading(item.createdAt, now);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.heading === heading) {
      last.items.push(item);
      continue;
    }
    groups.push({ heading, items: [item] });
  }
  return groups;
}

export interface NotificationListProps {
  notifications: readonly NotificationDTO[];
  /** Injected so the "Today" boundary is testable and the component stays pure. */
  now?: Date;
}

export function NotificationList({ notifications, now = new Date() }: NotificationListProps) {
  if (notifications.length === 0) {
    return (
      <EmptyState
        className="mt-6"
        icon="notifications"
        title="You are all caught up"
        body="Updates about your receipts, your points and your rewards will show up here."
        action={{ label: "Scan a receipt", href: "/scan" }}
      />
    );
  }

  return (
    <div className="mt-4 space-y-6">
      {groupByDay(notifications, now).map((group) => (
        <section key={group.heading}>
          <h2 className="px-2 text-label-l text-on-surface-variant">{group.heading}</h2>
          <ul className="mt-1 space-y-1">
            {group.items.map((item) => (
              <li key={item.id}>
                <NotificationRow notification={item} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function NotificationRow({ notification }: { notification: NotificationDTO }) {
  const entry = notificationKindEntry(notification.kind);
  const unread = notification.readAt === null;

  return (
    <form action={openNotification}>
      <input type="hidden" name="id" value={notification.id} />
      {/* No `route` field. The destination is read back off the row inside the
          action, under RLS, so a hand-crafted POST cannot turn this into an
          open redirect. */}
      <button
        type="submit"
        className={cn(
          "flex w-full items-start gap-3 rounded-md3-md px-2 py-3 text-left",
          "transition-colors duration-200 ease-standard hover:bg-surface-container",
          "outline-none focus-visible:ring-2 focus-visible:ring-primary",
          unread && "bg-surface-container-low",
        )}
      >
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full",
            TONE_PLATE[entry.tone],
          )}
        >
          <span
            aria-hidden
            className={cn(
              "material-symbols-rounded text-[20px]",
              entry.tone === "reward" && "is-filled",
            )}
          >
            {entry.icon}
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-body-l",
              unread ? "text-on-surface" : "text-on-surface-variant",
            )}
          >
            {notification.title}
          </p>
          {/* Clamped rather than truncated: the body is a sentence and the
              second line is usually the useful one. */}
          <p className="line-clamp-2 text-body-s text-on-surface-variant">
            {notification.body}
          </p>
          <p className="mt-0.5 text-label-s text-on-surface-variant">
            {timeLabel(notification.createdAt)}
          </p>
        </div>

        {unread ? (
          <span className="mt-2 size-2 shrink-0 rounded-full bg-primary">
            <span className="sr-only">Unread</span>
          </span>
        ) : null}
      </button>
    </form>
  );
}
