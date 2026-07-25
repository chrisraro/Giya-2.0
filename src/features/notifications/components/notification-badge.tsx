import { cn } from "@/lib/utils";

// The unread count, as a number people act on.
//
// ZERO RENDERS NOTHING, matching the business sidebar's review-queue badge for
// the same reason it gives: an empty inbox is the steady state, and a permanent
// "0" trains people to ignore the one place a number matters. The read path
// also returns 0 when it fails, so "cannot be read" collapses into the same
// silence rather than into a wrong number.
//
// TOKENS ONLY, and specifically NOT tertiary. Mango is rewards language (doc
// 16) and this badge counts rejections and review notices as readily as awards,
// so it wears the error container - the same call the sidebar badge made, and
// for the same reason.

/**
 * Above this the badge reads "99+", matching BADGE_CAP in the business sidebar
 * so the two counters in this app behave identically. Lives here rather than
 * beside the query because the cap is a rendering decision and this file is
 * the only thing that renders it.
 */
export const NOTIFICATION_BADGE_CAP = 99;

export interface NotificationBadgeProps {
  count: number;
  className?: string;
}

export function notificationBadgeLabel(count: number): string {
  return count > NOTIFICATION_BADGE_CAP ? `${NOTIFICATION_BADGE_CAP}+` : String(count);
}

export function NotificationBadge({ count, className }: NotificationBadgeProps) {
  if (count <= 0) return null;
  const label = notificationBadgeLabel(count);
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full bg-error-container px-1.5",
        "font-mono text-label-s text-on-error-container",
        className,
      )}
    >
      {/* The screen-reader string carries the noun; the visible glyph is just
          the number, which on its own would be announced as a stray digit. */}
      <span className="sr-only">{`${label} unread notifications`}</span>
      <span aria-hidden>{label}</span>
    </span>
  );
}
