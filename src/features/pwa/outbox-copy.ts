/**
 * Every consumer-facing sentence the offline receipt outbox can say (doc 41
 * sections 3 and 9).
 *
 * They live in one module, apart from the code that decides which one applies,
 * for the same reason `src/features/receipts/receipt-copy.ts` does: each of
 * these is a PROMISE ABOUT WHETHER A RECEIPT STILL EXISTS, and a promise is
 * worth reviewing on its own, next to the other promises, without the machinery
 * around it. The tests assert them as whole strings against literals written
 * out again here, so a reworded sentence is a failing test rather than a silent
 * change of what a consumer was told.
 *
 * TWO HOUSE RULES SHAPE THE WORDING.
 *
 *  1. ZERO EM-DASHES (the constraint every design spec in docs/superpowers
 *     restates, "zero em-dashes incl. SQL/comments"). Doc 41 section 3 writes
 *     the two key sentences with one: "Saved on your phone - we'll send it when
 *     you're back online." and "Receipt uploaded - processing". T5.2 met the
 *     same conflict with doc 41's install copy and resolved it by
 *     RESTRUCTURING the sentence rather than by keeping the dash, so that is
 *     what happens here: the clause after the dash becomes its own sentence,
 *     and the claim is unchanged.
 *
 *  2. COPY NEVER ACCUSES THE CONSUMER. Losing signal is not their doing, and
 *     neither is a phone that has run out of room. Nothing here says "you did"
 *     anything; the storage sentence names the phone, not the person, and every
 *     refusal ends with the one action that actually helps.
 *
 * The refusals are the reason this module matters more than a copy file
 * usually does. When the queue cannot take a receipt, the consumer has to be
 * told THAT THE RECEIPT WAS NOT KEPT, in those words, because the alternative
 * is a person walking out of a shop believing a photo is safe when it is gone.
 */

/**
 * Shown when a capture that could not be sent WAS written to IndexedDB.
 *
 * Doc 41 section 3, restructured off its em-dash. It is the only sentence in
 * this file that says a receipt is being kept, and `enqueueCapturedReceipt`
 * returns `ok: true` on exactly the path that earns it.
 */
export const OUTBOX_SAVED_MESSAGE =
  "Saved on your phone. We will send it when you are back online.";

/**
 * The 11th capture, refused by the 10-item cap (doc 41 section 3, "Caps &
 * quota"). Verbatim from the spec, including the full stop.
 *
 * It does not say "saved" because nothing was saved, and it names the way out:
 * the queue drains and the cap lifts as soon as there is a connection.
 */
export const OUTBOX_FULL_MESSAGE = "Upload your pending receipts first.";

/**
 * `QuotaExceededError` that survived one image-cache purge and one retry.
 *
 * "did not save" first, because that is the part that changes what the consumer
 * should do next. The phone is out of room, not the person at fault.
 */
export const OUTBOX_STORAGE_FULL_MESSAGE =
  "This phone has no room left, so we did not save your receipt. Free up some space, then take the photo again.";

/**
 * IndexedDB is missing or refused to open: private windows, a browser with site
 * data blocked, a failed schema upgrade, a storage backend that throws.
 *
 * There is no in-memory consolation prize here and that is the point of this
 * whole module. A receipt held in a JavaScript variable is gone at the next
 * refresh and the consumer was told otherwise, so when the queue cannot be
 * durable the honest outcome is this sentence.
 */
export const OUTBOX_UNAVAILABLE_MESSAGE =
  "We could not save your receipt on this phone, so it was not kept. Take the photo again when you have a connection.";

/**
 * A queued receipt that the drain successfully submitted (doc 41 section 3
 * step 5, "notify the user"), restructured off its em-dash.
 */
export const OUTBOX_UPLOADED_MESSAGE = "Receipt uploaded. We are processing it now.";

/**
 * `RECEIPT_DUPLICATE` (or `IDEMPOTENCY_REPLAYED`) on replay: doc 41 section 3
 * step 4 calls this success-already-processed and asks for an informational
 * toast.
 *
 * Informational, NOT an error, and deliberately different from the capture
 * screen's "Already scanned" copy in `receipts/upload.ts`. There, a duplicate
 * means the consumer photographed a receipt they had already used and the
 * remedy is a different receipt. Here it means OUR OWN replay reached a server
 * that had already filed this exact submission, which is the idempotency
 * guard working, not a mistake anybody made.
 */
export const OUTBOX_ALREADY_SENT_MESSAGE =
  "That receipt had already reached us, so we took it off your queue.";

/**
 * A queued receipt that used up all five attempts (doc 41 section 3 step 3) and
 * now waits for the manual Retry button the queue card renders.
 */
export const OUTBOX_FAILED_MESSAGE =
  "We could not send this receipt. It is still on your phone. Tap Retry to try again.";

/**
 * A 4xx the server will answer the same way forever: the receipt was refused
 * on its merits, so the row goes and no retry is offered.
 */
export const OUTBOX_TERMINAL_MESSAGE =
  "We could not use this receipt, so we took it off your queue.";
