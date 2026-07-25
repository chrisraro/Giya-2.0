import Link from "next/link";

import { cn } from "@/lib/utils";

import { describeSignal, formatAmount, formatDate, severityMeta } from "./presenter";
import type { FraudSignalView } from "./types";

// ===========================================================================
// Doc 37's "evidence display contract per item", rendered.
//
// "Signal rows with severity, score, and rendered evidence - side-by-side
// image comparison for dup matches, distance readout for GPS, count/cap bars
// for velocity. Linked receipts (matched_receipt_id chains)."
//
// The word doing the work is RENDERED. Nothing here prints jsonb at a
// reviewer: `describeSignal` turns each evidence shape into a sentence plus
// labelled rows, velocity gets its count-versus-cap bar, duplicates get their
// distance readout and a link to the matched receipt, and any key the catalog
// grows later still lands as a labelled row rather than disappearing.
//
// The one place this deliberately shows less than the doc asks for: the
// side-by-side image comparison for a duplicate. The matched receipt is linked
// rather than rendered inline, because a second image needs a second signed
// URL and the matched receipt may belong to another tenant entirely, in which
// case there is no URL this business is entitled to. See `queue.ts`'s
// `loadSignalsForReceipt` for how that case is detected.
// ===========================================================================

function EvidenceMeterBar({ label, count, cap }: { label: string; count: number; cap: number }) {
  const ratio = cap <= 0 ? 1 : Math.min(1, count / cap);
  const overBy = Math.max(0, count - cap);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-body-s text-on-surface-variant">Scans {label}</span>
        <span className="font-mono text-label-l text-on-surface">
          {count} of {cap} allowed
        </span>
      </div>
      <div
        role="meter"
        aria-valuenow={count}
        aria-valuemin={0}
        aria-valuemax={Math.max(cap, count)}
        aria-label={`${count} scans ${label} against an allowance of ${cap}`}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-container-highest"
      >
        {/* The allowance, filled to the cap, with the overshoot drawn past it
            in the error tone so "how far over" is legible at a glance. */}
        <div className="flex h-full w-full">
          <div className="h-full bg-secondary" style={{ width: `${ratio * 100}%` }} />
          {overBy > 0 && (
            <div
              className="h-full bg-error"
              style={{ width: `${Math.min(100 - ratio * 100, (overBy / Math.max(cap, 1)) * 100)}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MatchedReceiptCard({ signal }: { signal: FraudSignalView }) {
  if (signal.matchedReceipt !== null) {
    const matched = signal.matchedReceipt;
    return (
      <Link
        href={`/business/receipts/${matched.receiptId}`}
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 rounded-md3-sm border border-outline-variant p-3",
          "outline-none transition-colors duration-200 ease-standard motion-reduce:transition-none",
          "hover:bg-surface-container focus-visible:ring-2 focus-visible:ring-primary",
        )}
      >
        <span className="min-w-0">
          <span className="block truncate text-label-l text-on-surface">
            {matched.merchantName ?? "The matching receipt"}
          </span>
          <span className="block truncate text-body-s text-on-surface-variant">
            {matched.receiptNumber === null ? "No number read" : `No. ${matched.receiptNumber}`}
            {" · "}
            {formatDate(matched.receiptDate ?? matched.createdAt)}
            {" · "}
            {matched.status}
          </span>
        </span>
        <span className="font-mono text-label-l text-on-surface">
          {formatAmount(matched.totalCentavos)}
        </span>
      </Link>
    );
  }

  if (signal.matchedReceiptOutsideTenant) {
    return (
      <p className="rounded-md3-sm border border-outline-variant p-3 text-body-s text-on-surface-variant">
        The matching receipt was scanned at a different business, so its details
        are not shown here.
      </p>
    );
  }

  return null;
}

export function FraudSignalCard({ signal }: { signal: FraudSignalView }) {
  const meta = severityMeta(signal.severity);
  const view = describeSignal(signal);

  return (
    <li className="flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m", meta.chipClass)}>
          {meta.label}
        </span>
        <span className="text-title-m text-on-surface">{view.title}</span>
        <span className="ml-auto font-mono text-label-m text-on-surface-variant">
          {/* Doc 37's score and weight, so the composite on the header is
              arithmetic the reviewer can check rather than a number to trust. */}
          score {signal.score.toFixed(2)} x {meta.weight.toFixed(1)}
        </span>
      </div>

      <p className="text-body-m text-on-surface">{view.summary}</p>

      {view.meter !== null && (
        <EvidenceMeterBar label={view.meter.label} count={view.meter.count} cap={view.meter.cap} />
      )}

      {view.rows.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
          {view.rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-body-s text-on-surface-variant">{row.label}</dt>
              <dd className="text-body-s text-on-surface">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <MatchedReceiptCard signal={signal} />
    </li>
  );
}

export function FraudSignalList({ signals }: { signals: readonly FraudSignalView[] }) {
  if (signals.length === 0) {
    return (
      <p className="rounded-md3-md border border-outline-variant bg-surface p-4 text-body-m text-on-surface-variant">
        No detector flagged this receipt. It is here because the reader was not
        confident enough to decide on its own.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {signals.map((signal) => (
        <FraudSignalCard key={signal.id} signal={signal} />
      ))}
    </ul>
  );
}
