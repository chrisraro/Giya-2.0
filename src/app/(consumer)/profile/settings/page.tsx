import Link from "next/link";
import { redirect } from "next/navigation";

import { ConsentSettings } from "@/features/identity/components/consent-settings";
import { CONSENTS_LOAD_FAILED } from "@/features/identity/messages";
import { getMyConsents, getMyConsumerProfile } from "@/features/identity/server/repo";

// The screen 0021 has been waiting for.
//
// `public.consumers` has carried marketing_opt_in, push_enabled, email_enabled
// and gps_fraud_opt_in since 0002, and 0021_consumer_selfupdate_column_fence.sql
// granted `authenticated` UPDATE on all four with a header that states the
// reason - "the profile settings screen edits them". That screen did not exist.
// Four consents nobody could see, let alone withdraw.
//
// A server component that reads and hands plain booleans to one client island,
// the same shape /profile and /profile/edit have. Nothing but data crosses the
// boundary; see src/app/rsc-boundary.test.ts for why that matters here.
//
// THE FAILED-READ BRANCH IS THE POINT OF THIS FILE'S STRUCTURE. There is no
// `?? { ...all false }` anywhere: getMyConsents returns a failure rather than a
// default, and a failure renders a message instead of the form. Four un-ticked
// switches would tell somebody their consents are all off - and the natural
// next tap would write that over what the database actually holds.

// Reads the caller's own consents, so it can never be cached across people.
export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  // Same gate as /profile and /profile/edit, pointed back HERE so somebody who
  // followed a link to their own preferences lands on them after signing in.
  const profile = await getMyConsumerProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/profile/settings")}`);

  const result = await getMyConsents();

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-8">
      <Link
        href="/profile"
        className="-ml-2 inline-flex h-12 items-center gap-1 rounded-md3-sm px-2 text-label-l text-on-surface-variant outline-none transition-colors duration-200 ease-standard hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary"
      >
        <span aria-hidden className="material-symbols-rounded">
          arrow_back
        </span>
        Profile
      </Link>

      <h1 className="mt-2 text-headline-m text-on-surface">Preferences</h1>
      <p className="mt-2 text-body-m text-on-surface-variant">
        Each of these is a separate choice and each one saves on its own. You can change any of them
        whenever you like.
      </p>

      {result.ok ? (
        <ConsentSettings consents={result.consents} />
      ) : (
        <p
          role="alert"
          className="mt-6 rounded-md3-md border border-outline-variant bg-surface-container p-4 text-body-m text-on-surface-variant"
        >
          {CONSENTS_LOAD_FAILED}
        </p>
      )}
    </main>
  );
}
