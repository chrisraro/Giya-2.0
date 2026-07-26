"use client";

import { useFormStatus } from "react-dom";

import { cn } from "@/lib/utils";

// The submit button for one notification row, split out of notification-list
// so the row can show an OPTIMISTIC read state.
//
// Why this is honest optimism rather than a guess: `openNotification` marks the
// row read and then redirects, unconditionally. There is no branch in which the
// row stays unread after a successful submit. So the instant the form is
// submitted, "read" is the correct thing to show; waiting for the server round
// trip would only mean showing something known to be stale. Optimism is a lie
// when the outcome is uncertain, and this outcome is not.
//
// If the action fails, the redirect does not happen and the page stays put --
// at which point React clears the pending state and the row returns to unread
// on its own. Nothing to reconcile by hand.
//
// The rest of the row (icon plate, title, body, timestamp) is passed in as
// `children` from the server component and stays server-rendered: passing RSC
// output through a client boundary as children does not pull it into the
// client bundle. Only the ~30 lines below ship.

export function NotificationRowButton({
  unread,
  children,
}: {
  readonly unread: boolean;
  readonly children: React.ReactNode;
}) {
  const { pending } = useFormStatus();

  // Pending means "on its way to being read", so it renders as read.
  const showUnread = unread && !pending;

  return (
    <button
      type="submit"
      aria-busy={pending}
      className={cn(
        "flex w-full items-start gap-3 rounded-md3-md px-2 py-3 text-left",
        "transition-colors duration-200 ease-standard motion-reduce:transition-none",
        "hover:bg-surface-container",
        "outline-none focus-visible:ring-2 focus-visible:ring-primary",
        showUnread && "bg-surface-container-low",
      )}
    >
      {children}

      {/* The dot lives here rather than in the server row precisely so it can
          disappear the moment the row is tapped. It occupies a fixed 8px box
          either way, so removing it shifts nothing. */}
      <span className="mt-2 flex size-2 shrink-0 items-center justify-center">
        {showUnread ? (
          <span className="size-2 rounded-full bg-primary">
            <span className="sr-only">Unread</span>
          </span>
        ) : null}
      </span>
    </button>
  );
}
