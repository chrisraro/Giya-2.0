"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  OUTBOX_DELETE_CONFIRM_LABEL,
  outboxCardHeading,
  outboxStatusLabel,
} from "@/features/pwa/outbox-card-copy";
import {
  deleteOutboxItem,
  listOutboxItems,
  updateOutboxItem,
  type OutboxItem,
} from "@/features/pwa/outbox";
import {
  createBackoffSchedule,
  drainOutbox,
  type OutboxReplayEvent,
} from "@/features/pwa/outbox-replay";
import { submitCapturedReceipt } from "@/features/receipts/upload";
import { parseSwMessage } from "@/lib/pwa/messages";

// The offline receipt queue: doc 41 section 3's user-visible state, and the
// fallback replay that doc 41 section 6 says iOS Safari and Firefox Android
// depend on entirely.
//
// WHY THIS COMPONENT DOES BOTH. Background Sync drains the queue on Chromium
// with the app closed. On the browsers that do not have it, the only two
// moments a drain can happen are app launch and the `online` event, and both
// are things a mounted client component can observe. Splitting the card and the
// driver into two components would mean two subscriptions to the same events
// and two answers to "is a drain already running".
//
// WHY /scan AND /receipts RATHER THAN THE LAYOUT. Doc 41 section 3 names those
// two screens for the card, and the drain needs a signed-in session: mounting
// it in the consumer layout would fire submissions for a signed-out visitor on
// a public /b/[slug] page, whose queue is empty and whose drain can only 401.
// The cost is that a consumer who opens the app onto /home does not drain until
// they reach either screen, which is where they are going anyway to scan or to
// check what is waiting.
//
// It renders NOTHING for an empty queue, so both pages pay only an IndexedDB
// read when there is nothing to show.

export function ReceiptOutbox() {
  const [items, setItems] = React.useState<readonly OutboxItem[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
  const reduce = useReducedMotion();

  // One schedule for the life of the screen. It holds WHEN an item may next be
  // tried, never what to send, so losing it on navigation retries sooner and
  // can never lose a receipt (see outbox-replay.ts).
  const scheduleRef = React.useRef(createBackoffSchedule());
  const drainingRef = React.useRef(false);

  const refresh = React.useCallback(async () => {
    try {
      setItems(await listOutboxItems());
    } catch {
      // No IndexedDB, or a database that will not open. There is no queue to
      // show and no honest card to draw, so the screen stays as it was.
      setItems([]);
    }
  }, []);

  const drain = React.useCallback(
    async (retryFailed: boolean) => {
      // A launch drain and an `online` drain can land together, and two drains
      // over one queue would submit each item twice. The Idempotency-Key makes
      // that safe, not free.
      if (drainingRef.current) return;
      drainingRef.current = true;
      try {
        await drainOutbox({
          submit: submitCapturedReceipt,
          now: () => Date.now(),
          schedule: scheduleRef.current,
          retryFailed,
          notify: (event: OutboxReplayEvent) => setNotice(event.message),
        });
      } finally {
        drainingRef.current = false;
        await refresh();
      }
    },
    [refresh],
  );

  // Doc 41 section 3: "replay attempts on app launch and on the `online` event".
  //
  // The two runs differ in one argument, and it matters. A MOUNT is not
  // evidence that anything changed: navigating to /receipts and back would
  // otherwise spend an attempt on a row that has already spent five. An
  // `online` TRANSITION is evidence - the thing that was missing has come back -
  // so it is allowed to reach failed rows. Without that, five attempts spent in
  // one bad afternoon strand a receipt until the consumer notices the Retry
  // button, on a platform doc 41 section 8 says will evict it in about a week.
  React.useEffect(() => {
    void drain(false);
  }, [drain]);

  React.useEffect(() => {
    const onOnline = () => void drain(true);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [drain]);

  // Doc 41 section 1: the worker posts OUTBOX_CHANGED after a Background Sync
  // replay, which happened in the worker and not here, so the card has to be
  // told rather than assume.
  React.useEffect(() => {
    const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (container === undefined) return;

    const onMessage = (event: MessageEvent) => {
      if (parseSwMessage(event.data)?.type === "OUTBOX_CHANGED") void refresh();
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [refresh]);

  async function retryNow(item: OutboxItem): Promise<void> {
    // A hand-driven retry resets the automatic budget: the consumer has said
    // "try again", which is a different event from the fifth failure that
    // stopped the drain, and the backoff hold belongs to that failure.
    scheduleRef.current.itemDueAt.delete(item.id);
    scheduleRef.current.drainDueAt = 0;
    await updateOutboxItem(item.id, { status: "queued", attempts: 0, last_error: null });
    setNotice(null);
    await drain(true);
  }

  async function confirmDelete(item: OutboxItem): Promise<void> {
    if (pendingDelete !== item.id) {
      // Deleting destroys the only copy of that photo. One tap is not enough.
      setPendingDelete(item.id);
      return;
    }
    setPendingDelete(null);
    await deleteOutboxItem(item.id);
    await refresh();
  }

  // An empty queue with something to say still renders. The first draft
  // returned null on `items.length === 0`, which meant a successful drain
  // deleted the last row and unmounted the card in the same commit, taking doc
  // 41 section 3 step 5's "notify the user" with it: the consumer watched the
  // queue disappear and was never told their receipt had gone through. The
  // confirmation outlives the rows it is about.
  if (items.length === 0 && notice === null) return null;

  return (
    <motion.section
      aria-labelledby="outbox-heading"
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0, 0, 1] }}
    >
      <Card variant="filled" className="flex w-full flex-col gap-3 p-4">
        {items.length === 0 ? null : (
          <div className="flex items-center gap-2">
            <span aria-hidden className="material-symbols-rounded text-on-surface-variant">
              cloud_upload
            </span>
            <h2 id="outbox-heading" className="text-title-s text-on-surface">
              {outboxCardHeading(items.length)}
            </h2>
          </div>
        )}

        {notice === null ? null : (
          <p role="status" className="text-body-s text-on-surface-variant">
            {notice}
          </p>
        )}

        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <OutboxRow
              key={item.id}
              item={item}
              awaitingDeleteConfirm={pendingDelete === item.id}
              onRetry={() => void retryNow(item)}
              onDelete={() => void confirmDelete(item)}
            />
          ))}
        </ul>
      </Card>
    </motion.section>
  );
}

