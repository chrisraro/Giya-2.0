import type { ReceiptRejectReason, ReceiptStatus } from "../types";

// Every consumer-facing string this slice can render, in one pure, exported,
// exhaustively-tested module. Nothing here imports React, the DB or the
// network, so the whole copy matrix is testable without rendering anything.
//
// THE RULE THAT SHAPES THIS FILE (doc 33 "Never expose fraud signal
// internals", doc 37's philosophy, and the deliberate column-level grant in
// 0017_receipts.sql that makes reject_note, parse_meta and both confidence
// scores unreadable by a client):
//
//   The consumer is told WHAT happened to their receipt. They are never told
//   which detector tripped, what score it produced, what evidence it held,
//   which other receipt matched, or whose it was. A rejection message that
//   narrows the search space is a rejection message that teaches evasion.
//
// Two consequences worth stating out loud, because both look like omissions:
//
//   1. `reject_note` is NEVER rendered, even though doc 33's copy table
//      suggests appending it for fraud_suspected/manual. It is free-text
//      reviewer commentary; a reviewer writing "same receipt as the one Ana
//      scanned at 2pm" is doing their job, and publishing that to the
//      submitter would leak another consumer. 0017 makes the column
//      unreadable by the client precisely so this cannot be done by accident,
//      and this module has no parameter that could carry it.
//
//   2. `fraud_suspected` gets NO retake call to action, unlike every other
//      recoverable reason. Inviting a retry after a fraud-family rejection
//      turns the pipeline into a feedback loop an abuser can iterate against:
//      submit, observe, adjust, resubmit. The honest path for a genuine false
//      positive is a human at the store, and that is what the copy offers.
//
// House style: zero em-dashes, sentence case, second person, no exclamation
// marks outside the award moment, no blame.

/**
 * What the status screen actually renders. Collapses the five database
 * statuses into the four outcomes doc 36's Realtime UX contract describes:
 * queued and processing are one calm waiting state to a consumer, because the
 * difference between them is an implementation detail of the queue.
 */
export type ReceiptOutcome = "pending" | "approved" | "review" | "rejected";

export function receiptOutcome(status: ReceiptStatus): ReceiptOutcome {
  switch (status) {
    case "approved":
      return "approved";
    case "review":
      return "review";
    case "rejected":
      return "rejected";
    case "queued":
    case "processing":
      return "pending";
  }
}

/**
 * True once the pipeline has reached a state it will not leave on its own.
 * `review` is terminal for the *automatic* pipeline but NOT for the screen: a
 * human can still move it to approved or rejected, so the Realtime
 * subscription stays open on it. Only approved and rejected end the watch.
 */
export function isSettledStatus(status: ReceiptStatus): boolean {
  return status === "approved" || status === "rejected";
}

/**
 * True while the automatic pipeline still owns the receipt, i.e. the window
 * in which the wallet's "Processing receipt" entry is live and an outcome is
 * expected within seconds.
 *
 * The wallet watches on THIS predicate rather than isSettledStatus: a receipt
 * sitting in `review` has already flipped to its "being reviewed" wallet
 * entry, and the human decision behind it can be up to a day away (doc 36's
 * SLA target). Holding a socket and a 5s poll open for a day to catch one
 * event would be a heartbeat, not a subscription.
 */
export function isPendingStatus(status: ReceiptStatus): boolean {
  return status === "queued" || status === "processing";
}

export interface ReceiptCopyAction {
  label: string;
  href: string;
}

export interface ReceiptOutcomeCopy {
  /** Material Symbols icon name. */
  icon: string;
  title: string;
  body: string;
  /** Primary next step, when there is an honest one. Absent by design on fraud_suspected. */
  action?: ReceiptCopyAction;
}

const RECEIPTS_HREF = "/receipts";
const SCAN_HREF = "/scan";
const WALLET_HREF = "/wallet";

/**
 * The waiting state. Deliberately has no progress bar, no percentage and no
 * estimated time: the pipeline's p95 is a target, not a promise we can make
 * to one specific consumer whose photo might be the one that needs three OCR
 * attempts. What we CAN promise honestly is that leaving the screen is safe,
 * so that is what the copy says.
 */
export function pendingCopy(status: ReceiptStatus): ReceiptOutcomeCopy {
  if (status === "queued") {
    return {
      icon: "receipt_long",
      title: "Receipt received",
      body: "We have your photo and we are getting started. You can stay here or carry on, nothing will be lost.",
    };
  }

  return {
    icon: "receipt_long",
    title: "Reading your receipt",
    body: "We are picking out the store, the date and the total. You can leave this screen, we will keep going and your points will be waiting in your wallet.",
  };
}

/**
 * Human review. Not an error, not a warning, and never phrased as one: most
 * receipts that land here are simply a little blurry or a little unusual, and
 * the consumer did nothing wrong. The expectation given matches doc 36's
 * stated SLA target (under 24h for MVP) rather than an invented number.
 */
export function reviewCopy(): ReceiptOutcomeCopy {
  return {
    icon: "hourglass_top",
    title: "The store is checking this",
    body: "Some receipts get a quick look from a person before points are added. That usually happens within a day. There is nothing you need to do, and we will update your wallet as soon as it is done.",
    action: { label: "Back to wallet", href: WALLET_HREF },
  };
}

