"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { ReceiptListItemDTO, ReceiptRejectReason, ReceiptStatus } from "../types";
import { fetchReceiptDetail } from "./receipt-api-client";
import {
  approvedCopy,
  isSettledStatus,
  pendingCopy,
  receiptOutcome,
  rejectionCopy,
  reviewCopy,
  type ReceiptOutcomeCopy,
} from "./receipt-copy";
import { useReceiptRealtime } from "./use-receipt-realtime";

// /scan/[receiptId] - the live status of one submission.
//
// Doc 36 "Realtime status + optimistic wallet UX": subscribe to
// postgres_changes on the consumer's own receipts row filtered
// `id=eq.{receipt_id}`, with a 5s poll of GET /api/v1/me/receipts/{id} when
// the socket drops. Both live in useReceiptRealtime; this component owns the
// state machine and the copy.
//
// The server renders the first paint from its own read, so a receipt that is
// already settled by the time the consumer lands here (the stub OCR provider
// finishes well inside one request) shows its outcome immediately and never
// subscribes at all.

const ACTION_CLASS =
  "inline-flex h-12 items-center rounded-full px-6 text-label-l transition-colors duration-200 ease-standard hover:opacity-90 outline-none focus-visible:ring-2 focus-visible:ring-primary";

export interface ReceiptStatusProps {
  receipt: ReceiptListItemDTO;
}

/**
 * Merge a partial Realtime payload into the current view state.
 *
 * Pure and exported so the Realtime-to-state transition is testable without a
 * socket. Rules that matter:
 *
 *   - Only fields actually present in the payload are applied. WALRUS strips
 *     columns the role cannot SELECT, so `undefined` means "not sent", never
 *     "cleared".
 *   - `pointsAwarded` is never taken from a receipts payload: points live in
 *     `points_transactions`, and a receipts row carries no such column. On a
 *     transition into `approved` the caller fetches the authoritative number.
 *   - A status leaving `approved` clears a previously shown points figure, so
 *     a reversal can never leave a stale celebratory number on screen.
 */
export function applyReceiptChange(
  current: ReceiptListItemDTO,
  change: { status?: string; reject_reason?: string | null; processed_at?: string | null },
): ReceiptListItemDTO {
  const nextStatus = isReceiptStatus(change.status) ? change.status : current.status;

  return {
    ...current,
    status: nextStatus,
    rejectReason:
      change.reject_reason === undefined
        ? current.rejectReason
        : toRejectReason(change.reject_reason),
    processedAt: change.processed_at === undefined ? current.processedAt : change.processed_at,
    pointsAwarded: nextStatus === "approved" ? current.pointsAwarded : null,
  };
}

const RECEIPT_STATUSES: readonly string[] = [
  "queued",
  "processing",
  "review",
  "approved",
  "rejected",
];

function isReceiptStatus(value: string | undefined): value is ReceiptStatus {
  return typeof value === "string" && RECEIPT_STATUSES.includes(value);
}

const REJECT_REASONS: readonly string[] = [
  "duplicate",
  "unreadable",
  "wrong_business",
  "too_old",
  "fraud_suspected",
  "manual",
];

function toRejectReason(value: string | null): ReceiptRejectReason | null {
  if (!value) return null;
  return REJECT_REASONS.includes(value) ? (value as ReceiptRejectReason) : "manual";
}

/**
 * The copy for a given receipt state. Exported and pure: every one of the
 * four outcomes and all six rejection reasons are asserted through this
 * function in receipt-status.test.tsx without rendering anything.
 */
export function statusCopy(receipt: ReceiptListItemDTO): ReceiptOutcomeCopy {
  switch (receiptOutcome(receipt.status)) {
    case "approved":
      return approvedCopy(receipt.pointsAwarded, receipt.businessName);
    case "review":
      return reviewCopy();
    case "rejected":
      return rejectionCopy(receipt.rejectReason);
    case "pending":
      return pendingCopy(receipt.status);
  }
}

