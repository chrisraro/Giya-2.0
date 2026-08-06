import Link from "next/link";
import { redirect } from "next/navigation";

import { EmptyState } from "@/components/consumer/empty-state";
import { DeviceList } from "@/features/identity/components/device-list";
import { DEVICES_LOAD_FAILED } from "@/features/identity/messages";
import { listMyDevices } from "@/features/identity/server/devices";
import { getMyConsumerProfile } from "@/features/identity/server/repo";

// The screen behind /profile's "Devices" row, which pointed at nothing:
// `{ icon: "devices", label: "Devices", href: undefined }` rendered a chevron
// that went nowhere. The file's own comment records that "Notifications" was the
// same kind of dead affordance until a prior slice fixed it; this was the last
// one.
//
// It also gives `public.user_devices` its first reader. The table, its RLS
// policy, its partial index and a receipts foreign key have all existed since
// 0002 and 0017 with zero references anywhere in src/.
//
// THREE OUTCOMES, THREE SCREENS. `listMyDevices` returns a result union rather
// than an array precisely so this file can tell "no devices" from "the query
// failed", and they must never render the same thing: "no devices" reads as
// "nothing is signed in anywhere", which is a claim about somebody's account
// security that a timed-out query has no business making. This codebase has
// shipped that conflation twice already (getMyBalances, the metrics loader).

// Reads the caller's own devices, so it can never be cached across people.
export const dynamic = "force-dynamic";

export default async function ProfileDevicesPage() {
  const profile = await getMyConsumerProfile();
  if (!profile) redirect(`/login?next=${encodeURIComponent("/profile/devices")}`);

  const result = await listMyDevices();

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

      <h1 className="mt-2 text-headline-m text-on-surface">Devices</h1>
      <p className="mt-2 text-body-m text-on-surface-variant">
        The browsers you have signed in to Giya with, and when each one was last used.
      </p>

      {!result.ok ? (
        <p
          role="alert"
          className="mt-6 rounded-md3-md border border-outline-variant bg-surface-container p-4 text-body-m text-on-surface-variant"
        >
          {DEVICES_LOAD_FAILED}
        </p>
      ) : result.devices.length === 0 ? (
        // A real, reachable state and not a failure: a consumer whose session
        // predates this slice has no row yet, and the very next sign-in writes
        // one. The copy says that instead of implying something is wrong.
        <EmptyState
          className="mt-6 border border-outline-variant"
          icon="devices"
          title="No devices yet"
          body="We will list this browser here the next time you sign in."
        />
      ) : (
        <DeviceList devices={result.devices} />
      )}
    </main>
  );
}