interface OutboxRowProps {
  readonly item: OutboxItem;
  readonly awaitingDeleteConfirm: boolean;
  readonly onRetry: () => void;
  readonly onDelete: () => void;
}

function OutboxRow({ item, awaitingDeleteConfirm, onRetry, onDelete }: OutboxRowProps) {
  const thumbnail = useObjectUrl(item.image);

  return (
    <li className="flex items-center gap-3">
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md3-sm bg-surface-container-highest">
        {thumbnail === null ? null : (
          // eslint-disable-next-line @next/next/no-img-element -- a local object URL for bytes that have never left the device; next/image cannot optimize a blob
          <img src={thumbnail} alt="" className="h-full w-full object-cover" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-body-m text-on-surface">
          <time dateTime={item.captured_at}>{formatCapturedAt(item.captured_at)}</time>
        </p>
        <p className="text-body-s text-on-surface-variant">{outboxStatusLabel(item.status)}</p>
      </div>

      {item.status === "failed" ? (
        <Button type="button" variant="text" size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}

      <Button
        type="button"
        variant="text"
        size="sm"
        aria-label={awaitingDeleteConfirm ? OUTBOX_DELETE_CONFIRM_LABEL : "Delete this receipt"}
        onClick={onDelete}
      >
        {awaitingDeleteConfirm ? "Sure?" : "Delete"}
      </Button>
    </li>
  );
}

/**
 * An object URL for the queued photo, released when the row goes.
 *
 * Returns `null` where the browser has no object URLs; the row still renders
 * with its time, status and buttons, because the thumbnail is the only part of
 * it that is decoration.
 */
function useObjectUrl(blob: Blob): string | null {
  // Minted in a lazy initializer rather than in an effect: an effect would have
  // to setState to publish the URL, which is a second render per row for a
  // value that is knowable at the first. Rows are keyed by their outbox id and
  // an id's bytes never change, so once per mount is exactly once per photo.
  const [url] = React.useState<string | null>(() => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    try {
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  });

  React.useEffect(() => {
    if (url === null) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  return url;
}

/**
 * "Today at 4:12 PM" style, in the device's locale.
 *
 * Doc 41 section 3 wants `captured_at` on the row so the consumer can tell two
 * queued receipts apart. An unparseable value falls back to the raw string
 * rather than rendering "Invalid Date" at somebody.
 */
export function formatCapturedAt(isoString: string): string {
  const at = new Date(isoString);
  if (Number.isNaN(at.getTime())) return isoString;
  return at.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
