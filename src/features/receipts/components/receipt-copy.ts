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

// ===========================================================================
// ESCALATION: the consumer's one way to contest a rejection
// ===========================================================================
//
// THE PROBLEM THIS CLOSES, and why it belongs in THIS file. Two of the strings
// above have been quietly dishonest since they were written. `unreadable` says
// "take another photo" and `fraud_suspected` says "the store can take another
// look at it for you", and neither was a MECHANISM: there was no action a
// consumer could take that put a rejected receipt in front of a merchant, and
// `receipts_sha_unique` (0017) is global and covers rejected rows, so the
// identical photograph could never be resubmitted. The customer this matters
// to spent PHP 500, photographed a folded receipt, and binned the paper before
// they read the rejection. They do not complain. They delete the app and tell
// the merchant at the counter.
//
// One tap now moves a rejected receipt into that merchant's review queue with
// the image attached, and the merchant decides through the same `reviewReceipt`
// service as any other approval. These are the words for it, and they live here
// rather than beside the button for the reason the header of this file gives:
// this module is the only set of consumer receipt strings, and it is the only
// one the forbidden-vocabulary sweep in receipt-copy.test.ts covers. A second
// set written next to a component would look identical on the day it was
// written and would be one careless edit away from naming the check that
// tripped.
//
// ---------------------------------------------------------------------------
// WHO MAY NOT ESCALATE, AND WHY IT IS THE WHOLE FRAUD FAMILY
// ---------------------------------------------------------------------------
// `fraud_suspected` is obvious: handing an abuser a retry loop against a human
// is precisely the "submit, observe, adjust, resubmit" iteration doc 37 warns
// about, and it is the reason the fraud_suspected copy above offers no retake
// either. The interesting one is `duplicate`, which is deterministic like
// fraud but whose most likely innocent cause - an honest double scan - is also
// the single most common real mistake a customer makes. It is excluded too, on
// three counts:
//
//   1. IT IS FRAUD FAMILY, and this codebase already says so in two places:
//      `isFraudFamilyRejectReason` in server/cooldown.ts and
//      `FRAUD_FAMILY_REASONS` in review/presenter.ts both group duplicate with
//      fraud_suspected, because both advance doc 37's strike ladder toward a
//      scanning block. A consumer rejected as duplicate has ALREADY taken a
//      strike. Splitting the family here would leave the copy module and the
//      cooldown module disagreeing about what the fraud family is, and the
//      disagreement would be invisible until someone tuned one of them.
//   2. THE HONEST DOUBLE SCAN ALREADY HAS THE MONEY. If a customer genuinely
//      scanned one receipt twice, the first scan was approved and the points
//      are in their wallet. There is nothing for a merchant to award, so the
//      escalation would buy the customer nothing and cost the merchant a
//      queue item.
//   3. IT WOULD MOSTLY FAIL AT THE DATABASE ANYWAY. A duplicate's twin is live
//      by definition, so wherever a receipt number was read, moving the
//      rejected row back into 'review' collides with `receipts_number_unique`
//      (0017, and receipt_escalation_smoke.sql test 7 proves it). An
//      affordance that mostly cannot complete is worse than no affordance.
//
// The genuine false positive - two different receipts from one shop, same
// total, photographed alike, caught by the image hash - keeps exactly the
// remedy it has today, which the fraud_suspected copy already names: a person
// at the store. That remedy is worse than a button, and it is the honest one.
//
// A NULL OR UNRECOGNISED reason IS escalatable. It falls into the generic
// bucket whose copy already offers a retake, and the direction to fail in on a
// reason nobody recorded is the one that favours the customer.