export function ReceiptStatus({ receipt }: ReceiptStatusProps) {
  const [state, setState] = React.useState<ReceiptListItemDTO>(receipt);
  const receiptId = receipt.receiptId;

  // Watch until the pipeline settles. `review` keeps watching on purpose: a
  // human can still approve or reject it while the consumer is looking at
  // the screen, and doc 36's SLA is a target, not a guarantee it will take
  // long enough for them to have navigated away.
  const watching = !isSettledStatus(state.status);

  const refresh = React.useCallback(async () => {
    const fresh = await fetchReceiptDetail(receiptId);
    if (fresh) setState(fresh);
  }, [receiptId]);

  const handleRow = React.useCallback(
    (row: { status?: string; reject_reason?: string | null; processed_at?: string | null }) => {
      setState((current) => {
        const next = applyReceiptChange(current, row);
        // The award transaction writes the ledger row and flips the status
        // together, but this payload only carries the receipt. Fetch the
        // authoritative points figure rather than inventing one; until it
        // lands, approvedCopy renders its no-number variant.
        if (next.status === "approved" && next.pointsAwarded === null) {
          void refresh();
        }
        return next;
      });
    },
    [refresh],
  );

  useReceiptRealtime({
    channelName: `receipt-${receiptId}`,
    filter: `id=eq.${receiptId}`,
    enabled: watching,
    onRow: handleRow,
    onPoll: refresh,
  });

  const outcome = receiptOutcome(state.status);
  const copy = statusCopy(state);
  const celebrating = outcome === "approved";

  // Reduced motion collapses every spring below to no animation at all: the
  // badge and the points figure simply appear, already settled. The colour
  // change, the copy and the aria-live announcement carry the news on their
  // own, so nothing about the outcome is communicated by movement alone.
  const reduce = useReducedMotion();

  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-6 px-4 pt-8 pb-8 text-center">
      {/* The card itself is the live region. A separate visually-hidden copy
          of the same sentences would make a screen reader announce the
          outcome twice, so the announcement and the visible content are one
          and the same. Polite, not assertive: points landing is good news,
          not something that should cut across whatever is being read. */}
      <Card
        aria-live="polite"
        variant={celebrating ? "filled" : "outlined"}
        className={cn(
          "flex w-full flex-col items-center gap-4 p-8",
          celebrating && "bg-tertiary-container",
        )}
      >
        <span className="relative flex size-16 items-center justify-center">
          {celebrating ? (
            // The celebration. A single expanding ring behind the check mark,
            // gated on motion-safe so a consumer who asked their OS for less
            // motion gets the static badge and loses nothing but the flourish
            // (doc 16: "DO gate animation behind reduced-motion").
            <span
              aria-hidden
              className="absolute inline-flex size-16 rounded-full bg-on-tertiary-container opacity-20 motion-safe:animate-ping"
            />
          ) : null}
          {/* The badge itself springs in when the outcome becomes `approved`.
              `key={outcome}` is doing the work: the element REMOUNTS on the
              transition into approved, so the mount animation plays exactly
              once, at the moment that matters, and never again on a re-render
              caused by the points figure arriving a beat later.

              Entrance only, and no AnimatePresence. A previous slice deadlocked
              consumer onboarding with `AnimatePresence mode="wait"` -- the
              outgoing step never finished exiting, so the incoming one never
              mounted and the flow froze on step 1. The lesson generalises: an
              exit animation on a state machine that can change state again
              mid-exit is a trap. Nothing here waits for anything to leave. */}
          <motion.span
            key={outcome}
            aria-hidden
            {...(reduce
              ? {}
              : {
                  initial: { scale: 0.5, opacity: 0 },
                  animate: { scale: 1, opacity: 1 },
                  transition: celebrating
                    ? // Overshoot, then settle. This is the one moment in the
                      // app that is allowed to feel pleased with itself.
                      { type: "spring" as const, stiffness: 520, damping: 18, mass: 0.7 }
                    : { duration: 0.2 },
                })}
            className={cn(
              "material-symbols-rounded relative text-[48px]",
              celebrating
                ? "is-filled text-on-tertiary-container"
                : outcome === "pending"
                  ? "text-on-surface-variant motion-safe:animate-pulse"
                  : "text-on-surface-variant",
            )}
          >
            {copy.icon}
          </motion.span>
        </span>

        <div className="space-y-2">
          <h1
            className={cn(
              "text-title-l",
              celebrating ? "text-on-tertiary-container" : "text-on-surface",
            )}
          >
            {copy.title}
          </h1>
          <p
            className={cn(
              "text-body-m",
              celebrating ? "text-on-tertiary-container" : "text-on-surface-variant",
            )}
          >
            {copy.body}
          </p>
        </div>

        {/* The number is the payoff, and it usually lands a moment AFTER the
            status flips, because the points figure comes from a second fetch
            (see handleRow). Animating it separately is therefore not a
            flourish for its own sake: it draws the eye back at the exact
            moment the figure appears, instead of letting it pop in silently
            while the consumer is still looking at the check mark. */}
        {celebrating && state.pointsAwarded !== null ? (
          <motion.p
            {...(reduce
              ? {}
              : {
                  initial: { y: 8, opacity: 0, scale: 0.9 },
                  animate: { y: 0, opacity: 1, scale: 1 },
                  transition: { type: "spring" as const, stiffness: 420, damping: 22 },
                })}
            className="font-mono text-headline-m text-on-tertiary-container"
          >
            +{state.pointsAwarded.toLocaleString()} pts
          </motion.p>
        ) : null}
      </Card>

      {copy.action ? (
        <Link
          href={copy.action.href}
          className={cn(
            ACTION_CLASS,
            celebrating
              ? "bg-tertiary-container text-on-tertiary-container"
              : "bg-secondary-container text-on-secondary-container",
          )}
        >
          {copy.action.label}
        </Link>
      ) : null}

      <Link
        href="/receipts"
        className="text-label-l text-on-surface-variant underline-offset-4 hover:underline"
      >
        See all my receipts
      </Link>
    </main>
  );
}
