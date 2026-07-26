/* eslint-disable @next/next/no-img-element */
import { cn } from "@/lib/utils";

import { describeSignal, formatAmount, formatDate, severityMeta } from "./presenter";
import type { AdminSignalItem } from "./types";

// ===========================================================================
// Doc 37's evidence display contract, admin edition.
//
// The renderer is `describeSignal`, imported from the business review
// presenter through this feature's own presenter. Nothing here re-words a
// signal: the sentence an admin reads about an `image_hash_dup` is byte for
// byte the sentence the merchant read, which is what makes an escalation
// conversation possible.
//
// What this component adds is the half doc 37 asks for that a tenant-scoped
// screen cannot show:
//
//   * "side-by-side image comparison for dup matches (both receipts via 5-min
//     signed URLs)". The business version links the matched receipt instead and
//     says why in its own comment: a pHash neighbour can belong to another
//     merchant and there is no URL that merchant is entitled to. An admin is
//     entitled to both, so both are rendered, side by side, which is the only
//     arrangement in which "these are the same photo" is a judgement a human
//     can actually make rather than a number to trust.
//   * the OTHER TENANT and the OTHER ACCOUNT, named. Doc 37 S1: "A 0-4 match
//     where matched_consumer_id <> consumer_id is simultaneously ring
//     evidence." The business queue is forbidden from resolving that; here it
//     is the finding.
//
// Note the `no-img-element` disable at the top. `next/image` would proxy these
// through the optimizer, and these are 5-minute signed URLs to a private
// bucket: the optimizer would cache a URL that expires, and caching anything
// derived from a private receipt image on a public CDN path is not a trade
// worth making for a page one operator loads. Plain `img`, no caching, expires
// with the URL.
// ===========================================================================

function ReceiptImage({ url, caption }: { url: string | null; caption: string }) {
  return (
    <figure className="flex min-w-0 flex-1 flex-col gap-2">
      <figcaption className="text-label-m text-on-surface-variant">{caption}</figcaption>
      {url === null ? (
        <div className="flex h-48 items-center justify-center rounded-md3-sm border border-outline-variant bg-surface-container text-body-s text-on-surface-variant">
          Image unavailable
        </div>
      ) : (
        <img
          src={url}
          alt={caption}
          className="h-48 w-full rounded-md3-sm border border-outline-variant object-contain"
        />
      )}
    </figure>
  );
}

function CrossTenantRow({ item }: { item: AdminSignalItem }) {
  const matched = item.signal.matchedReceipt;
  if (matched === null) {
    if (!item.signal.matchedReceiptOutsideTenant) return null;
    return (
      <p className="rounded-md3-sm border border-outline-variant p-3 text-body-s text-on-surface-variant">
        The evidence names an earlier receipt that no longer resolves. The signal
        stands; the receipt it matched has been removed from the reference set.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md3-sm border border-outline-variant p-3">
      <p className="text-label-m text-on-surface-variant">The receipt it matched</p>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 text-body-m text-on-surface">
          {item.matchedBusinessName ?? "No business matched"}
          {" · "}
          {item.matchedConsumerName ?? "Unknown customer"}
        </span>
        <span className="font-mono text-label-l text-on-surface">
          {formatAmount(matched.totalCentavos)}
        </span>
      </div>
      <p className="text-body-s text-on-surface-variant">
        {matched.receiptNumber === null ? "No number read" : `No. ${matched.receiptNumber}`}
        {" · "}
        {formatDate(matched.receiptDate ?? matched.createdAt)}
        {" · "}
        {matched.status}
      </p>
    </div>
  );
}

export function AdminSignalCard({
  item,
  receiptImageUrl,
}: {
  item: AdminSignalItem;
  /** This receipt's own image, so a dup signal can show both halves. */
  receiptImageUrl: string | null;
}) {
  const meta = severityMeta(item.signal.severity);
  const view = describeSignal(item.signal);
  const showComparison = item.matchedImageUrl !== null;

  return (
    <li className="flex flex-col gap-3 rounded-md3-md border border-outline-variant bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-label-m",
            meta.chipClass,
          )}
        >
          {meta.label}
        </span>
        <span className="text-title-m text-on-surface">{view.title}</span>
        {item.businessName !== null && (
          <span className="inline-flex items-center rounded-full bg-surface-container-high px-2.5 py-0.5 text-label-m text-on-surface-variant">
            {item.businessName}
          </span>
        )}
        <span className="ml-auto font-mono text-label-m text-on-surface-variant">
          {/* Doc 37's score and weight, so the composite in the header is
              arithmetic an admin can check rather than a number to trust. */}
          score {item.signal.score.toFixed(2)} x {meta.weight.toFixed(1)}
        </span>
      </div>

      <p className="text-body-m text-on-surface">{view.summary}</p>

      {view.meter !== null && (
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-body-s text-on-surface-variant">Scans {view.meter.label}</span>
            <span className="font-mono text-label-l text-on-surface">
              {view.meter.count} of {view.meter.cap} allowed
            </span>
          </div>
          <div
            role="meter"
            aria-valuenow={view.meter.count}
            aria-valuemin={0}
            aria-valuemax={Math.max(view.meter.cap, view.meter.count)}
            aria-label={`${view.meter.count} scans ${view.meter.label} against an allowance of ${view.meter.cap}`}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-container-highest"
          >
            <div className="flex h-full w-full">
              <div
                className="h-full bg-secondary"
                style={{
                  width: `${
                    (view.meter.cap <= 0 ? 1 : Math.min(1, view.meter.count / view.meter.cap)) * 100
                  }%`,
                }}
              />
              {view.meter.count > view.meter.cap && <div className="h-full flex-1 bg-error" />}
            </div>
          </div>
        </div>
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

      <CrossTenantRow item={item} />

      {showComparison && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <ReceiptImage url={receiptImageUrl} caption="This receipt" />
          <ReceiptImage url={item.matchedImageUrl} caption="The receipt it matched" />
        </div>
      )}
    </li>
  );
}

export function AdminSignalList({
  items,
  receiptImageUrl,
}: {
  items: readonly AdminSignalItem[];
  receiptImageUrl: string | null;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-md3-md border border-outline-variant bg-surface p-4 text-body-m text-on-surface-variant">
        No detector flagged this receipt. It is on this queue because of its
        state, not because of a signal.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <AdminSignalCard key={item.signal.id} item={item} receiptImageUrl={receiptImageUrl} />
      ))}
    </ul>
  );
}
