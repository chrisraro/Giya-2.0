"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const VISIBLE_STATUSES = new Set(["draft", "pending_verification"]);

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
  if (dismissed || !status || !VISIBLE_STATUSES.has(status)) return null;

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
      <p className="flex-1 text-body-m">
        Your documents are under review. You can explore while you wait.
      </p>
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
