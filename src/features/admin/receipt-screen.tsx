/* eslint-disable @next/next/no-img-element */
import Link from "next/link";

import { cn } from "@/lib/utils";

import { AdminSignalList } from "./evidence";
import { LadderPanel } from "./ladder-panel";
import {
  REJECT_REASON_LABELS,
  compositeFraudScore,
  describeActor,
  describeAuditAction,
  formatApprovalRatio,
  formatDate,
  formatDateTime,
  formatPlatformAmount,
  highestSeverity,
  queueAge,
  severityMeta,
  slaChipClass,
  standingChipClass,
  standingChips,
} from "./presenter";
import type { AdminReceiptDetail } from "./types";

// ===========================================================================
// `/admin/receipts/[receiptId]` - one receipt, cross-tenant, with the ladder.
//
// A SERVER COMPONENT with exactly one client island (`LadderPanel`), which is a
// client component only because a reason has to be typed before anything can be
// submitted.
//
// THIS SCREEN SHOWS EVERYTHING, and that is the deliberate difference from its
// business sibling. The merchant's version withholds the other tenant's
// details, the other consumer's identity and the platform-wide strike count,
// because publishing any of them inside one tenant is a leak. An admin has no
// tenant, so the same evidence renders in full. What has NOT changed is the
// consumer surface: nothing here is reachable by a consumer, and doc 33's copy
// matrix is untouched by this slice.
//
// `no-img-element`: the receipt image is a 5-minute signed URL to a private
// bucket. `next/image` would proxy it through the optimizer and cache a private
// receipt on a public path, which is not a trade worth making for a page one
// operator loads. Same call `evidence.tsx` makes, for the same reason.
// ===========================================================================

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-body-s text-on-surface-variant">{label}</dt>
      <dd className="text-body-m text-on-surface">{value}</dd>
    </div>
  );
}

export interface AdminReceiptScreenProps {
  detail: AdminReceiptDetail;
  /** doc 01's matrix: a `support` admin reads this page and operates none of it. */
  canAct: boolean;
  now: Date;
}

