"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * One honest sentence about where this business stands with Giya.
 *
 * ---------------------------------------------------------------------------
 * THIS COMPONENT HAS NOW BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS.
 * ---------------------------------------------------------------------------
 * It shipped with a `status -> copy` table whose `draft` entry read "Your
 * documents are under review". That was false on both halves: nothing in the
 * codebase moved a business off `draft`, the onboarding wizard uploaded
 * nothing, and `business_documents` and `business_verifications` were both
 * empty, so a merchant was told their submission was being processed when they
 * had never made one and no reviewer existed. It was corrected to say that
 * document submission was not open in this release.
 *
 * That correction is now false in the other direction: submission IS open
 * (`public.submit_business_for_review`, migration 0033), there IS a reviewer
 * (the admin queue at /admin/businesses), and a `draft` merchant has something
 * specific to do about it.
 *
 * The fix, both times, is the same one: this component must not own the
 * sentence. It is a presentational strip. The sentence is computed by
 * `activationBannerCopy` in
 * `src/features/businesses/activation/presenter.ts`, from facts read this
 * request, and a status this component cannot interpret produces no banner
 * rather than a guess. There is no copy table here to go stale.
 *
 * `copy` of null renders nothing, which is the normal state of an active
 * business: a merchant who is live does not need a strip telling them so on
 * every page load, and a banner that never goes away is a banner nobody reads.
 *
 * Dismiss remains client-only and resets on reload. That is deliberate for as
 * long as the strip carries a status rather than an announcement: the
 * undismissible go-live checklist below it is what a merchant must not be able
 * to hide from themselves.
 * TODO(api): persist dismissal instead of resetting it on every reload
 */
export interface VerificationBannerCopy {
  tone: "info" | "warning";
  message: string;
}

export function VerificationBanner({
  copy,
  className,
}: {
  copy: VerificationBannerCopy | null;
  className?: string;
}) {
  const [dismissed, setDismissed] = React.useState(false);
  if (dismissed || copy === null) return null;

  const warning = copy.tone === "warning";

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-md3-md px-4 py-3",
        warning
          ? "bg-error-container text-on-error-container"
          : "bg-secondary-container text-on-secondary-container",
        className,
      )}
    >
      <span aria-hidden className="material-symbols-rounded shrink-0 text-[20px]">
        {warning ? "error" : "info"}
      </span>
      <p className="flex-1 text-body-m">{copy.message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full outline-none",
          "transition-colors duration-200 ease-standard",
          warning
            ? "hover:bg-on-error-container/10 focus-visible:ring-2 focus-visible:ring-error"
            : "hover:bg-on-secondary-container/10 focus-visible:ring-2 focus-visible:ring-secondary",
        )}
      >
        <span aria-hidden className="material-symbols-rounded text-[18px]">
          close
        </span>
      </button>
    </div>
  );
}