/** The award moment. Mango is sanctioned here: this is points language (doc 16). */
export function approvedCopy(points: number | null, businessName: string | null): ReceiptOutcomeCopy {
  const where = businessName ? `your ${businessName} wallet` : "your wallet";

  if (points === null) {
    // Approved, but the ledger row has not landed in our read yet (the award
    // runs in the same transaction as the status flip, so this window is
    // small, and the poll/refresh closes it). Never guess a number.
    return {
      icon: "check_circle",
      title: "Receipt approved",
      body: `Your points are on their way to ${where}.`,
      action: { label: "Go to wallet", href: WALLET_HREF },
    };
  }

  return {
    icon: "check_circle",
    title: "Points added",
    body: `${points.toLocaleString()} ${points === 1 ? "point is" : "points are"} now in ${where}.`,
    action: { label: "Go to wallet", href: WALLET_HREF },
  };
}

/**
 * The rejection matrix. One entry per value of the `receipt_reject_reason`
 * enum, plus a fallback for a null or unrecognised reason so a rejected
 * receipt can never render with an empty explanation.
 *
 * Read the per-reason comments before editing any of these: each one is
 * balancing "tell the consumer enough to act" against "tell an abuser
 * nothing".
 */
export function rejectionCopy(reason: ReceiptRejectReason | null): ReceiptOutcomeCopy {
  switch (reason) {
    // Says plainly that the receipt is already on the account, which is the
    // one thing the consumer needs to know, and points at their history so
    // they can see it for themselves. Says nothing about HOW the duplicate
    // was detected, and never names the earlier submission or its owner: a
    // duplicate can be somebody else's receipt that this consumer
    // photographed, and confirming that would leak a stranger's activity.
    case "duplicate":
      return {
        icon: "content_copy",
        title: "Already scanned",
        body: "This receipt is already on your account. Each receipt can earn points once.",
        action: { label: "See my receipts", href: RECEIPTS_HREF },
      };

    // The only rejection that is purely a photo problem, so it gets the
    // clearest, most actionable coaching and a direct retake path.
    case "unreadable":
      return {
        icon: "image_not_supported",
        title: "We could not read this photo",
        body: "Try again in brighter light with the whole receipt flat in the frame, and make sure the total and the date are in shot.",
        action: { label: "Take another photo", href: SCAN_HREF },
      };

    // Names the mismatch without naming what we matched against. "Looks like"
    // is doing real work: the consumer may well be right and we may be wrong,
    // and scanning again from the correct store page is a genuine fix.
    case "wrong_business":
      return {
        icon: "storefront",
        title: "This looks like a different store",
        body: "This receipt does not seem to be from the store it was scanned for. Open that store's page and scan it from there, and we will take another look.",
        action: { label: "Scan again", href: SCAN_HREF },
      };

    // Deliberately does not print the exact window. It is a per-business
    // setting (receipts.max_age_days, clamp 1 to 30) that a consumer cannot
    // see and we would have to fetch just to render, and quoting a stale
    // number is worse than not quoting one. Ends on an encouraging note
    // because this is the rejection most likely to hit an honest first-timer.
    case "too_old":
      return {
        icon: "schedule",
        title: "Past the scanning window",
        body: "This receipt is older than this store accepts for points. A more recent one will still count, so do come back with your next visit.",
        action: { label: "Back to wallet", href: WALLET_HREF },
      };

    // The careful one. It does not accuse, does not mention fraud, checks,
    // scores, signals or rules, and does not offer a retake (see the header
    // note). It does offer the one legitimate remedy: a person at the store.
    case "fraud_suspected":
      return {
        icon: "info",
        title: "We could not accept this receipt",
        body: "No points were added for this one. If you think that is not right, the store can take another look at it for you.",
        action: { label: "Back to wallet", href: WALLET_HREF },
      };

    // 'manual' covers a reviewer's own rejection AND doc 36's dead-letter
    // path (three failed OCR attempts land here with an internal note the
    // consumer never sees). A retake is genuinely useful for the second case
    // and harmless for the first, so it is offered.
    case "manual":
      return {
        icon: "info",
        title: "We could not accept this receipt",
        body: "No points were added for this one. You are welcome to take a fresh photo and try again.",
        action: { label: "Take another photo", href: SCAN_HREF },
      };

    // Null or an enum value added to the database ahead of this file. Never
    // render a rejected receipt with a blank explanation.
    default:
      return {
        icon: "info",
        title: "We could not accept this receipt",
        body: "No points were added for this one. You are welcome to take a fresh photo and try again.",
        action: { label: "Take another photo", href: SCAN_HREF },
      };
  }
}

/**
 * The one-line status used in dense contexts: the wallet's pending entry and
 * each row of the receipts history. Short, complete sentences are wrong here;
 * these are labels.
 *
 * The pending label carries NO points amount, per doc 36's wallet UX contract:
 * "no points amount, the amount is unknown until parse". Promising a number
 * before the ledger has one would be the first lie the wallet ever tells.
 */
export function receiptStatusLabel(
  status: ReceiptStatus,
  rejectReason: ReceiptRejectReason | null = null,
): string {
  switch (status) {
    case "queued":
    case "processing":
      return "Processing receipt";
    case "review":
      return "Being reviewed by the store";
    case "approved":
      return "Points added";
    case "rejected":
      return rejectionCopy(rejectReason).title;
  }
}

/**
 * Tone class for a status, so the wallet and the history list agree on which
 * MD3 role each outcome wears. Returned as a name, not a class string, so
 * this module stays free of presentation details and the components keep
 * ownership of their tokens.
 */
export type ReceiptTone = "neutral" | "reward" | "waiting" | "muted";

export function receiptTone(status: ReceiptStatus): ReceiptTone {
  switch (status) {
    case "approved":
      return "reward";
    case "review":
      return "waiting";
    case "rejected":
      return "muted";
    case "queued":
    case "processing":
      return "neutral";
  }
}
