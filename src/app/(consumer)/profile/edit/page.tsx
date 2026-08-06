import Link from "next/link";
import { redirect } from "next/navigation";

import { ProfileEditForm } from "@/features/identity/components/profile-edit-form";
import { getMyConsumerProfile } from "@/features/identity/server/repo";

// /profile has been read-only since it was built: it renders the display name,
// email and city and offers no way to change any of them. This is the screen
// that changes them.
//
// A server component that reads and hands plain data to one client island, the
// same shape /profile itself has. Nothing but strings crosses the boundary - see
// src/app/rsc-boundary.test.ts for why that matters here specifically.

// Reads the caller's own profile, so it can never be cached across people.
export const dynamic = "force-dynamic";

export default async function ProfileEditPage() {
  // Same gate as /profile, for the same reason, and pointed back HERE so a
  // signed-out person who followed a link to their own edit screen lands on it
  // after signing in rather than somewhere else.
  const profile = await getMyConsumerProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/profile/edit")}`);

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      {/* The route back. A screen that can only be left by the browser's own
          back button is a screen somebody can get stuck on inside a PWA shell. */}
      <Link
        href="/profile"
        className="-ml-2 inline-flex h-12 items-center gap-1 rounded-md3-sm px-2 text-label-l text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span aria-hidden className="material-symbols-rounded">
          arrow_back
        </span>
        Profile
      </Link>

      <h1 className="mt-2 text-headline-m text-on-surface">Edit profile</h1>

      <ProfileEditForm
        displayName={profile.displayName}
        cityName={profile.cityName}
        avatarUrl={profile.avatarUrl}
      />
    </main>
  );
}