/**
 * How many escalations one consumer may have OPEN at a time.
 *
 * OPEN, not lifetime, and that distinction is the whole design. Every merchant
 * decision frees a slot and doc 36 targets under 24h for one, so this is a
 * concurrency bound on unpaid human work rather than a quota of appeals. A
 * lifetime cap would punish exactly the customer this feature exists for: the
 * one whose merchant keeps being right to approve.
 *
 * WHY THREE. One is too few: a real customer can collect two bad rejections on
 * a single afternoon at two different shops, and a cap of one would make the
 * second wait on a decision by a merchant who has nothing to do with it. Five
 * or ten is too many: the cap's job is to bound what a single scripted account
 * can put in front of a human, and three open items spread across the platform
 * is a rounding error on any one queue while still being a hard ceiling. Three
 * also survives the honest worst case a person can describe out loud, which is
 * the test a number like this should pass.
 */
export const MAX_OPEN_ESCALATIONS = 3;

/**
 * The two reasons that offer no escalation. Deliberately the same pair as
 * `FRAUD_FAMILY_REASONS` in review/presenter.ts and `isFraudFamilyRejectReason`
 * in server/cooldown.ts. Three copies of one list is two too many, and the
 * other two predate this one; unifying them is a refactor for the slice that
 * has a reason to touch the cooldown ladder, and it is recorded here as debt
 * rather than done in passing on a money path.
 */
const NOT_ESCALATABLE: ReadonlySet<string> = new Set(["duplicate", "fraud_suspected"]);

/** Whether a rejection reason may be contested. See the note above. */
export function canEscalateRejection(reason: ReceiptRejectReason | null): boolean {
  return reason === null ? true : !NOT_ESCALATABLE.has(reason);
}

/**
 * What the consumer's status screen should render about escalation.
 *
 *   unavailable  nothing to say: still processing, approved, or a rejection
 *                that is not contestable.
 *   offered      rejected, contestable, never escalated. The button.
 *   open         escalated and waiting on the merchant.
 *   closed       escalated, and the merchant rejected it again. The end of the
 *                road, said plainly.
 *
 * A receipt that was escalated and then APPROVED resolves to `unavailable`
 * rather than `closed`: the points are the answer, and a note about the appeal
 * process on top of "Points added" would be an anticlimax at the one moment
 * this product is allowed to be pleased with itself.
 */
export type EscalationState = "unavailable" | "offered" | "open" | "closed";

export function escalationState(input: {
  status: ReceiptStatus;
  rejectReason: ReceiptRejectReason | null;
  /** `receipts.escalated_at`, null on every receipt the pipeline routed itself. */
  escalatedAt: string | null;
}): EscalationState {
  if (input.escalatedAt !== null) {
    if (input.status === "review") return "open";
    return input.status === "rejected" ? "closed" : "unavailable";
  }
  if (input.status !== "rejected") return "unavailable";
  return canEscalateRejection(input.rejectReason) ? "offered" : "unavailable";
}

