"use client";

import * as React from "react";
import Link from "next/link";

import { EmptyState } from "@/components/consumer/empty-state";

import type { ReceiptListItemDTO } from "../types";
import { fetchMyReceipts, fetchReceiptDetail } from "./receipt-api-client";
import { isPendingStatus } from "./receipt-copy";
import { ReceiptHistoryRow } from "./receipt-history-list";
import { applyReceiptChange } from "./receipt-status";
import { useReceiptRealtime } from "./use-receipt-realtime";

// The wallet's live receipt strip, implementing doc 36's wallet UX contract:
//
//   "on 202 the wallet inserts a local 'Processing receipt' pending entry (no
//    points amount, the amount is unknown until parse). `approved` event
//    carries the awarded points -> entry flips to confirmed with points;
//    `review` -> 'Being reviewed by the store'; `rejected` -> reason."
//
// One deliberate difference from the doc's wording. The entry is not inserted
// "locally" from the 202 response: /wallet is a force-dynamic server
// component, and by the time the submit endpoint has answered 202 the
// `receipts` row already exists at status='queued', so the server render
// already contains it. Reading it from the database instead of mirroring it
// in client state gets the same instant pending entry with one fewer source
// of truth, and it survives a refresh, a cold start and a second device,
// which a local optimistic entry does not.
//
// What IS client-side is the flip. This island subscribes to postgres_changes
// on the caller's own receipts (`user_id=eq.{id}`) with the same 5s poll
// fallback as the status screen, and stops watching the moment nothing is
// pending, so a wallet left open does not turn into a permanent poll.

/** How many receipts the wallet strip shows before deferring to /receipts. */
export const WALLET_RECEIPT_LIMIT = 3;

export interface WalletReceiptActivityProps {
  /** The signed-in consumer, used only to scope the Realtime filter. */
  userId: string;
  initialReceipts: readonly ReceiptListItemDTO[];
}

export function WalletReceiptActivity({ userId, initialReceipts }: WalletReceiptActivityProps) {
  const [entries, setEntries] = React.useState<ReceiptListItemDTO[]>(() => [...initialReceipts]);

  const watching = entries.some((entry) => isPendingStatus(entry.status));

  const refreshEntry = React.useCallback(async (receiptId: string) => {
    const fresh = await fetchReceiptDetail(receiptId);
    if (!fresh) return;
    setEntries((current) =>
      current.map((entry) => (entry.receiptId === receiptId ? fresh : entry)),
    );
  }, []);

  const refreshList = React.useCallback(async () => {
    const fresh = await fetchMyReceipts({ limit: WALLET_RECEIPT_LIMIT });
    if (fresh) setEntries(fresh);
  }, []);

  const handleRow = React.useCallback(
    (row: { id?: string; status?: string; reject_reason?: string | null; processed_at?: string | null }) => {
      const receiptId = row.id;
      if (!receiptId) return;

      let becameApproved = false;

      setEntries((current) => {
        const index = current.findIndex((entry) => entry.receiptId === receiptId);
        const existing = index === -1 ? undefined : current[index];
        // A receipt we are not showing (older than the strip's window, or
        // submitted on another device). The list refresh below picks it up
        // rather than this component guessing at a row it has never seen.
        if (!existing) return current;

        const next = applyReceiptChange(existing, row);
        if (next.status === "approved" && next.pointsAwarded === null) {
          becameApproved = true;
        }

        const updated = [...current];
        updated[index] = next;
        return updated;
      });

      // The receipts payload carries no points: the award lives in
      // points_transactions. Fetch the real figure rather than inventing one.
      if (becameApproved) {
        void refreshEntry(receiptId);
      }
    },
    [refreshEntry],
  );

  useReceiptRealtime({
    channelName: `wallet-receipts-${userId}`,
    filter: `user_id=eq.${userId}`,
    enabled: watching,
    onRow: handleRow,
    onPoll: refreshList,
  });

  // This section used to `return null` at zero entries, and that made
  // /receipts unreachable for anyone who had never scanned. The "See all"
  // link below is the ONLY consumer-facing entry point to receipt history:
  // it is not in the bottom nav (see the note there on why a fifth
  // destination is the wrong fix) and nothing else links to it. Hiding the
  // whole section on an empty wallet therefore hid the route from exactly
  // the people who most needed to be told it exists - new accounts.
  //
  // Rendering the header at zero costs nothing at runtime: `watching` is
  // false with no pending entries, so the Realtime subscription still does
  // not open.
  const isEmpty = entries.length === 0;

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-title-m text-on-surface">Receipts</h2>
        <Link
          href="/receipts"
          className="text-label-l text-on-surface-variant underline-offset-4 hover:underline"
        >
          See all
        </Link>
      </div>

      {isEmpty ? (
        <EmptyState
          icon="receipt_long"
          title="No receipts yet"
          body="Scan a receipt from a shop on Giya and it will show up here while it is being checked."
          action={{ label: "Scan a receipt", href: "/scan" }}
          className="mt-3"
        />
      ) : (
        /* Polite, not assertive: a points update is good news, not an alert
           that should interrupt whatever a screen reader is currently saying. */
        <ul aria-live="polite" className="mt-3 space-y-1">
          {entries.slice(0, WALLET_RECEIPT_LIMIT).map((entry) => (
            <li key={entry.receiptId}>
              <ReceiptHistoryRow receipt={entry} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
