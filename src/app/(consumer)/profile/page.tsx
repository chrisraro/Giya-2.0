import Link from "next/link";
import { MOCK_USER } from "@/lib/mock/consumer"; // TODO(api): replace mock

const SETTINGS_ROWS = [
  { icon: "notifications", label: "Notifications", href: undefined },
  { icon: "devices", label: "Devices", href: undefined },
  { icon: "privacy_tip", label: "Privacy policy", href: "/privacy" },
  { icon: "description", label: "Terms", href: "/terms" },
] as const;

export default function ProfilePage() {
  // TODO(api): replace mock — fetch signed-in profile from the API
  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <h1 className="text-headline-m text-on-surface">Profile</h1>

      <div className="mt-6 flex items-center gap-4">
        <span className="flex size-16 shrink-0 items-center justify-center rounded-full bg-secondary-container text-title-l text-on-secondary-container">
          {MOCK_USER.initials}
        </span>
        <div className="min-w-0">
          <p className="truncate text-title-m text-on-surface">{MOCK_USER.name}</p>
          <p className="text-body-s text-on-surface-variant">{MOCK_USER.city}</p>
        </div>
      </div>

      <section className="mt-8 divide-y divide-outline-variant overflow-hidden rounded-md3-md border border-outline-variant">
        {SETTINGS_ROWS.map((row) =>
          row.href ? (
            <Link
              key={row.label}
              href={row.href}
              className="flex items-center gap-3 px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
                {row.icon}
              </span>
              <span className="flex-1 text-body-l text-on-surface">{row.label}</span>
              <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
                chevron_right
              </span>
            </Link>
          ) : (
            <div key={row.label} className="flex items-center gap-3 px-4 py-4">
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
        {/* TODO(auth): wire Supabase sign-out */}
        <Link
          href="/login"
          className="flex items-center gap-3 px-4 py-4 text-error outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span aria-hidden className="material-symbols-rounded">
            logout
          </span>
          <span className="flex-1 text-body-l">Log out</span>
        </Link>
      </section>
    </main>
  );
}
