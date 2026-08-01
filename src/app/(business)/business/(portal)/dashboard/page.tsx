import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/business/kpi-card";
import { BarChart } from "@/components/business/bar-chart";
import { VerificationBanner } from "@/components/business/verification-banner";
import { EmptyState } from "@/components/consumer/empty-state";
import { loadBusinessDashboard } from "@/features/analytics/server/dashboard";
import {
  activationBannerCopy,
  buildActivationChecklist,
  formatSubmittedOn,
  sentBackReason,
} from "@/features/businesses/activation/presenter";
import { loadActivationFacts } from "@/features/businesses/activation/server/state";
import { GoLiveCard } from "@/features/businesses/activation/components/go-live-card";
import { resolvePortalContext } from "@/features/businesses/server/portal-context";
import { getBaseRule } from "@/features/campaigns/server/repo";
import { RoutingBreakdownPanel } from "@/features/receipts/components/routing-breakdown-panel";
import { resolveReviewerContext } from "@/features/receipts/review/access";
import { countPendingReview, PENDING_COUNT_CAP } from "@/features/receipts/review/queue";
import { loadRoutingBreakdown } from "@/features/receipts/server/routing-stats";
import { cn } from "@/lib/utils";

/**
 * The review-queue tile (doc 32 section 3: "Receipts approved vs rejected ...
 * click -> /business/receipts"; doc 36 Stage 9: "queue-age surfaced on the
 * business dashboard").
 *
 * Rendered only for owners and managers, because they are the only roles that
 * can act on it, and it changes shape rather than colour when the queue is
 * empty: a dashboard that shows a red zero every day teaches people that the
 * red means nothing.
 */
function ReviewQueueTile({ pending }: { pending: number }) {
  const waiting = pending > 0;
  return (
    <Link
      href="/business/receipts"
      className={cn(
        "flex flex-col gap-1 rounded-md3-md p-4 outline-none",
        "transition-colors duration-200 ease-standard motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-primary",
        waiting
          ? "bg-error-container text-on-error-container hover:opacity-90"
          : "border border-outline-variant bg-surface-container-low text-on-surface hover:bg-surface-container",
      )}
    >
      <span className="text-body-s">Receipts to review</span>
      <span className="font-mono text-headline-s">
        {pending > PENDING_COUNT_CAP ? `${PENDING_COUNT_CAP}+` : pending}
      </span>
      <span className="text-body-s">
        {waiting ? "Aim to clear these within a day" : "Nothing waiting on you"}
      </span>
    </Link>
  );
}

/**
 * The business dashboard.
 *
 * Every figure below comes from this tenant's own rows. There are no fixtures
 * left on this page, and that is the point: the numbers a merchant sees on day
 * one are their real zeros, a chart of seven real empty days, and a feed that
 * says nothing has happened yet. A dashboard that invents "128 visits, +12% vs
 * last week" for an empty database is not a placeholder, it is a false report
 * about somebody's business.
 *
 * The tenant is resolved once per request by `resolvePortalContext`, which
 * delegates to the shared `resolveOwnerBusiness` (the caller's first ACTIVE
 * `business_staff` row, read under their own session). Nothing on this page
 * accepts a business id from the URL or from a prop.
 */
