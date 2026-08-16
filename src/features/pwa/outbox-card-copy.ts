/**
 * The queue card's own strings and the small pure decisions behind them
 * (doc 41 section 3, "User-visible queue state").
 *
 * Split out of the component so the counting, the pluralisation and the status
 * wording can be asserted without rendering anything, and so the sentences sit
 * beside `./outbox-copy.ts` rather than inside JSX.
 */

import type { OutboxStatus } from "./outbox";

/**
 * Doc 41 section 3: a persistent "N receipts waiting to upload" card.
 *
 * Singular is spelled out rather than left as "1 receipts". The card only
 * renders for a non-empty queue, so zero has no sentence; a count of zero here
 * would mean the caller rendered a card about nothing.
 */
export function outboxCardHeading(count: number): string {
  return count === 1 ? "1 receipt waiting to upload" : `${count} receipts waiting to upload`;
}

/**
 * What one row says about itself.
 *
 * `uploading` is worded as an attempt in progress rather than as a promise.
 * `failed` names the remedy, because that row is waiting on the consumer and
 * nothing will move until they tap Retry.
 */
export function outboxStatusLabel(status: OutboxStatus): string {
  if (status === "uploading") return "Sending now";
  if (status === "failed") return "Not sent yet. Tap Retry.";
  return "Waiting for a connection";
}

/**
 * The delete confirmation, which is a warning and not a question.
 *
 * Deleting a queued receipt destroys the only copy: the photo was never
 * uploaded, so there is nothing on the server to restore it from. Doc 41
 * section 8 makes the outbox the one client-side store that is not safe to
 * lose, so the second tap has to know that.
 */
export const OUTBOX_DELETE_CONFIRM_LABEL = "Tap again to delete this receipt for good";
