"use client";

import * as React from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";

import type { ReceiptRealtimeRow } from "../types";

// The Realtime half of doc 36's "Realtime status + optimistic wallet UX"
// contract, shared by the /scan/[receiptId] status screen and the wallet's
// pending receipt entry so there is exactly one implementation of the
// subscribe/fallback dance in this slice.
//
// It follows the pattern src/features/rewards/components/redemption-qr.tsx
// already established on `reward_claims` rather than inventing a second one:
// subscribe to postgres_changes, and arm a poll if the socket reports trouble
// OR if it simply goes quiet for longer than a healthy channel ever would.
//
// PUBLICATION NOTE: `receipts` was not in the `supabase_realtime` publication
// until 0020_realtime_receipts.sql. A missing publication does not error, it
// reports SUBSCRIBED and then never delivers anything, which is exactly the
// failure the belt-and-braces timer below exists to survive. Keep the timer
// even now that the publication is in place: a Realtime outage, a paused
// project, or a future table dropped from the publication all look identical
// from here, and none of them should cost a consumer their points update.

/** Doc 36: "poll GET /api/v1/me/receipts/{id} every 5s if the socket drops". */
export const RECEIPT_POLL_INTERVAL_MS = 5_000;

/**
 * Grace period before arming the poll even when the channel reports a clean
 * SUBSCRIBED. Comfortably longer than a healthy subscribe handshake and
 * comfortably shorter than doc 36's 60s p95 end-to-end budget, so a silent
 * channel costs the consumer a few seconds of latency rather than the whole
 * update.
 */
export const RECEIPT_FALLBACK_POLL_DELAY_MS = 8_000;

export interface UseReceiptRealtimeOptions {
  /** Unique per subscription. Two components on one page must not share a name. */
  channelName: string;
  /** A postgres_changes filter, e.g. `id=eq.{receiptId}` or `user_id=eq.{userId}`. */
  filter: string;
  /**
   * While false the channel is torn down and no polling happens. Callers set
   * this false the moment nothing is left to watch (the receipt settled, the
   * wallet has no pending entries), which is what stops this from becoming a
   * permanent 5s heartbeat against the API.
   */
  enabled: boolean;
  /**
   * A changed receipts row. The payload is PARTIAL: Realtime's WALRUS layer
   * strips every column the subscribing role cannot SELECT, and 0017's
   * column-level grant means a consumer receives only the 13 granted columns.
   * Treat every field as possibly absent.
   */
  onRow: (row: Partial<ReceiptRealtimeRow>) => void;
  /** Poll tick. Fetches authoritative state over HTTP; may be async. */
  onPoll: () => void | Promise<void>;
}

export function useReceiptRealtime({
  channelName,
  filter,
  enabled,
  onRow,
  onPoll,
}: UseReceiptRealtimeOptions): void {
  // Callbacks live in refs so a parent re-render with fresh closures does not
  // tear down and rebuild the channel (which would drop events in the gap).
  const onRowRef = React.useRef(onRow);
  const onPollRef = React.useRef(onPoll);

  React.useEffect(() => {
    onRowRef.current = onRow;
    onPollRef.current = onPoll;
  }, [onRow, onPoll]);

  React.useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    function startPolling() {
      if (pollTimer || cancelled) return;
      pollTimer = setInterval(() => {
        if (cancelled) return;
        void onPollRef.current();
      }, RECEIPT_POLL_INTERVAL_MS);
    }

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "receipts", filter },
        (payload: RealtimePostgresChangesPayload<ReceiptRealtimeRow>) => {
          if (cancelled) return;
          const row = payload.new as Partial<ReceiptRealtimeRow> | undefined;
          // A DELETE payload has no `new`, and receipts can never be deleted
          // anyway (0017's receipts_no_delete trigger), but the subscription
          // is typed for the general case so the guard stays.
          if (row && typeof row.id === "string") {
            onRowRef.current(row);
          }
        },
      )
      .subscribe((status) => {
        if (cancelled) return;
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          startPolling();
        }
      });

    const fallbackTimer = setTimeout(startPolling, RECEIPT_FALLBACK_POLL_DELAY_MS);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      clearTimeout(fallbackTimer);
      void supabase.removeChannel(channel);
    };
  }, [enabled, channelName, filter]);
}
