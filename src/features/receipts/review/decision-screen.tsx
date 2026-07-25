"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatPeso, pesoToCentavos } from "@/lib/money";
import { cn } from "@/lib/utils";

import { FraudSignalList } from "./evidence";
import {
  FRAUD_FAMILY_REASONS,
  REJECT_REASON_LABELS,
  REJECT_REASON_ORDER,
  compositeFraudScore,
  fieldChip,
  formatConfidence,
  formatDateTime,
  queueAge,
  slaChipClass,
  toneChipClass,
} from "./presenter";
import type { ReviewDecisionItem, ReviewLineItemView } from "./types";
import type { ReviewActionResult } from "./actions";

// ===========================================================================
// `/business/receipts/[receiptId]` - the decision screen.
//
// Doc 36 Stage 9's UI contract and doc 37's evidence display contract, side by
// side: the image, the editable field form pre-filled with what the parser
// found and carrying per-field source and confidence chips, and the fraud
// signal list with its evidence rendered.
//
// THREE THINGS ON THIS SCREEN ARE NOT DECORATION.
//
// 1. SELF-REVIEW IS BLOCKED UP FRONT. `reviewReceipt` guard 4 refuses a
//    decision by the submitter (doc 37 S9), and it refuses it AFTER the
//    reviewer has retyped six fields. So the screen detects the case on
//    render, explains it in plain language, and does not offer the actions at
//    all. The explanation is deliberately not accusatory: the overwhelmingly
//    common case is a manager who genuinely bought something at their own
//    store, and the rule exists to protect them as much as anyone.
//
// 2. TWO MANAGERS CAN RACE. `reviewReceipt` folds `status = 'review'` into the
//    WHERE clause of its decision write, so the loser gets
//    RECEIPT_NOT_REVIEWABLE. That is not an error, it is news: someone else
//    got there first. It renders as such, with a refresh, never as a red box.
//
// 3. APPROVING IS A MONEY ACTION. It mints points through the same path
//    auto-approval uses, so it goes through a confirmation that states the
//    total the points will be computed from. A reviewer who mistyped a total
//    should see the number one more time before it becomes a ledger row.
// ===========================================================================

export type ReviewDecisionAction = (input: unknown) => Promise<ReviewActionResult>;

export interface ReviewDecisionScreenProps {
  item: ReviewDecisionItem;
  businessName: string;
  /** Injected so queue age renders identically on the server and the client. */
  now: Date;
  onApprove: ReviewDecisionAction;
  onReject: ReviewDecisionAction;
}

// ---------------------------------------------------------------------------
// Field form state
// ---------------------------------------------------------------------------

interface FieldState {
  merchantName: string;
  receiptNumber: string;
  receiptDate: string;
  subtotal: string;
  tax: string;
  total: string;
}

interface LineItemState {
  key: string;
  rawText: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
}

function toDateInput(iso: string | null): string {
  if (iso === null) return "";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function toPesoInput(centavos: number | null): string {
  return centavos === null ? "" : formatPeso(centavos, { symbol: false });
}

function initialFields(item: ReviewDecisionItem): FieldState {
  return {
    merchantName: item.fields.merchantName ?? "",
    receiptNumber: item.fields.receiptNumber ?? "",
    receiptDate: toDateInput(item.fields.receiptDate),
    subtotal: toPesoInput(item.fields.subtotalCentavos),
    tax: toPesoInput(item.fields.taxCentavos),
    total: toPesoInput(item.fields.totalCentavos),
  };
}

function initialLineItems(items: readonly ReviewLineItemView[]): LineItemState[] {
  return items.map((item) => ({
    key: item.id,
    rawText: item.rawText,
    qty: item.qty === null ? "" : String(item.qty),
    unitPrice: toPesoInput(item.unitPriceCentavos),
    lineTotal: toPesoInput(item.lineTotalCentavos),
  }));
}

/** null for an empty box, a number for a parseable one, and `false` for junk. */
function parseOptionalPeso(value: string): number | null | false {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    return pesoToCentavos(trimmed);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function SourceChip({
  metaKey,
  item,
}: {
  metaKey: string;
  item: ReviewDecisionItem;
}) {
  const chip = fieldChip(item.parseMeta, metaKey, item.parseConfidence);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-s",
        toneChipClass(chip.tone),
      )}
    >
      {chip.sourceLabel}
      {chip.confidenceLabel === null ? "" : ` · ${chip.confidenceLabel}`}
    </span>
  );
}

