import Link from "next/link";

import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import {
  PENDING_COUNT_CAP,
  QUEUE_TABS,
  REJECT_REASON_LABELS,
  formatAmount,
  formatDate,
  formatDateTime,
  queueAge,
  severityMeta,
  slaChipClass,
} from "./presenter";
import type { ReviewQueueItem, ReviewQueueStatus } from "./types";

// ===========================================================================
// `/business/receipts` - the review queue.
//
// A SYNCHRONOUS, PROP-DRIVEN component with no client state. The tabs are
// links, so the filter is a server-side query (`queue.ts` applies it as a
// WHERE clause) rather than a client-side array filter over rows the browser
// should never have been sent. That matters more here than on the campaigns
// screen: every row on this page comes from a service-role read, so the less
// of it that crosses to the client, the smaller the surface.
//
// Desktop-first per doc 32, but the layout is a list of cards rather than a
// table, because owners live on phones and a six-column table on a 390px
// viewport is a horizontal scrollbar with extra steps.
// ===========================================================================

export interface ReviewQueueScreenProps {
  businessName: string;
  status: ReviewQueueStatus;
  items: readonly ReviewQueueItem[];
  pendingCount: number;
  /** Injected so the rendered queue age is deterministic. */
  now: Date;
  /** The service-role client is unavailable, so "no items" would be a lie. */
  unavailable?: boolean;
}

// The `review` copy is the one that matters. An empty review queue is the
// STEADY STATE, not a failure to have data, so it reads like the good news it
// is: the pipeline auto-approved everything it could and nothing looked odd.
const EMPTY_COPY: Record<ReviewQueueStatus, { title: string; body: string }> = {
  review: {
    title: "Nothing waiting on you",
    body: "Receipts only land here when the reader is unsure or something looks unusual. An empty queue means every scan went through on its own.",
  },
  approved: {
    title: "No approvals yet",
    body: "Receipts you approve from the queue show up here with the total that points were computed from.",
  },
  rejected: {
    title: "No rejections yet",
    body: "Receipts you reject show up here with the reason you chose.",
  },
};

function TabLink({ tab, active }: { tab: (typeof QUEUE_TABS)[number]; active: boolean }) {
  return (
    <Link
      href={`/business/receipts?status=${tab.value}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-9 items-center rounded-full px-4 text-label-l",
        "outline-none transition-colors duration-200 ease-standard motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-primary",
        active
          ? "bg-secondary-container text-on-secondary-container"
          : "border border-outline bg-transparent text-on-surface-variant hover:bg-surface-container",
      )}
    >
      {tab.label}
    </Link>
  );
}

function QueueRow({ item, now }: { item: ReviewQueueItem; now: Date }) {
  const age = queueAge(item.createdAt, now);
  const severity = item.topSeverity === null ? null : severityMeta(item.topSeverity);
  const pending = item.status === "review";

  return (
    <li>
      <Link
        href={`/business/receipts/${item.receiptId}`}
        className={cn(
          "flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4",
          "outline-none transition-colors duration-200 ease-standard motion-reduce:transition-none",
          "hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary",
          "sm:flex-row sm:items-center sm:gap-4",
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-title-m text-on-surface">
            {item.merchantName ?? "Merchant not read"}
          </p>
          <p className="truncate text-body-s text-on-surface-variant">
            {item.consumerName ?? "Customer"}
            {item.receiptNumber === null ? "" : ` · No. ${item.receiptNumber}`}
            {item.receiptDate === null ? "" : ` · ${formatDate(item.receiptDate)}`}
          </p>
        </div>

        <p className="shrink-0 font-mono text-title-m text-on-surface sm:w-32 sm:text-right">
          {formatAmount(item.totalCentavos)}
        </p>

        <div className="flex flex-wrap items-center gap-2 sm:w-72 sm:justify-end">
          {item.submittedByViewer && (
            <span className="inline-flex items-center rounded-full border border-outline px-2.5 py-0.5 text-label-m text-on-surface-variant">
              You submitted this
            </span>
          )}

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

          {pending ? (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m",
                slaChipClass(age.state),
              )}
            >
              {age.label}
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-surface-container-high px-2.5 py-0.5 text-label-m text-on-surface-variant">
              {item.status === "rejected" && item.rejectReason !== null
                ? (REJECT_REASON_LABELS[item.rejectReason] ?? "Rejected")
                : formatDateTime(item.reviewedAt)}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

export function ReviewQueueScreen({
  businessName,
  status,
  items,
  pendingCount,
  now,
  unavailable = false,
}: ReviewQueueScreenProps) {
  const empty = EMPTY_COPY[status];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-headline-s text-on-surface">Receipts</h1>
          <p className="text-body-s text-on-surface-variant">
            Scans from {businessName} that need a person to look at them
          </p>
        </div>
        <p className="text-body-s text-on-surface-variant">
          {pendingCount === 0
            ? "Nothing waiting"
            : `${pendingCount} waiting${pendingCount > PENDING_COUNT_CAP ? " or more" : ""}`}
        </p>
      </div>

      <nav aria-label="Receipt status" className="flex flex-wrap gap-2">
        {QUEUE_TABS.map((tab) => (
          <TabLink key={tab.value} tab={tab} active={tab.value === status} />
        ))}
      </nav>

      {status === "review" && items.length > 0 && (
        <p className="text-body-s text-on-surface-variant">
          Oldest first. Aim to clear each one within a day of it arriving.
        </p>
      )}

      {unavailable ? (
        <div
          role="alert"
          className="rounded-md3-md border border-outline bg-surface-container p-4 text-body-m text-on-surface"
        >
          The review queue cannot be loaded right now, so this list may be
          incomplete. Try again shortly.
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="receipt_long"
          title={empty.title}
          body={empty.body}
          className="border border-outline-variant bg-surface"
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <QueueRow key={item.receiptId} item={item} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
