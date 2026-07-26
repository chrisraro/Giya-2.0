import { redirect } from "next/navigation";

import { markAllNotificationsReadAction } from "@/features/notifications/actions";
import { MarkAllReadButton } from "@/features/notifications/components/mark-all-read-button";
import { NotificationList } from "@/features/notifications/components/notification-list";
import {
  getMyUnreadNotificationCount,
  listMyNotifications,
} from "@/features/notifications/server/repo";
import { getMyConsumerProfile } from "@/features/identity/server/repo";

// The in-app inbox. Doc 33's route inventory registers `/notifications` as an
// auth-required [MVP] route ("In-app inbox"), and doc 30 section 5.6 is its
// contract: list, unread badge, mark-read, mark-all-read.
//
// Reads the caller's own rows, so nothing here is cacheable across requests or
// across people.
export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  // Same gate as /home and /profile, for the same reason: an inbox is by
  // definition somebody's inbox, and there is no honest anonymous version of
  // one. 0026 backs this up rather than relying on it - anon holds no SELECT
  // privilege on the table at all.
  const profile = await getMyConsumerProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/notifications")}`);

  const [notifications, unread] = await Promise.all([
    listMyNotifications(),
    getMyUnreadNotificationCount(),
  ]);

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-headline-m text-on-surface">Notifications</h1>

        {/* MARK-AS-READ ON OPEN is deliberately an ACTION rather than a side
            effect of rendering this page.

            Marking everything read the moment the list is fetched reads well in
            a spec and badly in a hand: a consumer who opens the inbox, sees
            three bold rows and taps the wrong one has lost the other two, and
            a prefetch or a back-navigation would silently clear the badge for
            somebody who never looked. So the two real "read" moments are the
            ones a person performs - opening a notification (which marks that
            one, in openNotification) and pressing this button (which marks the
            rest). Both are server writes, so neither can race the navigation
            that follows.

            The button is absent at zero: there is nothing to mark, and an
            always-present control that does nothing is noise. */}
        {unread > 0 ? (
          <form action={markAllNotificationsReadAction}>
            {/* MarkAllReadButton reads useFormStatus from inside the form, so
                the form itself stays a server component and only the button
                ships JS. Marking a full inbox read is a write over a mobile
                connection; without this the control looked idle and invited a
                second press.

                It is a COMPONENT rather than a render prop, and that is the
                whole reason this file changed: a render prop would be a
                function crossing the server/client boundary, which React's
                Flight serializer rejects at render time. See the header of
                mark-all-read-button.tsx. */}
            <MarkAllReadButton />
          </form>
        ) : null}
      </header>

      {/* NO REALTIME, and it is a decision rather than an omission. Doc 30
          section 5.2 is explicit: "notifications are poll-based by design" -
          the two Realtime channels this app holds (receipt status, redemption
          confirmation) are the sanctioned uses in doc 10 D5, and `notifications`
          is not in the supabase_realtime publication. Adding it would mean a
          publication migration plus a socket per open inbox to move a badge
          that a navigation already refreshes. The receipt status screen, which
          is where these notifications point, keeps its Realtime channel and its
          poll fallback; that is the surface where seconds matter. */}
      <NotificationList notifications={notifications} />
    </main>
  );
}
