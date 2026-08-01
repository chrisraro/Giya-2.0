import Link from "next/link";

import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import { formatPlatformAmount, queueAge, severityMeta, slaChipClass } from "./presenter";
import type { AdminQueueItem, PlatformOverview } from "./types";

// ===========================================================================
// `/admin` - the platform overview.
//
// A SYNCHRONOUS, PROP-DRIVEN server component. Four numbers and a strip of the
// most recent blocking signals, every one of them a live count over an indexed
// predicate.
//
// ---------------------------------------------------------------------------
// NULL IS NOT ZERO, AND THE DIFFERENCE IS THE POINT OF THIS SCREEN.
// ---------------------------------------------------------------------------
// Every tile takes `number | null`. Null renders as "Cannot read right now",
// never as 0. A platform dashboard reading "0 receipts in review" is a claim
// that the whole platform is clear, and it is the claim an operator will act on
// by closing the tab. A failed count is not entitled to make it. The same
// reasoning `countPendingReview` gives for the business sidebar badge, one
// scale up.
//
// Doc 31 §2 lists ten tiles. Six of them are backed by
// `analytics_daily_business`, which does not exist yet, and they are simply not
// here. A tile computed from a fixture would be worse than a missing tile: it
// looks like information, it survives review, and it is wrong in a direction
// nobody checks.
// ===========================================================================

interface TileProps {
  label: string;
  value: number | null;
  hint: string;
  href: string;
  /** Draws the tile in the error tone when the number is a problem, not just a fact. */
  alarmAbove?: number;
}

function Tile({ label, value, hint, href, alarmAbove }: TileProps) {
  const alarm = alarmAbove !== undefined && value !== null && value > alarmAbove;

  return (
    <Link
      href={href}
      className={cn(
        "flex flex-col gap-1 rounded-md3-md border border-outline-variant bg-surface p-4",
        "outline-none transition-colors duration-200 ease-standard motion-reduce:transition-none",
        "hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary",
        alarm && "border-error",
      )}
    >
      <span className="text-label-m text-on-surface-variant">{label}</span>
      {value === null ? (
        <span className="text-title-m text-on-surface-variant">Cannot read right now</span>
      ) : (
        <span
          className={cn("font-mono text-headline-s", alarm ? "text-error" : "text-on-surface")}
        >
          {value}
        </span>
      )}
      <span className="text-body-s text-on-surface-variant">{hint}</span>
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
          "flex flex-col gap-2 rounded-md3-md border border-outline-variant bg-surface p-4",
          "outline-none transition-colors duration-200 ease-standard motion-reduce:transition-none",
          "hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary",
          "sm:flex-row sm:items-center sm:gap-4",
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-title-m text-on-surface">
            {item.businessName ?? "No business matched"}
          </p>
          <p className="truncate text-body-s text-on-surface-variant">
            {item.consumerName ?? "Customer"}
            {item.receiptNumber === null ? "" : ` · No. ${item.receiptNumber}`}
          </p>
        </div>
        <p className="shrink-0 font-mono text-title-m text-on-surface sm:w-32 sm:text-right">
          {formatPlatformAmount(item.totalCentavos)}
        </p>
        <div className="flex flex-wrap items-center gap-2 sm:w-64 sm:justify-end">
          {severity !== null && (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m",
                severity.chipClass,
              )}
            >
              {severity.label}
              {item.signalCount > 1 ? ` · ${item.signalCount}` : ""}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m",
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
}

export function OverviewScreen({ overview, adminName, now }: OverviewScreenProps) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-headline-s text-on-surface">Overview</h1>
        <p className="text-body-s text-on-surface-variant">
          What needs a person today, {adminName}.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/*
          This tile counted `status='pending_verification'` from the day the
          overview shipped and pointed at `/admin/receipts`, because there was
          no queue to point at: nothing in the product could put a business into
          that status and nothing could take it out. Migration 0033 made both
          possible, so the tile now links to the queue it was always counting.
          `alarmAbove={0}` because any number here is a merchant who cannot
          trade.
        */}
        <Tile
          label="Awaiting review"
          value={overview.businessesAwaitingVerification}
          hint="Businesses that asked to go live and cannot trade until someone decides"
          href="/admin/businesses"
          alarmAbove={0}
        />
        <Tile
          label="Receipts in review"
          value={overview.receiptsInReview}
          hint="Across every business. Their own staff see them first."
          href="/admin/receipts?filter=review"
        />
        <Tile
          label="Blocked in the last 7 days"
          value={overview.fraudBlocks7d}
          hint="Receipts a detector stopped outright"
          href="/admin/fraud?filter=blocked"
          alarmAbove={20}
        />
        <Tile
          label="No business matched"
          value={overview.unmatchedReceipts}
          hint="Nobody but this portal can see these"
          href="/admin/receipts?filter=unmatched"
          alarmAbove={0}
        />
      </div>

      <section aria-labelledby="recent-blocks" className="flex flex-col gap-3">
        <h2 id="recent-blocks" className="text-title-m text-on-surface">
          Most recently blocked
        </h2>
        {overview.recentBlocks.length === 0 ? (
          <EmptyState
            icon="verified_user"
            title="Nothing was blocked recently"
            body="A blocking signal is a deterministic one: a byte-identical image, a live duplicate receipt number, a near-identical photo. None have fired in the last week."
            className="border border-outline-variant bg-surface"
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
