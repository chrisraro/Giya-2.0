import Link from "next/link";

import { EmptyState } from "@/components/consumer/empty-state";
import { RoutingBreakdownPanel } from "@/features/receipts/components/routing-breakdown-panel";
import type { RoutingBreakdown } from "@/features/receipts/routing-breakdown";
import { cn } from "@/lib/utils";

import { formatPlatformAmount, queueAge, severityMeta, slaChipClass } from "./presenter";
import type { AdminQueueItem, PlatformOverview } from "./types";

interface TileProps {
  label: string;
  value: number | null;
  hint: string;
  href: string;
  icon: string;
  alarmAbove?: number;
}

function Tile({ label, value, hint, href, icon, alarmAbove }: TileProps) {
  const alarm = alarmAbove !== undefined && value !== null && value > alarmAbove;

  return (
    <Link
      href={href}
      className={cn(
        "flex flex-col justify-between gap-3 rounded-md3-md border border-outline-variant bg-surface-container-lowest p-5 shadow-xs",
        "outline-none transition-all duration-200 ease-standard motion-reduce:transition-none",
        "hover:border-primary/50 hover:bg-surface-container-low hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary",
        alarm && "border-error/60 bg-error-container/10 hover:border-error",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-label-l font-semibold text-on-surface-variant">{label}</span>
        <span
          className={cn(
            "flex size-9 items-center justify-center rounded-lg",
            alarm ? "bg-error-container text-on-error-container" : "bg-primary-container/40 text-primary",
          )}
        >
          <span className="material-symbols-rounded text-[20px]">{icon}</span>
        </span>
      </div>

      <div>
        {value === null ? (
          <span className="text-title-m text-on-surface-variant">Cannot read right now</span>
        ) : (
          <span className={cn("font-mono text-headline-m font-bold", alarm ? "text-error" : "text-on-surface")}>
            {value}
          </span>
        )}
        <p className="mt-1 text-body-s text-on-surface-variant">{hint}</p>
      </div>
    </Link>
  );
}

function RecentBlockRow({ item, now }: { item: AdminQueueItem; now: Date }) {
  const age = queueAge(item.createdAt, now);
  const severity = item.topSeverity === null ? null : severityMeta(item.topSeverity);

  return (
    <li>
      <Link
        href={`/admin/receipts/${item.receiptId}`}
        className={cn(
          "flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface-container-lowest p-4 shadow-2xs",
          "outline-none transition-all duration-200 ease-standard motion-reduce:transition-none",
          "hover:border-primary/40 hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary",
          "sm:flex-row sm:items-center sm:gap-4",
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-title-m font-semibold text-on-surface">
            {item.businessName ?? "No business matched"}
          </p>
          <p className="truncate text-body-s text-on-surface-variant">
            {item.consumerName ?? "Customer"}
            {item.receiptNumber === null ? "" : ` · No. ${item.receiptNumber}`}
          </p>
        </div>
        <p className="shrink-0 font-mono text-title-m font-bold text-on-surface sm:w-32 sm:text-right">
          {formatPlatformAmount(item.totalCentavos)}
        </p>
        <div className="flex flex-wrap items-center gap-2 sm:w-64 sm:justify-end">
          {severity !== null && (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m font-medium",
                severity.chipClass,
              )}
            >
              {severity.label}
              {item.signalCount > 1 ? ` · ${item.signalCount}` : ""}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m font-medium",
              slaChipClass(age.state),
            )}
          >
            {age.label}
          </span>
        </div>
      </Link>
    </li>
  );
}

export interface OverviewScreenProps {
  overview: PlatformOverview;
  adminName: string;
  now: Date;
  routing: RoutingBreakdown | null;
}

export function OverviewScreen({
  overview,
  adminName,
  now,
  routing,
}: OverviewScreenProps) {
  return (
    <div className="flex flex-col gap-8">
      {/* Top Banner Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-headline-m font-bold text-on-surface">ERP Executive Dashboard</h1>
          <p className="text-body-m text-on-surface-variant">
            Platform operations summary and priority action queues for {adminName}.
          </p>
        </div>

        <div className="mt-3 flex items-center gap-2 sm:mt-0">
          <Link
            href="/admin/businesses"
            className="flex items-center gap-2 rounded-md3-xs bg-primary px-4 py-2 text-label-l font-medium text-on-primary shadow-xs transition-opacity hover:opacity-90"
          >
            <span className="material-symbols-rounded text-[18px]">verified_user</span>
            <span>Review Merchants</span>
          </Link>
        </div>
      </div>

      {/* Primary ERP KPI Scorecard */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile
          label="Awaiting Verification"
          value={overview.businessesAwaitingVerification}
          hint="Merchants pending admin go-live decision"
          href="/admin/businesses"
          icon="storefront"
          alarmAbove={0}
        />
        <Tile
          label="Receipts in Queue"
          value={overview.receiptsInReview}
          hint="Platform receipts flagged for human review"
          href="/admin/receipts?filter=review"
          icon="receipt_long"
        />
        <Tile
          label="7-Day Fraud Blocks"
          value={overview.fraudBlocks7d}
          hint="Automated duplicate and risk detections"
          href="/admin/fraud?filter=blocked"
          icon="shield_with_heart"
          alarmAbove={20}
        />
        <Tile
          label="Unmatched Receipts"
          value={overview.unmatchedReceipts}
          hint="Receipts requiring manual merchant matching"
          href="/admin/receipts?filter=unmatched"
          icon="manage_search"
          alarmAbove={0}
        />
      </div>

      {/* Quick Access ERP Shortcuts */}
      <div className="rounded-md3-md border border-outline-variant bg-surface-container-lowest p-5 shadow-xs">
        <h2 className="text-title-m font-bold text-on-surface mb-3 flex items-center gap-2">
          <span className="material-symbols-rounded text-[20px] text-primary">apps</span>
          <span>ERP Quick Navigation</span>
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Link
            href="/admin/businesses"
            className="flex flex-col items-center gap-2 rounded-md3-xs border border-outline-variant bg-surface p-3 text-center transition-colors hover:bg-surface-container"
          >
            <span className="material-symbols-rounded text-[24px] text-primary">storefront</span>
            <span className="text-label-m font-medium text-on-surface">Businesses</span>
          </Link>
          <Link
            href="/admin/consumers"
            className="flex flex-col items-center gap-2 rounded-md3-xs border border-outline-variant bg-surface p-3 text-center transition-colors hover:bg-surface-container"
          >
            <span className="material-symbols-rounded text-[24px] text-primary">group</span>
            <span className="text-label-m font-medium text-on-surface">Consumers</span>
          </Link>
          <Link
            href="/admin/receipts"
            className="flex flex-col items-center gap-2 rounded-md3-xs border border-outline-variant bg-surface p-3 text-center transition-colors hover:bg-surface-container"
          >
            <span className="material-symbols-rounded text-[24px] text-primary">receipt</span>
            <span className="text-label-m font-medium text-on-surface">Receipts</span>
          </Link>
          <Link
            href="/admin/fraud"
            className="flex flex-col items-center gap-2 rounded-md3-xs border border-outline-variant bg-surface p-3 text-center transition-colors hover:bg-surface-container"
          >
            <span className="material-symbols-rounded text-[24px] text-primary">gavel</span>
            <span className="text-label-m font-medium text-on-surface">Fraud Engine</span>
          </Link>
          <Link
            href="/admin/audit"
            className="flex flex-col items-center gap-2 rounded-md3-xs border border-outline-variant bg-surface p-3 text-center transition-colors hover:bg-surface-container"
          >
            <span className="material-symbols-rounded text-[24px] text-primary">history</span>
            <span className="text-label-m font-medium text-on-surface">Audit Logs</span>
          </Link>
          <Link
            href="/admin/admins"
            className="flex flex-col items-center gap-2 rounded-md3-xs border border-outline-variant bg-surface p-3 text-center transition-colors hover:bg-surface-container"
          >
            <span className="material-symbols-rounded text-[24px] text-primary">admin_panel_settings</span>
            <span className="text-label-m font-medium text-on-surface">Admin Roster</span>
          </Link>
        </div>
      </div>

      {/* Policy & Review Breakdown */}
      <RoutingBreakdownPanel breakdown={routing} scope="the platform" />

      {/* Live Recent Blocks Feed */}
      <section aria-labelledby="recent-blocks" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 id="recent-blocks" className="text-title-l font-bold text-on-surface flex items-center gap-2">
            <span className="material-symbols-rounded text-[22px] text-error">notification_important</span>
            <span>Most Recently Blocked Activity</span>
          </h2>
          <Link href="/admin/fraud" className="text-label-l font-semibold text-primary hover:underline">
            View All Fraud Signals →
          </Link>
        </div>

        {overview.recentBlocks.length === 0 ? (
          <EmptyState
            icon="verified_user"
            title="Nothing was blocked recently"
            body="A blocking signal is a deterministic one: a byte-identical image, a live duplicate receipt number, a near-identical photo. None have fired in the last week."
            className="border border-outline-variant bg-surface-container-lowest"
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {overview.recentBlocks.map((item) => (
              <RecentBlockRow key={item.receiptId} item={item} now={now} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
