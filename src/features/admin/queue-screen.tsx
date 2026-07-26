import Link from "next/link";

import { EmptyState } from "@/components/consumer/empty-state";
import { cn } from "@/lib/utils";

import {
  ADMIN_FRAUD_TABS,
  ADMIN_RECEIPT_TABS,
  REJECT_REASON_LABELS,
  formatPlatformAmount,
  queueAge,
  severityMeta,
  slaChipClass,
} from "./presenter";
import type { AdminFraudFilter, AdminQueueItem, AdminReceiptFilter } from "./types";

// ===========================================================================
// `/admin/fraud` and `/admin/receipts` - the two platform-wide queues.
//
// One component, two routes, because they are the same list with different
// WHERE clauses and a different empty state. Splitting them would mean two
// copies of the row, and the row is where a cross-tenant leak would look like a
// styling choice.
//
// SYNCHRONOUS AND PROP-DRIVEN, no client state. The tabs are links, so the
// filter is a server-side query rather than a client-side filter over rows the
// browser should never have been sent. That matters more here than anywhere
// else in the app: every row on this page comes from a service-role read with
// no tenancy predicate at all, so the less of it that crosses to the client the
// smaller the surface.
//
// Desktop-first per doc 31, and unlike the business queue that is taken
// literally: an admin works this list on a laptop, so the row is a table-ish
// grid at width and stacks only on a narrow screen.
// ===========================================================================

const FRAUD_EMPTY: Record<AdminFraudFilter, { title: string; body: string }> = {
  open: {
    title: "Nothing is waiting on a person",
    body: "Receipts reach this queue when a detector was unsure or a business let one sit. An empty queue means every scan resolved on its own or in a merchant's own review.",
  },
  blocked: {
    title: "Nothing has been blocked",
    body: "Only deterministic facts block outright: a byte-identical image, a live duplicate receipt number, a near-identical photo. Everything else routes to a human.",
  },
  all: {
    title: "No receipt has been flagged",
    body: "Detectors write a signal row even on receipts that end up approved, so an empty list here means no detector has fired at all.",
  },
};

const RECEIPT_EMPTY: Record<AdminReceiptFilter, { title: string; body: string }> = {
  review: {
    title: "No receipts are in review",
    body: "Every business has cleared its own queue and the pipeline routed nothing to a person.",
  },
  unmatched: {
    title: "Every receipt has a business",
    body: "A receipt with no business is invisible to every merchant on the platform, so this list should stay empty. If it does not, merchant matching is letting receipts through it should have rejected.",
  },
  recent: {
    title: "Nothing has been decided yet",
    body: "Approvals and rejections show up here with who made them.",
  },
};

function TabLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
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
      {label}
    </Link>
  );
}

function QueueRow({ item, now }: { item: AdminQueueItem; now: Date }) {
  const age = queueAge(item.createdAt, now);
  const severity = item.topSeverity === null ? null : severityMeta(item.topSeverity);
  const pending = item.status === "review";

  return (
    <li>
      <Link
        href={`/admin/receipts/${item.receiptId}`}
        className={cn(
          "flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4",
          "outline-none transition-colors duration-200 ease-standard motion-reduce:transition-none",
          "hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary",
          "lg:flex-row lg:items-center lg:gap-4",
        )}
      >
        <div className="min-w-0 lg:flex-1">
          <p className="truncate text-title-m text-on-surface">
            {item.businessName ?? "No business matched"}
          </p>
          <p className="truncate text-body-s text-on-surface-variant">
            {item.merchantName ?? "Merchant not read"}
            {item.receiptNumber === null ? "" : ` · No. ${item.receiptNumber}`}
          </p>
        </div>

        <p className="min-w-0 truncate text-body-s text-on-surface-variant lg:w-48">
          {item.consumerName ?? "Customer"}
        </p>

        <p className="shrink-0 font-mono text-title-m text-on-surface lg:w-32 lg:text-right">
          {formatPlatformAmount(item.totalCentavos)}
        </p>

        <div className="flex flex-wrap items-center gap-2 lg:w-80 lg:justify-end">
          {item.staffSelfScan && (
            <span className="inline-flex items-center rounded-full bg-error-container px-2.5 py-0.5 text-label-m text-on-error-container">
              Staff scanned their own
            </span>
          )}
          {item.businessId === null && (
            <span className="inline-flex items-center rounded-full border border-outline px-2.5 py-0.5 text-label-m text-on-surface-variant">
              Unmatched
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
              {item.rejectReason === null
                ? item.status
                : (REJECT_REASON_LABELS[item.rejectReason] ?? item.status)}
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

export interface AdminQueueScreenProps {
  title: string;
  subtitle: string;
  /** Which route this is; decides the tab set and the empty copy. */
  kind: "fraud" | "receipts";
  filter: AdminFraudFilter | AdminReceiptFilter;
  items: readonly AdminQueueItem[];
  now: Date;
  /**
   * The list could not be read. "No items" would be a lie, so the empty state
   * is suppressed in favour of an explicit alert.
   */
  unavailable?: boolean;
}

export function AdminQueueScreen({
  title,
  subtitle,
  kind,
  filter,
  items,
  now,
  unavailable = false,
}: AdminQueueScreenProps) {
  const tabs = kind === "fraud" ? ADMIN_FRAUD_TABS : ADMIN_RECEIPT_TABS;
  const basePath = kind === "fraud" ? "/admin/fraud" : "/admin/receipts";
  const empty =
    kind === "fraud"
      ? FRAUD_EMPTY[filter as AdminFraudFilter]
      : RECEIPT_EMPTY[filter as AdminReceiptFilter];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-headline-s text-on-surface">{title}</h1>
        <p className="text-body-s text-on-surface-variant">{subtitle}</p>
      </div>

      <nav aria-label={`${title} filters`} className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <TabLink
            key={tab.value}
            href={`${basePath}?filter=${tab.value}`}
            label={tab.label}
            active={tab.value === filter}
          />
        ))}
      </nav>

      {unavailable ? (
        <div
          role="alert"
          className="rounded-md3-md border border-outline bg-surface-container p-4 text-body-m text-on-surface"
        >
          This queue cannot be loaded right now, so nothing below is complete.
          Do not read an empty list as an empty platform. Try again shortly.
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={kind === "fraud" ? "gpp_good" : "receipt_long"}
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
