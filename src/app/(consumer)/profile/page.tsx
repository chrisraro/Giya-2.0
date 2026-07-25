import Link from "next/link";
import { redirect } from "next/navigation";

import { signOut } from "@/features/identity/actions";
import { emailLocalPart, initialsFrom } from "@/features/identity/display-name";
import { getMyConsumerProfile } from "@/features/identity/server/repo";
import { NotificationBadge } from "@/features/notifications/components/notification-badge";
import { getMyUnreadNotificationCount } from "@/features/notifications/server/repo";

// The "Notifications" row was a dead affordance until this slice: it rendered
// with no href and went nowhere. It is the quieter of the inbox's two entry
// points (the other is the home header bell) and it is the one for people who
// go looking rather than glancing, so it now links to the inbox and carries the
// same unread count.
const SETTINGS_ROWS = [
  { icon: "notifications", label: "Notifications", href: "/notifications" },
  { icon: "devices", label: "Devices", href: undefined },
  { icon: "privacy_tip", label: "Privacy policy", href: "/privacy" },
  { icon: "description", label: "Terms", href: "/terms" },
] as const;

const ROW_CLASS = "flex items-center gap-3 px-4 py-4";

// Reads the caller's own profile, so it can never be cached across people.
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  // Same gate as /home, for the same reason: a profile page is by definition
  // somebody's profile, and an anonymous visitor must never be shown one.
  const profile = await getMyConsumerProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/profile")}`);

  const unreadNotifications = await getMyUnreadNotificationCount();

  // profiles.display_name is NOT NULL, so the fallbacks below only fire when
  // the row is missing entirely (a session that predates its profile row).
  // Falling back to the email local part beats printing a placeholder person.
  const localPart = emailLocalPart(profile.email);
  const name = profile.displayName || localPart || "Your account";
  const initials = initialsFrom(profile.displayName) || initialsFrom(localPart) || "?";

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <h1 className="text-headline-m text-on-surface">Profile</h1>

      <div className="mt-6 flex items-center gap-4">
        <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-secondary-container text-title-l text-on-secondary-container">
          {initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-title-m text-on-surface">{name}</p>
          {profile.email ? (
            <p className="truncate text-body-s text-on-surface-variant">{profile.email}</p>
          ) : null}
          {profile.cityName ? (
            <p className="truncate text-body-s text-on-surface-variant">{profile.cityName}</p>
          ) : null}
        </div>
      </div>

      <section className="mt-8 divide-y divide-outline-variant overflow-hidden rounded-md3-md border border-outline-variant">
        {SETTINGS_ROWS.map((row) =>
          row.href ? (
            <Link
              key={row.label}
              href={row.href}
              className={`${ROW_CLASS} outline-none focus-visible:ring-2 focus-visible:ring-primary`}
            >
              <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
                {row.icon}
              </span>
              <span className="flex-1 text-body-l text-on-surface">{row.label}</span>
              {row.href === "/notifications" ? (
                <NotificationBadge count={unreadNotifications} className="mr-1" />
              ) : null}
              <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
                chevron_right
              </span>
            </Link>
          ) : (
            <div key={row.label} className={ROW_CLASS}>
              <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
                {row.icon}
              </span>
              <span className="flex-1 text-body-l text-on-surface">{row.label}</span>
              <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
                chevron_right
              </span>
            </div>
          ),
        )}
        {/* A form posting to a server action, not a link to /login. A link only
            moved the user to another screen while their session cookies stayed
            valid, so "Log out" did not log anyone out. See signOut() for why
            cookie deletion forces this to be an action. No client island: a
            plain form action keeps this page a server component. */}
        <form action={signOut}>
          <button
            type="submit"
            className={`${ROW_CLASS} w-full text-error outline-none focus-visible:ring-2 focus-visible:ring-primary`}
          >
            <span aria-hidden className="material-symbols-rounded">
              logout
            </span>
            <span className="flex-1 text-left text-body-l">Log out</span>
          </button>
        </form>
      </section>
    </main>
  );
}
