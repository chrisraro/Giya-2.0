"use client";

import { motion, useReducedMotion } from "motion/react";

import { useOnlineStatus } from "@/hooks/use-online-status";

// The global connectivity pill (doc 41 section 9).
//
// One pill, mounted once in the consumer layout, driven by the single
// `useOnlineStatus()` hook. Screens do not invent their own connectivity
// banners; the two exceptions doc 41 names (the wallet staleness banner and
// the outbox card) are both T5.3's and both say something this pill cannot.
//
// It is a notice, not an alarm: `role="status"`/`aria-live="polite"`, no
// buttons, nothing to dismiss, and a neutral inverse-surface tonal chip rather
// than the error container it used to wear. Losing signal is not an error and
// is not the consumer's doing, and painting it red says otherwise.
export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const reduce = useReducedMotion();

  if (isOnline) return null;

  return (
    <motion.div
      role="status"
      aria-live="polite"
      // Fixed and centred at the top, above the content but clear of the
      // bottom nav and of UpdateToast (which owns `bottom-24`). `w-fit` and
      // `pointer-events-none` keep it literally non-blocking: it covers as
      // little as the sentence needs and cannot swallow a tap meant for the
      // page underneath.
      className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-2 rounded-full bg-inverse-surface px-4 py-2 text-label-m text-inverse-on-surface shadow-md"
      initial={reduce ? false : { opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.2, ease: [0.2, 0, 0, 1] }}
    >
      <span aria-hidden className="material-symbols-rounded text-base">
        wifi_off
      </span>
      {/*
        EVERY CLAIM IN THIS SENTENCE MUST BE TRUE AT THE MOMENT IT SHIPS.

        HISTORY, BECAUSE IT IS THE POINT. It once read "You are offline.
        Scanned receipts will be queued in your outbox." Nothing enqueued:
        `src/features/pwa/outbox.ts` had no callers, so that sentence told a
        consumer their basement scan was safe when it was not. T5.2 cut it back
        to the two things T5.1 had actually shipped and named T5.3 as the task
        allowed to widen it, "only once the enqueue call it describes exists".

        THAT CALL NOW EXISTS. `receipt-capture.tsx` sends a capture that failed
        for want of a connection to `enqueueCapturedReceipt`, which either
        writes it to IndexedDB or refuses and says so. The second clause is
        earned, and offline-banner.test.tsx drives that whole flow rather than
        taking this comment's word for it.

        WHAT IS CLAIMED, AND WHY EACH PART SURVIVES EVERY PATH:

          "Pages saved on this device still work" - the NetworkFirst pages route
          (src/lib/pwa/runtime-caching.ts, row 1) answers a navigation from
          Cache Storage when the network does not. Not "your cards and rewards":
          a page never opened here, or not opened since the last deploy (cache
          names carry the build id), is not saved and falls through to /offline.

          "queued receipts are still on this phone" - a statement about the rows
          that ARE in the outbox, in the present tense. It survives the two
          paths where an enqueue is refused, because a capture the 10-item cap
          or a full disk turned away never became a queued receipt and nothing
          here speaks for it; those refusals do their own telling, on the scan
          screen, in the words in features/pwa/outbox-copy.ts.

        WHAT IS DELIBERATELY NOT CLAIMED. Not "safe", and nothing in the future
        tense. Doc 41 section 8 is explicit that iOS can evict the outbox after
        about seven days of Safari non-use, and that "if eviction still claims
        the outbox, the receipt is gone and we never pretend otherwise". A pill
        promising safety would be pretending otherwise.
      */}
      {/* `&apos;` (U+0027) not `&rsquo;`, matching the rest of the app's JSX
          copy - the escape is react/no-unescaped-entities, not typography. */}
      <span>
        You&apos;re offline. Pages saved on this device still work, and queued receipts are still on
        this phone.
      </span>
    </motion.div>
  );
}
