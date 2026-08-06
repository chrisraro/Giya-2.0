import type { ReactNode } from "react";

import { formatDateTime } from "./presenter";
import { FlagTogglePanel } from "./flags-panel";
import type { FeatureFlagItem } from "./types";

// ===========================================================================
// `/admin/flags` (doc 31 section 7).
//
// A SYNCHRONOUS, PROP-DRIVEN server component with one client island per
// flag row (`FlagTogglePanel`, a client component only because a reason has
// to be typed before anything can be submitted) - same shape as
// `queue-status-screen.tsx`.
//
// NULL IS NOT EMPTY, this portal's rule everywhere (see
// `queue-status-screen.tsx`'s own header for the incident this guards
// against): an empty flag list is a claim that the registry itself is empty,
// and a failed read is not entitled to make it.
//
// Admin surfaces are utilitarian (doc 16, Locked): maximum density, zero
// expressive motion - no `animation:` anywhere in this file.
// ===========================================================================

function UnavailableNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-md3-md border border-outline bg-surface-container p-4 text-body-m text-on-surface"
    >
      {children}
    </div>
  );
}

function FlagRow({ item, canAct }: { item: FeatureFlagItem; canAct: boolean }) {
  return (
    <li className="flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-label-l text-on-surface">{item.key}</p>
        <p className="text-body-m text-on-surface-variant">{item.description}</p>
        <p className="text-body-s text-on-surface-variant">
          Last changed {formatDateTime(item.updatedAt)}
        </p>
      </div>
      <div className="shrink-0">
        <FlagTogglePanel flagKey={item.key} isEnabled={item.isEnabled} canAct={canAct} />
      </div>
    </li>
  );
}

export interface FlagsScreenProps {
  /** Null means the read failed - NOT "the registry is empty". See the
   * module header. */
  flags: readonly FeatureFlagItem[] | null;
  /** doc 31 section 1: `/admin/flags` is super_admin only. `admin` and
   * `support` sessions see this screen read-only. */
  canAct: boolean;
}

export function FlagsScreen({ flags, canAct }: FlagsScreenProps) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-headline-s text-on-surface">Feature flags</h1>
        <p className="text-body-s text-on-surface-variant">
          Doc 38&apos;s AI kill switches and every other platform flag. Turning
          one off takes effect within 30 seconds everywhere it is checked (the
          gateway&apos;s cache TTL) - a bad model day is a toggle, not a
          deploy.
        </p>
        {!canAct && (
          <p
            role="note"
            className="mt-2 rounded-md3-sm border border-outline bg-surface-container p-3 text-body-s text-on-surface"
          >
            Your account is read-only. Only a super admin can change a flag.
          </p>
        )}
      </div>

      {flags === null ? (
        <UnavailableNotice>
          The flag registry could not be read right now. Do not read this as
          &quot;there are no flags&quot; - try again shortly.
        </UnavailableNotice>
      ) : flags.length === 0 ? (
        <p className="rounded-md3-md border border-outline-variant bg-surface p-4 text-body-m text-on-surface-variant">
          No flags are registered.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {flags.map((item) => (
            <FlagRow key={item.key} item={item} canAct={canAct} />
          ))}
        </ul>
      )}
    </div>
  );
}
