import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/consumer/empty-state";
import { StaggerItem } from "@/components/motion/stagger";
import { formatPeso } from "@/lib/money";
import { cn } from "@/lib/utils";

import type { ReceiptListItemDTO, ReceiptStatus } from "../types";
import { receiptStatusLabel, receiptTone } from "./receipt-copy";

// The scan history list (doc 33 route inventory: `/receipts`, auth, MVP,
// "Scan history list ... status chips filter ... Empty: 'Scan your first
// receipt' CTA").
//
// A plain server component with no client JavaScript at all: the status
// filter is expressed as links that set `?status=`, so the filter survives
// refresh, back-button and sharing, and the page stays inside doc 33's
// "RSC-first, islands only" rule. The live-updating island is the wallet
// entry, not this list, because a history list does not need to move under
// the reader's eyes.
//
// Every field rendered here comes from a column 0017 actually grants. There
// is no path through this component that can render reject_note, parse_meta
// or a confidence score: none of them exist on ReceiptListItemDTO.

const STATUS_ICON: Record<ReceiptStatus, string> = {
  queued: "hourglass_empty",
  processing: "autorenew",
  review: "hourglass_top",
  approved: "check_circle",
  rejected: "info",
};

/** The chips, in pipeline order. `null` is the unfiltered view. */
export const RECEIPT_FILTERS: readonly { value: ReceiptStatus | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "processing", label: "Processing" },
  { value: "review", label: "In review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Not accepted" },
];

const CHIP_BASE =
  "inline-flex h-8 shrink-0 items-center rounded-full px-4 text-label-l transition-colors duration-200 ease-standard outline-none focus-visible:ring-2 focus-visible:ring-primary";

function filterHref(status: ReceiptStatus | null): string {
  return status ? `/receipts?status=${status}` : "/receipts";
}

function formatSubmittedAt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * The display name for a receipt row. Prefers the matched business (the thing
 * the consumer chose) over the OCR'd merchant line (the thing the parser
 * read), and falls back to a neutral label rather than an empty row while the
 * receipt is still being matched.
 */
export function receiptTitle(receipt: ReceiptListItemDTO): string {
  return receipt.businessName ?? receipt.merchantName ?? "Receipt";
}

export interface ReceiptHistoryListProps {
  receipts: readonly ReceiptListItemDTO[];
  activeStatus: ReceiptStatus | null;
}

export function ReceiptHistoryList({ receipts, activeStatus }: ReceiptHistoryListProps) {
  return (
    <div>
      <nav
        aria-label="Filter receipts by status"
        className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
      >
        {RECEIPT_FILTERS.map((filter) => {
          const selected = filter.value === activeStatus;
          return (
            <Link
              key={filter.label}
              href={filterHref(filter.value)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                CHIP_BASE,
                selected
                  ? "bg-secondary-container text-on-secondary-container"
                  : "border border-outline text-on-surface-variant hover:bg-surface-container",
              )}
            >
              {filter.label}
            </Link>
          );
        })}
      </nav>

      {receipts.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon="receipt_long"
          title={activeStatus ? "Nothing here yet" : "No receipts yet"}
          body={
            activeStatus
              ? "No receipts of yours are in this state right now."
              : "Scan a receipt from a shop you visited and your points will land in your wallet."
          }
          // A filtered empty view offers no CTA on purpose: "scan your first
          // receipt" is a lie to somebody who has twelve of them and simply
          // has none in review.
          {...(activeStatus ? {} : { action: { label: "Scan your first receipt", href: "/scan" } })}
        />
      ) : (
        // Rows enter on the MD3 emphasized-decelerate curve, staggered by
        // position. Pure CSS (see globals.css): no client JavaScript, plays on
        // first paint, and the keyframes exist only inside a
        // `prefers-reduced-motion: no-preference` block, so a consumer who
        // asked for less motion gets the settled list with no animation.
        <ul className="mt-4 space-y-1">
          {receipts.map((receipt, index) => (
            <li key={receipt.receiptId}>
              <StaggerItem index={index}>
                <ReceiptHistoryRow receipt={receipt} />
              </StaggerItem>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReceiptHistoryRow({ receipt }: { receipt: ReceiptListItemDTO }) {
  const tone = receiptTone(receipt.status);
  const isPending = tone === "neutral";

  return (
    <Link
      href={`/scan/${receipt.receiptId}`}
      className="flex items-center gap-3 rounded-md3-md px-2 py-3 transition-colors duration-200 ease-standard hover:bg-surface-container outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-full",
          tone === "reward"
            ? "bg-tertiary-container text-on-tertiary-container"
            : "bg-surface-container-high text-on-surface-variant",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "material-symbols-rounded text-[20px]",
            tone === "reward" && "is-filled",
            isPending && "motion-safe:animate-pulse",
          )}
        >
          {STATUS_ICON[receipt.status]}
        </span>
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-body-l text-on-surface">{receiptTitle(receipt)}</p>
        <p className="truncate text-body-s text-on-surface-variant">
          {receiptStatusLabel(receipt.status, receipt.rejectReason)} ·{" "}
          {formatSubmittedAt(receipt.createdAt)}
        </p>
      </div>

      <div className="shrink-0 text-right">
        {/* Mango is reward language (doc 16), so the points badge is the only
            tertiary surface in this list, and it appears only once points
            genuinely exist in the ledger. A pending receipt shows its total
            instead, or nothing at all before parse: doc 36 is explicit that
            no points amount is promised before award. */}
        {receipt.pointsAwarded !== null ? (
          <Badge>+{receipt.pointsAwarded.toLocaleString()} pts</Badge>
        ) : receipt.totalCentavos !== null ? (
          <span className="font-mono text-label-m text-on-surface-variant">
            {formatPeso(receipt.totalCentavos)}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