export function AdminReceiptScreen({ detail, canAct, now }: AdminReceiptScreenProps) {
  const age = queueAge(detail.createdAt, now);
  const signals = detail.signals.map((item) => item.signal);
  const topSeverity = highestSeverity(signals);
  const worst = topSeverity === null ? null : severityMeta(topSeverity);
  const composite = compositeFraudScore(signals);
  const chips = standingChips(detail.standing, now);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/admin/fraud"
          className="text-label-l text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          Back to the fraud queue
        </Link>
        <h1 className="text-headline-s text-on-surface">
          {detail.businessName ?? "No business matched"}
        </h1>
        <p className="text-body-s text-on-surface-variant">
          Submitted by {detail.consumerName ?? "a customer"}
          {" · "}
          {formatDateTime(detail.createdAt)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-surface-container-high px-2.5 py-0.5 text-label-m text-on-surface-variant">
          {detail.status}
          {detail.rejectReason === null
            ? ""
            : ` · ${REJECT_REASON_LABELS[detail.rejectReason] ?? detail.rejectReason}`}
        </span>
        {detail.status === "review" && (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m",
              slaChipClass(age.state),
            )}
          >
            {age.label}
          </span>
        )}
        {worst !== null && (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m",
              worst.chipClass,
            )}
          >
            {worst.label}
          </span>
        )}
        <span className="font-mono text-label-m text-on-surface-variant">
          {/* Doc 37's composite, computed by the same function the pipeline
              routed on, so the number here is the number that made this
              decision necessary. */}
          composite {composite.toFixed(2)}
        </span>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <section
            aria-labelledby="parsed"
            className="flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4"
          >
            <h2 id="parsed" className="text-title-m text-on-surface">
              What was read off it
            </h2>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Merchant" value={detail.fields.merchantName ?? "Not read"} />
              <Field label="Receipt number" value={detail.fields.receiptNumber ?? "Not read"} />
              <Field label="Date" value={formatDate(detail.fields.receiptDate)} />
              <Field label="Subtotal" value={formatPlatformAmount(detail.fields.subtotalCentavos)} />
              <Field label="Tax" value={formatPlatformAmount(detail.fields.taxCentavos)} />
              <Field label="Total" value={formatPlatformAmount(detail.fields.totalCentavos)} />
            </dl>
            {detail.lineItems.length > 0 && (
              <ul className="flex flex-col gap-1 border-t border-outline-variant pt-3">
                {detail.lineItems.map((line) => (
                  <li
                    key={line.id}
                    className="flex items-baseline justify-between gap-3 text-body-s"
                  >
                    <span className="min-w-0 truncate text-on-surface">{line.rawText}</span>
                    <span className="shrink-0 font-mono text-on-surface-variant">
                      {formatPlatformAmount(line.lineTotalCentavos)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {detail.rejectNote !== null && (
              <p className="rounded-md3-sm bg-surface-container p-3 text-body-s text-on-surface-variant">
                Reviewer note: {detail.rejectNote}
              </p>
            )}
          </section>

          <section aria-labelledby="evidence" className="flex flex-col gap-3">
            <h2 id="evidence" className="text-title-m text-on-surface">
              Evidence
            </h2>
            <AdminSignalList items={detail.signals} receiptImageUrl={detail.imageUrl} />
          </section>

          <section
            aria-labelledby="history"
            className="flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4"
          >
            <h2 id="history" className="text-title-m text-on-surface">
              Decisions on this receipt
            </h2>
            {detail.history.length === 0 ? (
              <p className="text-body-s text-on-surface-variant">
                Nothing has been decided yet. Every decision from here on is
                recorded with its reason.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detail.history.map((entry) => (
                  <li key={entry.id} className="flex flex-col border-b border-outline-variant pb-2 last:border-b-0">
                    <span className="text-label-l text-on-surface">
                      {describeAuditAction(entry.action)}
                    </span>
                    <span className="text-body-s text-on-surface-variant">
                      {describeActor(entry.actorKind, entry.actorName)}
                      {entry.actorRole === null ? "" : ` (${entry.actorRole})`}
                      {" · "}
                      {formatDateTime(entry.createdAt)}
                    </span>
                    {entry.reason !== null && (
                      <span className="text-body-s text-on-surface">{entry.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-6">
          <section
            aria-labelledby="image"
            className="flex flex-col gap-2 rounded-md3-md border border-outline-variant bg-surface p-4"
          >
            <h2 id="image" className="text-title-m text-on-surface">
              The photo
            </h2>
            {detail.imageUrl === null ? (
              <p className="text-body-s text-on-surface-variant">
                The image could not be signed. It has not been deleted; the link
                simply could not be minted for this request.
              </p>
            ) : (
              <img
                src={detail.imageUrl}
                alt="The submitted receipt"
                className="w-full rounded-md3-sm border border-outline-variant object-contain"
              />
            )}
            <p className="text-body-s text-on-surface-variant">
              This link expires in five minutes.
            </p>
          </section>

          <section
            aria-labelledby="standing"
            className="flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4"
          >
            <h2 id="standing" className="text-title-m text-on-surface">
              This customer, platform-wide
            </h2>
            <p className="text-body-m text-on-surface">
              {formatApprovalRatio(detail.standing)}
            </p>
            <ul className="flex flex-wrap gap-2">
              {chips.map((chip) => (
                <li
                  key={chip.label}
                  className={cn(
                    "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m",
                    standingChipClass(chip.tone),
                  )}
                >
                  {chip.label}
                </li>
              ))}
            </ul>
            <dl className="grid grid-cols-2 gap-3">
              <Field label="Receipts submitted" value={String(detail.standing.receiptsTotal)} />
              <Field label="Signals on record" value={String(detail.standing.priorSignals)} />
              <Field label="Devices" value={String(detail.standing.devices)} />
              <Field label="Businesses" value={String(detail.standing.businesses)} />
            </dl>
            {detail.standing.suspendedReason !== null && (
              <p className="rounded-md3-sm bg-error-container p-3 text-body-s text-on-error-container">
                Suspended: {detail.standing.suspendedReason}
              </p>
            )}
          </section>

          <LadderPanel
            receiptId={detail.receiptId}
            consumerId={detail.consumerId}
            consumerName={detail.consumerName}
            standing={detail.standing}
            clawback={detail.clawback}
            canAct={canAct}
            now={now}
          />
        </div>
      </div>
    </div>
  );
}
