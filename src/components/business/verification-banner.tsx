"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * What the banner is allowed to claim, per status.
 *
 * `draft` used to render "Your documents are under review", which was false on
 * both halves. `register_business` (0003_auth_plumbing.sql) creates every
 * business as `draft`, nothing in this codebase moves it off `draft`, and the
 * only document affordance that exists is the onboarding wizard's step 3,
 * which holds the picked files in React state and uploads nothing (see the
 * `TODO(api): replace mock` in src/app/(business)/business/onboarding/page.tsx).
 * `business_documents` and `business_verifications` are both empty in
 * consequence. So a merchant reading that banner was told their submission was
 * being processed when they had never made one and no reviewer existed.
 *
 * The fix is copy, not a KYC pipeline: `draft` now says what is actually true,
 * which is that verification has not started and nothing has been submitted.
 *
 * `pending_verification` keeps the review copy, and it stays honest, because
 * per docs/30-modules/32-business-portal.md section 2.2 that status is only
 * reachable from the verification submission that writes the
 * `business_verifications` row and links the uploaded `business_documents`.
 * When that flow ships, this branch is already correct and needs no edit.
 */
const MESSAGES: Record<string, string> = {
  draft:
    "Your business is not verified yet. Document submission is not open in this release, so nothing has been submitted and nothing is under review. Set up your store and draft your campaigns in the meantime.",
  pending_verification: "Your documents are under review. You can explore while you wait.",
};

/**
 * Informational banner shown while a business's verification status is
 * `draft` or `pending_verification`. `status` is fetched server-side (the
 * dashboard page reads the caller's first active business_staff membership)
 * and passed down as a prop. Dismiss is still a client-only stub: it just
 * hides the banner for the current session.
 * TODO(api): persist dismissal instead of resetting it on every reload
 */
export function VerificationBanner({
  status,
  className,
}: {
  status: string | null;
  className?: string;
}) {
  const [dismissed, setDismissed] = React.useState(false);
  const message = status ? MESSAGES[status] : undefined;
  if (dismissed || !message) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-md3-md bg-secondary-container px-4 py-3 text-on-secondary-container",
        className,
      )}
    >
      <span aria-hidden className="material-symbols-rounded shrink-0 text-[20px]">
        info
      </span>
      <p className="flex-1 text-body-m">{message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full outline-none",
          "transition-colors duration-200 ease-standard hover:bg-on-secondary-container/10",
          "focus-visible:ring-2 focus-visible:ring-secondary",
        )}
      >
        <span aria-hidden className="material-symbols-rounded text-[18px]">
          close
        </span>
      </button>
    </div>
  );
}