function FieldRow({
  id,
  label,
  metaKey,
  item,
  children,
}: {
  id: string;
  label: string;
  metaKey: string;
  item: ReviewDecisionItem;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-label-l text-on-surface">
          {label}
        </label>
        <SourceChip metaKey={metaKey} item={item} />
      </div>
      {children}
    </div>
  );
}

const INPUT_CLASS = cn(
  "h-11 w-full rounded-md3-xs border border-outline bg-surface px-3 text-body-l text-on-surface",
  "placeholder:text-on-surface-variant",
  "outline-none transition-colors duration-200 ease-standard motion-reduce:transition-none",
  "focus:border-primary focus:ring-1 focus:ring-primary",
  "disabled:opacity-60",
);

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function ReviewDecisionScreen({
  item,
  businessName,
  now,
  onApprove,
  onReject,
}: ReviewDecisionScreenProps) {
  const router = useRouter();

  const [fields, setFields] = React.useState<FieldState>(() => initialFields(item));
  const [lineItems, setLineItems] = React.useState<LineItemState[]>(() =>
    initialLineItems(item.lineItems),
  );
  const [lineItemsEdited, setLineItemsEdited] = React.useState(false);

  const [pending, setPending] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<string[]>([]);
  const [alreadyDecided, setAlreadyDecided] = React.useState(false);
  const [outcome, setOutcome] = React.useState<string | null>(null);

  const [approveOpen, setApproveOpen] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState<string>("unreadable");
  const [rejectNote, setRejectNote] = React.useState("");

  const decidable = item.status === "review" && !item.submittedByViewer && !alreadyDecided;
  const age = queueAge(item.createdAt, now);
  const composite = compositeFraudScore(item.signals);

  const totalCentavos = parseOptionalPeso(fields.total);
  const confirmTotalLabel =
    totalCentavos === false || totalCentavos === null
      ? "no total entered"
      : formatPeso(totalCentavos);

  function updateField(key: keyof FieldState, value: string) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  function updateLineItem(index: number, key: keyof Omit<LineItemState, "key">, value: string) {
    setLineItemsEdited(true);
    setLineItems((current) =>
      current.map((row, position) => (position === index ? { ...row, [key]: value } : row)),
    );
  }

  function addLineItem() {
    setLineItemsEdited(true);
    setLineItems((current) => [
      ...current,
      { key: `new-${current.length}-${Date.now()}`, rawText: "", qty: "", unitPrice: "", lineTotal: "" },
    ]);
  }

  function removeLineItem(index: number) {
    setLineItemsEdited(true);
    setLineItems((current) => current.filter((_, position) => position !== index));
  }

  /**
   * The payload for `reviewFieldsSchema`. Every scalar key is sent, present
   * and possibly null, because the schema requires it: a partial patch cannot
   * distinguish "left alone" from "cleared", and the form always holds a value
   * for every field since it was pre-filled with the parse.
   */
  function buildFields(): { ok: true; fields: Record<string, unknown> } | { ok: false; errors: string[] } {
    const errors: string[] = [];

    const subtotal = parseOptionalPeso(fields.subtotal);
    if (subtotal === false) errors.push("Subtotal is not a valid amount.");
    const tax = parseOptionalPeso(fields.tax);
    if (tax === false) errors.push("Tax is not a valid amount.");
    const total = parseOptionalPeso(fields.total);
    if (total === false) errors.push("Total is not a valid amount.");
    if (total === null) errors.push("Enter the total. Points are computed from it.");

    let receiptDate: string | null = null;
    if (fields.receiptDate.trim().length > 0) {
      const parsed = new Date(`${fields.receiptDate}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime())) errors.push("The receipt date is not a valid date.");
      else receiptDate = parsed.toISOString();
    }

    const items: Array<Record<string, unknown>> = [];
    if (lineItemsEdited) {
      lineItems.forEach((row, index) => {
        if (row.rawText.trim().length === 0) {
          errors.push(`Line ${index + 1} needs a description or should be removed.`);
          return;
        }
        const unitPrice = parseOptionalPeso(row.unitPrice);
        const lineTotal = parseOptionalPeso(row.lineTotal);
        if (unitPrice === false) errors.push(`Line ${index + 1} unit price is not a valid amount.`);
        if (lineTotal === false) errors.push(`Line ${index + 1} total is not a valid amount.`);
        const qtyRaw = row.qty.trim();
        const qty = qtyRaw.length === 0 ? null : Number(qtyRaw);
        if (qty !== null && !Number.isFinite(qty)) {
          errors.push(`Line ${index + 1} quantity is not a number.`);
        }
        items.push({
          raw_text: row.rawText.trim(),
          qty: qty === null || !Number.isFinite(qty) ? null : qty,
          unit_price_centavos: unitPrice === false ? null : unitPrice,
          line_total_centavos: lineTotal === false ? null : lineTotal,
        });
      });
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
      ok: true,
      fields: {
        merchant_name: fields.merchantName.trim().length === 0 ? null : fields.merchantName.trim(),
        receipt_number:
          fields.receiptNumber.trim().length === 0 ? null : fields.receiptNumber.trim(),
        receipt_date: receiptDate,
        subtotal_centavos: subtotal === false ? null : subtotal,
        tax_centavos: tax === false ? null : tax,
        total_centavos: total,
        ...(lineItemsEdited ? { line_items: items } : {}),
      },
    };
  }

  function applyResult(result: ReviewActionResult) {
    if (result.ok) {
      setFormError(null);
      setFieldErrors([]);
      setOutcome(
        result.status === "approved"
          ? result.pointsAwarded === null
            ? "Approved. No points were awarded for this receipt."
            : `Approved. ${result.pointsAwarded} points were awarded.`
          : `Rejected as ${REJECT_REASON_LABELS[result.reason] ?? result.reason}.`,
      );
      router.refresh();
      return;
    }

    if (result.code === "RECEIPT_NOT_REVIEWABLE") {
      // Not a failure. Someone else decided it first.
      setAlreadyDecided(true);
      setFormError(null);
      setFieldErrors([]);
      return;
    }

    setFormError(result.message);
    setFieldErrors(result.fieldErrors);
  }

  async function submitApprove() {
    const built = buildFields();
    if (!built.ok) {
      setApproveOpen(false);
      setFormError("Fix the fields below before approving.");
      setFieldErrors(built.errors);
      return;
    }

    setPending(true);
    const result = await onApprove({ receiptId: item.receiptId, fields: built.fields });
    setPending(false);
    setApproveOpen(false);
    applyResult(result);
  }

  async function submitReject() {
    setPending(true);
    const result = await onReject({
      receiptId: item.receiptId,
      reason: rejectReason,
      ...(rejectNote.trim().length === 0 ? {} : { note: rejectNote.trim() }),
    });
    setPending(false);
    setRejectOpen(false);
    applyResult(result);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        <Link
          href="/business/receipts"
          className="inline-flex w-fit items-center gap-1 text-label-l text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span aria-hidden className="material-symbols-rounded text-[18px]">
            arrow_back
          </span>
          Back to receipts
        </Link>

        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-headline-s text-on-surface">
            {item.fields.merchantName ?? "Merchant not read"}
          </h1>
          {item.status === "review" ? (
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
              {item.status === "approved" ? "Approved" : "Rejected"}
              {item.reviewedAt === null ? "" : ` · ${formatDateTime(item.reviewedAt)}`}
            </span>
          )}
        </div>

        <p className="text-body-s text-on-surface-variant">
          Submitted by {item.consumerName ?? "a customer"} to {businessName} on{" "}
          {formatDateTime(item.createdAt)}
        </p>
      </div>

      {/* ---- The three states that replace the actions ------------------- */}
      {item.submittedByViewer && (
        <div
          role="note"
          className="rounded-md3-md border border-outline bg-surface-container p-4"
        >
          <p className="text-title-m text-on-surface">Someone else has to decide this one</p>
          <p className="mt-1 text-body-m text-on-surface-variant">
            This receipt was submitted from your own account, and Giya asks a
            different owner or manager to make the call on those. Nothing is
            wrong with the receipt. Ask a colleague with owner or manager access
            to open it, or leave it in the queue for them.
          </p>
        </div>
      )}

      {alreadyDecided && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md3-md border border-outline bg-surface-container p-4"
        >
          <p className="text-body-m text-on-surface">
            This receipt was already decided by someone else while you had it
            open. Refresh to see what they chose.
          </p>
          <Button type="button" variant="tonal" size="sm" onClick={() => router.refresh()}>
            Refresh
          </Button>
        </div>
      )}

      {!item.submittedByViewer && !alreadyDecided && item.status !== "review" && (
        <div className="rounded-md3-md border border-outline-variant bg-surface-container p-4 text-body-m text-on-surface-variant">
          {item.status === "approved"
            ? "This receipt has been approved. Points were computed from the total below."
            : `This receipt was rejected${
                item.rejectReason === null
                  ? ""
                  : ` as ${REJECT_REASON_LABELS[item.rejectReason] ?? item.rejectReason}`
              }.`}
        </div>
      )}

      {outcome !== null && (
        <div
          role="status"
          className="rounded-md3-md border border-outline bg-surface-container p-4 text-body-m text-on-surface"
        >
          {outcome}
        </div>
      )}

      {/* ---- Image beside the fields ------------------------------------ */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section aria-labelledby="receipt-image-heading" className="flex flex-col gap-2">
          <h2 id="receipt-image-heading" className="text-title-m text-on-surface">
            The photo
          </h2>
          {item.imageUrl === null ? (
            <div className="flex min-h-64 items-center justify-center rounded-md3-md border border-outline-variant bg-surface-container p-6 text-center text-body-m text-on-surface-variant">
              The receipt photo could not be loaded. Refresh the page to try
              again; the link expires after five minutes.
            </div>
          ) : (
            <a
              href={item.imageUrl}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-md3-md border border-outline-variant bg-surface-container outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {/* Deliberately a plain <img>: the source is a 5 minute signed
                  URL on the Supabase storage host, so next/image would need
                  that host allow-listed and would cache a URL built to expire. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={item.imageUrl}
                alt="The receipt as the customer photographed it"
                className="h-auto w-full object-contain"
              />
            </a>
          )}
          <p className="text-body-s text-on-surface-variant">
            Open in a new tab to zoom. The link works for five minutes.
          </p>
        </section>

        <section aria-labelledby="receipt-fields-heading" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="receipt-fields-heading" className="text-title-m text-on-surface">
              What we read
            </h2>
            {item.parseConfidence !== null && (
              <span className="font-mono text-label-m text-on-surface-variant">
                read {formatConfidence(item.parseConfidence)}
                {item.matchConfidence === null
                  ? ""
                  : ` · match ${formatConfidence(item.matchConfidence)}`}
              </span>
            )}
          </div>

          <FieldRow id="merchant-name" label="Merchant" metaKey="merchant_name" item={item}>
            <input
              id="merchant-name"
              className={INPUT_CLASS}
              value={fields.merchantName}
              disabled={!decidable}
              onChange={(event) => updateField("merchantName", event.target.value)}
            />
          </FieldRow>

          <FieldRow id="receipt-number" label="Receipt number" metaKey="receipt_number" item={item}>
            <input
              id="receipt-number"
              className={INPUT_CLASS}
              value={fields.receiptNumber}
              disabled={!decidable}
              onChange={(event) => updateField("receiptNumber", event.target.value)}
            />
          </FieldRow>

          <FieldRow id="receipt-date" label="Receipt date" metaKey="receipt_date" item={item}>
            <input
              id="receipt-date"
              type="date"
              className={INPUT_CLASS}
              value={fields.receiptDate}
              disabled={!decidable}
              onChange={(event) => updateField("receiptDate", event.target.value)}
            />
          </FieldRow>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FieldRow id="subtotal" label="Subtotal" metaKey="subtotal_centavos" item={item}>
              <input
                id="subtotal"
                inputMode="decimal"
                className={cn(INPUT_CLASS, "font-mono")}
                value={fields.subtotal}
                disabled={!decidable}
                onChange={(event) => updateField("subtotal", event.target.value)}
              />
            </FieldRow>
            <FieldRow id="tax" label="Tax" metaKey="tax_centavos" item={item}>
              <input
                id="tax"
                inputMode="decimal"
                className={cn(INPUT_CLASS, "font-mono")}
                value={fields.tax}
                disabled={!decidable}
                onChange={(event) => updateField("tax", event.target.value)}
              />
            </FieldRow>
            <FieldRow id="total" label="Total" metaKey="total_centavos" item={item}>
              <input
                id="total"
                inputMode="decimal"
                className={cn(INPUT_CLASS, "font-mono")}
                value={fields.total}
                disabled={!decidable}
                onChange={(event) => updateField("total", event.target.value)}
              />
            </FieldRow>
          </div>

          {/* ---- Line items ---------------------------------------------- */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-label-l text-on-surface">Line items</h3>
              {decidable && (
                <Button type="button" variant="text" size="sm" onClick={addLineItem}>
                  Add a line
                </Button>
              )}
            </div>
            {lineItems.length === 0 ? (
              <p className="text-body-s text-on-surface-variant">
                No line items were read. They are used for product reporting and
                never change the points.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {lineItems.map((row, index) => (
                  <li key={row.key} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-40 flex-1">
                      <label
                        htmlFor={`line-${index}-text`}
                        className="text-label-s text-on-surface-variant"
                      >
                        Item {index + 1}
                      </label>
                      <input
                        id={`line-${index}-text`}
                        className={INPUT_CLASS}
                        value={row.rawText}
                        disabled={!decidable}
                        onChange={(event) => updateLineItem(index, "rawText", event.target.value)}
                      />
                    </div>
                    <div className="w-20">
                      <label
                        htmlFor={`line-${index}-qty`}
                        className="text-label-s text-on-surface-variant"
                      >
                        Qty
                      </label>
                      <input
                        id={`line-${index}-qty`}
                        inputMode="decimal"
                        className={cn(INPUT_CLASS, "font-mono")}
                        value={row.qty}
                        disabled={!decidable}
                        onChange={(event) => updateLineItem(index, "qty", event.target.value)}
                      />
                    </div>
                    <div className="w-28">
                      <label
                        htmlFor={`line-${index}-total`}
                        className="text-label-s text-on-surface-variant"
                      >
                        Line total
                      </label>
                      <input
                        id={`line-${index}-total`}
                        inputMode="decimal"
                        className={cn(INPUT_CLASS, "font-mono")}
                        value={row.lineTotal}
                        disabled={!decidable}
                        onChange={(event) => updateLineItem(index, "lineTotal", event.target.value)}
                      />
                    </div>
                    {decidable && (
                      <Button
                        type="button"
                        variant="text"
                        size="sm"
                        aria-label={`Remove item ${index + 1}`}
                        onClick={() => removeLineItem(index)}
                      >
                        Remove
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {formError !== null && (
            <div role="alert" className="rounded-md3-sm bg-error-container p-3 text-body-m text-on-error-container">
              <p>{formError}</p>
              {fieldErrors.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {fieldErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {decidable && (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="filled"
                size="md"
                disabled={pending}
                onClick={() => setApproveOpen(true)}
              >
                Approve and award points
              </Button>
              <Button
                type="button"
                variant="outlined"
                size="md"
                disabled={pending}
                onClick={() => setRejectOpen(true)}
              >
                Reject
              </Button>
            </div>
          )}
        </section>
      </div>

      {/* ---- Evidence --------------------------------------------------- */}
      <section aria-labelledby="signals-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="signals-heading" className="text-title-m text-on-surface">
            Why this needs a look
          </h2>
          {item.signals.length > 0 && (
            <span className="font-mono text-label-m text-on-surface-variant">
              combined score {composite.toFixed(2)}
            </span>
          )}
        </div>
        <FraudSignalList signals={item.signals} />
      </section>

      {/* ---- Consumer history ------------------------------------------- */}
      <section aria-labelledby="history-heading" className="flex flex-col gap-2">
        <h2 id="history-heading" className="text-title-m text-on-surface">
          This customer at {businessName}
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Receipts", value: item.history.receiptsAtBusiness },
            { label: "Approved", value: item.history.approvedAtBusiness },
            { label: "Rejected", value: item.history.rejectedAtBusiness },
            { label: "Flags raised", value: item.history.priorSignalsAtBusiness },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-md3-md border border-outline-variant bg-surface p-3"
            >
              <dt className="text-body-s text-on-surface-variant">{stat.label}</dt>
              <dd className="font-mono text-title-l text-on-surface">{stat.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-body-s text-on-surface-variant">
          Counts cover this customer at {businessName} only.
        </p>
      </section>

      {/* ---- Confirm approve -------------------------------------------- */}
      <Dialog
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Approve this receipt?"
        describedById="approve-confirm-body"
      >
        <p id="approve-confirm-body" className="text-body-m text-on-surface-variant">
          Points will be computed from{" "}
          <span className="font-mono text-on-surface">{confirmTotalLabel}</span> using
          your earning rules, and added to this customer straight away. Approving
          cannot be undone from here.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="text" size="md" onClick={() => setApproveOpen(false)}>
            Go back
          </Button>
          <Button
            type="button"
            variant="filled"
            size="md"
            disabled={pending}
            onClick={() => void submitApprove()}
          >
            {pending ? "Approving" : "Yes, approve"}
          </Button>
        </div>
      </Dialog>

      {/* ---- Reject ------------------------------------------------------ */}
      <Dialog open={rejectOpen} onClose={() => setRejectOpen(false)} title="Reject this receipt">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-label-l text-on-surface">Reason</legend>
          {REJECT_REASON_ORDER.map((reason) => (
            <label key={reason} className="flex items-start gap-2 text-body-m text-on-surface">
              <input
                type="radio"
                name="reject-reason"
                value={reason}
                checked={rejectReason === reason}
                onChange={() => setRejectReason(reason)}
                className="mt-1 accent-primary"
              />
              <span>
                {REJECT_REASON_LABELS[reason] ?? reason}
                {FRAUD_FAMILY_REASONS.has(reason) && (
                  <span className="block text-body-s text-on-surface-variant">
                    Counts toward a temporary scanning block for this customer.
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-2">
          <label htmlFor="reject-note" className="text-label-l text-on-surface">
            Note (optional)
          </label>
          <textarea
            id="reject-note"
            rows={3}
            maxLength={1000}
            value={rejectNote}
            onChange={(event) => setRejectNote(event.target.value)}
            className={cn(INPUT_CLASS, "h-auto py-2")}
          />
          <p className="text-body-s text-on-surface-variant">
            Kept for your records. The customer sees the reason, not the note.
          </p>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="text" size="md" onClick={() => setRejectOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="filled"
            size="md"
            disabled={pending}
            onClick={() => void submitReject()}
          >
            {pending ? "Rejecting" : "Reject receipt"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