export default async function BusinessDashboardPage() {
  const portal = await resolvePortalContext();

  // Memoized per request alongside the portal layout's own call, so the tile
  // costs one indexed count and no extra session round trip.
  //
  // Null hides the tile, and it now covers two cases: a role that cannot review
  // receipts, and a count that could not be read. Both hide it for the same
  // reason: the tile's zero state says "Nothing waiting on you", which is a
  // claim about the queue, and a failed read cannot make it. The queue screen
  // is the surface that explains the failure; a dashboard tile is not.
  const reviewer = await resolveReviewerContext();
  const pendingReviewCount =
    reviewer === null ? null : await countPendingReview(reviewer.businessId);

  // ---------------------------------------------------------------------
  // D10: the review RATE, next to the review QUEUE.
  //
  // WHY THE DASHBOARD AND NOT /business/receipts. The queue answers "what do I
  // have to do right now" and is a working list; this answers "is this product
  // working for me at all", which is a question about a period and belongs
  // where the merchant already reads periods. Putting it on the queue page
  // would also show it only to someone who already went looking, and the whole
  // point is that a merchant drowning in manual approvals should not have to go
  // looking to find that out. It sits directly under the queue tile so the
  // count and the rate read as one thought: "12 waiting, and 31% of everything
  // needs me".
  //
  // TENANCY: `reviewer.businessId` comes from `resolveReviewerContext()`, the
  // same source the queue tile uses, and it is the ONLY fence on a service-role
  // read (see ../../../../../features/receipts/server/routing-stats.ts). The
  // panel is gated on the same reviewer context for the same reason the tile
  // is: owners and managers are the only roles that can act on any of it, and
  // a marketing seat being shown their shop's review rate is a number they can
  // neither change nor interpret.
  // ---------------------------------------------------------------------
  const routing =
    reviewer === null ? null : await loadRoutingBreakdown({ businessId: reviewer.businessId });

  // Null means a read ERRORED, not that the merchant has no data. Zeros are a
  // legitimate answer and are rendered as zeros; an unproven number is not
  // rendered at all.
  const dashboard = portal === null ? null : await loadBusinessDashboard(portal.business.id);

  // ---------------------------------------------------------------------
  // ACTIVATION. This is the top of the acquisition funnel and it used to be a
  // silent dead end: `businesses.status` defaults to 'draft', every consumer
  // read filters `status='active'`, and nothing in the product moved a business
  // between the two. The card below is how a merchant learns that and what to
  // do about it; the banner is the one-sentence version of the same facts.
  //
  // Both are suppressed for an active business, and both are suppressed when
  // the facts could not be READ - a checklist assembled from a failed query
  // would either tell a merchant to redo work they have done or tell them they
  // are ready when they are not.
  // ---------------------------------------------------------------------
  const activation = portal === null ? null : await loadActivationFacts(portal.business.id);
  const checklist = activation === null ? null : buildActivationChecklist(activation);
  // Only fetched when the embedded editor will actually render, so a live
  // merchant's dashboard costs nothing extra.
  const baseRule =
    activation !== null && activation.status === "draft" && !activation.hasEarningRule
      ? await getBaseRule(activation.businessId)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <VerificationBanner copy={activation === null ? null : activationBannerCopy(activation)} />

      {activation !== null && checklist !== null && activation.status !== "active" && (
        <GoLiveCard
          status={activation.status}
          checklist={checklist}
          sentBackReason={sentBackReason(activation.latestRound)}
          baseRule={baseRule}
          submittedLabel={formatSubmittedOn(activation.latestRound?.createdAt ?? null)}
        />
      )}

      {pendingReviewCount !== null && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ReviewQueueTile pending={pendingReviewCount} />
        </div>
      )}

      {reviewer !== null && <RoutingBreakdownPanel breakdown={routing} scope="your shop" />}

      {dashboard === null ? (
        <Card variant="outlined">
          <CardContent className="py-8">
            <EmptyState
              icon="cloud_off"
              title="Your numbers are not available right now"
              body="We could not read this week's activity. Nothing is wrong with your data; try again in a moment."
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {dashboard.kpis.map((kpi) => (
              <KpiCard key={kpi.label} kpi={kpi} />
            ))}
          </div>

          <Card variant="outlined">
            <CardHeader>
              <CardTitle>Visits per day</CardTitle>
            </CardHeader>
            <CardContent>
              <BarChart data={dashboard.visitsByDay} ariaLabel={dashboard.visitsChartLabel} />
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
            </CardHeader>
            <CardContent>
              {dashboard.activity.length > 0 ? (
                <ul className="flex flex-col gap-3">
                  {dashboard.activity.map((item) => (
                    <li key={item.id} className="flex items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary-container text-on-secondary-container">
                        <span aria-hidden className="material-symbols-rounded text-[18px]">
                          {item.icon}
                        </span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body-m text-on-surface">
                        {item.text}
                      </span>
                      <span className="shrink-0 text-body-s text-on-surface-variant">
                        {item.timeLabel}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  icon="receipt_long"
                  title="No activity yet"
                  body="Customer scans and redemptions will show up here as they happen."
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
