import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/business/kpi-card";
import { BarChart } from "@/components/business/bar-chart";
import { VerificationBanner } from "@/components/business/verification-banner";
import { EmptyState } from "@/components/consumer/empty-state";
import { resolveReviewerContext } from "@/features/receipts/review/access";
import { countPendingReview, PENDING_COUNT_CAP } from "@/features/receipts/review/queue";
import { MOCK_KPIS, MOCK_WEEK_VISITS, MOCK_ACTIVITY } from "@/lib/mock/business"; // TODO(api): replace mock
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

const FULL_DAY_NAMES: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};

function busiestDayLabel(data: { day: string; value: number }[]) {
  const first = data[0];
  if (!first) return "Visits per day this week";
  const busiest = data.reduce((max, current) => (current.value > max.value ? current : max), first);
  const fullName = FULL_DAY_NAMES[busiest.day] ?? busiest.day;
  return `Visits per day this week, highest ${fullName}`;
}

// The banner needs the caller's business verification status, which only
// the server client can read safely (RLS-scoped to the signed-in user).
// This page is already a server component, so it fetches directly here
// instead of threading the value through (portal)/layout.tsx: that layout
// renders PortalShell, a client component, and `children` there is already
// the resolved page element by the time the layout runs, so there is no
// clean prop-injection point above this page for a single-route value.
async function getBusinessStatus(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("business_staff")
    .select("business_id")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return null;

  const { data: business } = await supabase
    .from("businesses")
    .select("status")
    .eq("id", membership.business_id)
    .maybeSingle();

  return business?.status ?? null;
}

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

export default async function BusinessDashboardPage() {
  const businessStatus = await getBusinessStatus();

  // Memoized per request alongside the portal layout's own call, so the tile
  // costs one indexed count and no extra session round trip.
  const reviewer = await resolveReviewerContext();
  const pendingReviewCount =
    reviewer === null ? null : await countPendingReview(reviewer.businessId);

  return (
    <div className="flex flex-col gap-6">
      <VerificationBanner status={businessStatus} />

      {pendingReviewCount !== null && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ReviewQueueTile pending={pendingReviewCount} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {MOCK_KPIS.map((kpi) => (
          <KpiCard key={kpi.label} kpi={kpi} />
        ))}
      </div>

      <Card variant="outlined">
        <CardHeader>
          <CardTitle>Visits this week</CardTitle>
        </CardHeader>
        <CardContent>
          <BarChart data={MOCK_WEEK_VISITS} ariaLabel={busiestDayLabel(MOCK_WEEK_VISITS)} />
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {MOCK_ACTIVITY.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {MOCK_ACTIVITY.map((item) => (
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
    </div>
  );
}
