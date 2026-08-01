import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import {
  REVIEW_RATE_ATTENTION,
  formatShare,
  needsLoosening,
} from "../routing-breakdown";
import type { RoutingBreakdown } from "../routing-breakdown";

// ===========================================================================
// D10's panel, rendered identically for both audiences.
//
// ---------------------------------------------------------------------------
// ONE COMPONENT, TWO PORTALS, AND THAT IS DELIBERATE.
// ---------------------------------------------------------------------------
// The merchant asks "is this product working for me?" and the admin asks
// "should I loosen a dial?", but they are reading the SAME number and the whole
// value of it is that they read the same number. Two components would drift -
// different denominators, different windows, different rounding - and the first
// support conversation where the merchant's 31% is the admin's 27% would burn
// more trust than the panel ever bought. The only difference between the two
// callers is the `scope` word in the caption and which id they passed to
// `loadRoutingBreakdown`.
//
// PRESENTATIONAL ONLY. No IO, no session, no `server-only`: it takes a folded
// breakdown or null and renders. That is what lets both portals hold their own
// (different) authorization fences and hand the result to the same component.
//
// NULL IS NOT ZERO, the house rule. A read that failed renders as "Cannot read
// right now"; only a read that succeeded may claim a rate. See
// ../server/routing-stats.ts.
// ===========================================================================

export interface RoutingBreakdownPanelProps {
  /** Null when the read failed. Never render null as a healthy 0%. */
  breakdown: RoutingBreakdown | null;
  /** "your shop" or "the platform". Used in the caption only. */
  scope: string;
  className?: string;
}

/** A bar with no chart library: one div, one width, both themes. */
function ShareBar({ share, muted }: { share: number; muted: boolean }) {
  const percent = Math.min(100, Math.max(0, Math.round(share * 100)));
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-surface-container-highest"
      aria-hidden="true"
    >
      <div
        className={cn("h-full rounded-full", muted ? "bg-outline" : "bg-secondary")}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function RoutingBreakdownPanel({
  breakdown,
  scope,
  className,
}: RoutingBreakdownPanelProps) {
  if (breakdown === null) {
    return (
      <Card variant="outlined" className={className}>
        <CardHeader>
          <CardTitle>How much of this runs on its own</CardTitle>
        </CardHeader>
        <CardContent>
          <p>Cannot read right now. Refresh in a moment.</p>
        </CardContent>
      </Card>
    );
  }

  const { counts, reviewRate, approvalRate, windowDays, total } = breakdown;
  const attention = needsLoosening(breakdown);

  return (
    <Card variant="outlined" className={className}>
      <CardHeader>
        <CardTitle>How much of this runs on its own</CardTitle>
        <p className="text-body-s text-on-surface-variant">
          Receipts scanned at {scope} over the last {windowDays} days.
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {total === 0 ? (
          // An honest empty state rather than a wall of 0%. A merchant who has
          // not opened yet must not be shown a rate, and an operator must not
          // be able to mistake "no receipts" for "nothing needed a human".
          <p>No receipts have been scanned in this window yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col gap-1">
                <p className="text-body-s text-on-surface-variant">Went through on its own</p>
                <p className="font-mono text-headline-s text-on-surface">
                  {formatShare(approvalRate)}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-body-s text-on-surface-variant">Needed a person</p>
                <p
                  className={cn(
                    "font-mono text-headline-s",
                    // The one place a colour carries meaning: past D10's
                    // attention line the number is the problem, not context.
                    attention ? "text-error" : "text-on-surface",
                  )}
                >
                  {formatShare(reviewRate)}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-body-s text-on-surface-variant">Not accepted</p>
                <p className="font-mono text-headline-s text-on-surface">
                  {formatShare(breakdown.rejectionRate)}
                </p>
              </div>
            </div>

            {attention ? (
              <p className="rounded-md3-md bg-error-container p-3 text-body-s text-on-error-container">
                More than {formatShare(REVIEW_RATE_ATTENTION)} of settled receipts needed a
                person. The rules below are what asked for one.
              </p>
            ) : null}

            <div className="flex flex-col gap-3">
              <p className="text-label-m text-on-surface-variant">
                Why a person was asked to look
              </p>

              {counts.review === 0 ? (
                <p className="text-body-s text-on-surface-variant">
                  Nothing needed a person in this window.
                </p>
              ) : breakdown.reasons.length === 0 ? (
                <p className="text-body-s text-on-surface-variant">
                  No reason was recorded for the receipts that needed a person.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {breakdown.reasons.map((reason) => (
                    <li key={reason.key} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span
                          className={cn(
                            "text-body-s",
                            // The backfill bucket is deliberately quieter: it
                            // is not a rule anyone can tune, and giving it the
                            // same weight as a real reason would invite someone
                            // to act on it.
                            reason.unattributed
                              ? "text-on-surface-variant"
                              : "text-on-surface",
                          )}
                        >
                          {reason.label}
                        </span>
                        <span className="shrink-0 font-mono text-body-s text-on-surface-variant">
                          {reason.count} ({formatShare(reason.shareOfReviewed)})
                        </span>
                      </div>
                      <ShareBar share={reason.shareOfReviewed} muted={reason.unattributed} />
                    </li>
                  ))}
                </ul>
              )}

              {/* Stated rather than implied. A reader who assumes these are
                  slices of a pie will conclude the wrong thing about which
                  rule to touch, and the honest sentence costs one line. */}
              <p className="text-body-s text-on-surface-variant">
                A receipt can trip more than one rule, so these add up to more than the
                receipts that needed a person.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