export interface EscalationOfferCopy {
  /** The button. */
  label: string;
  /** The line under it, explaining what tapping does. */
  body: string;
  confirmTitle: string;
  confirmBody: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * The offer.
 *
 * NO APOLOGY AND NO ACCUSATION. It does not say we got it wrong (we may not
 * have) and it does not hint that the customer might be trying something (they
 * almost certainly are not). It says what the button does and who decides,
 * because the merchant genuinely is the best-placed person: they hold the POS
 * record and they may remember the customer.
 *
 * It promises a DECISION, never an outcome. "The store will decide" is a
 * promise we can keep; "the store will add your points" is one only the store
 * can make, and making it here would turn every honest rejection into a
 * betrayal.
 */
export function escalationOfferCopy(): EscalationOfferCopy {
  return {
    label: "Ask the store to look at this",
    body: "A person at the store can open your photo and decide for themselves.",
    confirmTitle: "Send this to the store?",
    confirmBody:
      "They will see your photo and what we read from it, and decide whether to add your points. That usually happens within a day.",
    confirmLabel: "Yes, send it",
    cancelLabel: "Not now",
  };
}

/**
 * Waiting on the merchant. Deliberately NOT `reviewCopy()`, even though the
 * receipt is in the same database status: that copy says "Some receipts get a
 * quick look from a person", which is a sentence about the pipeline and reads
 * as a brush-off to somebody who just asked a question. This one says the
 * customer's own action back to them.
 */
export function escalationOpenCopy(): ReceiptOutcomeCopy {
  return {
    icon: "hourglass_top",
    title: "The store is looking at this again",
    body: "You asked them to take another look, and that usually happens within a day. There is nothing else you need to do, and we will update your wallet if points are added.",
    action: { label: "Back to wallet", href: WALLET_HREF },
  };
}

/**
 * The merchant looked again and still said no.
 *
 * Rendered ALONGSIDE `rejectionCopy(reason)` rather than instead of it, so the
 * reason keeps its own words and this module keeps one rejection matrix. It is
 * two sentences and it does not soften: a customer who has used their one
 * appeal is owed a straight answer about where they stand, and a vague one
 * would send them round the loop again looking for a button that is not there.
 */
export function escalationClosedCopy(): { title: string; body: string } {
  return {
    title: "The store looked at this again",
    body: "A person at the store went through your photo and made the call. There is no further look available for this receipt.",
  };
}

/**
 * Every way an escalation can be refused, as a sentence.
 *
 * These are the SERVER's typed refusals rendered for a person, and they live
 * here for the same reason the rest of the matrix does: the sweep. Two of them
 * are worth reading twice.
 *
 *   NOT_FOUND covers both "no such receipt" and "not yours". One sentence for
 *   both, per doc 13 and matching `getMyReceipt`: distinguishing them would
 *   turn the action into an id oracle.
 *
 *   SUPERSEDED is the `receipts_number_unique` collision, and it is the hardest
 *   sentence in this file. A live receipt at that business already claims this
 *   one's number, which is almost always the customer's own successful
 *   resubmission and is occasionally somebody else's receipt. The copy says
 *   only what is true in both cases - something else holds the claim - and
 *   sends them to their own history to see it. It names no receipt, no number
 *   and no person, and it never says "duplicate".
 */
export type EscalationRefusal =
  | "NOT_FOUND"
  | "NOT_ESCALATABLE"
  | "ALREADY_ESCALATED"
  | "LIMIT_REACHED"
  | "SUPERSEDED"
  | "UNAVAILABLE";

export function escalationRefusalCopy(refusal: EscalationRefusal): string {
  switch (refusal) {
    case "NOT_FOUND":
      return "We could not find that receipt. Open it again from your receipts list and try once more.";
    case "NOT_ESCALATABLE":
      return "This one cannot be sent to the store from here. If you think that is not right, the store can still take a look at it for you in person.";
    case "ALREADY_ESCALATED":
      return "You have already sent this one to the store. They will make the call and your wallet will update if points are added.";
    case "LIMIT_REACHED":
      return "You already have three receipts waiting with stores. Once they have answered one of those, you can send this one too.";
    case "SUPERSEDED":
      return "This receipt cannot go back to the store, because another scan from the same store has already taken its place. Have a look at your receipts list.";
    case "UNAVAILABLE":
      return "We could not send this to the store just now. Try again in a moment.";
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
 *
 * `escalated` is optional and defaults to false, so every existing caller keeps
 * its exact label. It only ever changes the `review` line, and only to say the
 * customer's own action back to them: a row that reads "Being reviewed by the
 * store" gives no hint that the reader is the reason it is there, which in a
 * list of twelve receipts is the difference between finding the one they
 * appealed and scrolling past it.
 */
export function receiptStatusLabel(
  status: ReceiptStatus,
  rejectReason: ReceiptRejectReason | null = null,
  escalated = false,
): string {
  switch (status) {
    case "queued":
    case "processing":
      return "Processing receipt";
    case "review":
      return escalated ? "The store is looking at this again" : "Being reviewed by the store";
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
