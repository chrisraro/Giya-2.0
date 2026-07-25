import Link from "next/link";

import { cn } from "@/lib/utils";

import { NotificationBadge } from "./notification-badge";

// The header affordance: an icon button to the inbox, carrying the unread
// count.
//
// WHY A HEADER BELL AND NOT A FIFTH NAV DESTINATION. The bottom navigation is
// full and cannot take another slot: MD3 caps a navigation bar at five
// destinations, and this app spends all five on Home, Wallet, the Scan FAB,
// Rewards and Profile inside a 448px row (see src/components/shell/bottom-nav
// .tsx, which already refused /receipts for exactly this reason). A sixth tap
// target would break the symmetric two-FAB-two layout for a screen people
// glance at rather than live in.
//
// A bell is the right shape for what is left over: it is a STATE indicator
// first and a destination second. It has to be visible without being visited -
// the whole job of an unread badge is to be seen on a screen that is not the
// inbox - and the header is the one place in this shell that is on-screen at
// the top of every visit. Home is where it goes because home is the first
// screen after sign-in and the screen a consumer opens asking the question this
// badge answers: did my points land?
//
// The Profile screen keeps a second, quieter entry (its "Notifications" settings
// row, which was a dead affordance with no href until this slice). That is the
// navigational home for people who go looking rather than glancing, and it
// costs nothing: both read the same count.
//
// Purely presentational. The count is resolved by the server component that
// renders this, so the bell can appear on any screen without dragging a query
// into a component tree.

export interface NotificationBellProps {
  unreadCount: number;
  className?: string;
}

export function NotificationBell({ unreadCount, className }: NotificationBellProps) {
  const hasUnread = unreadCount > 0;
  return (
    <Link
      href="/notifications"
      // The accessible name carries the count, because the badge glyph is
      // aria-hidden and "Notifications" alone would hide the one fact this
      // control exists to communicate.
      aria-label={
        hasUnread ? `Notifications, ${unreadCount} unread` : "Notifications"
      }
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center rounded-full",
        "text-on-surface-variant transition-colors duration-200 ease-standard",
        "hover:bg-surface-container-high",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
    >
      <span aria-hidden className={cn("material-symbols-rounded", hasUnread && "is-filled")}>
        notifications
      </span>
      {hasUnread ? (
        <NotificationBadge
          count={unreadCount}
          // Anchored to the icon rather than laid out beside it: the badge is
          // an overlay on the affordance in MD3, and the row it sits in is a
          // fixed-height header.
          className="absolute right-0 top-0"
        />
      ) : null}
    </Link>
  );
}
