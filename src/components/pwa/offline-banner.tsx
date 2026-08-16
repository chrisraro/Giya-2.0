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
        It is deliberately narrower than doc 41's eventual offline story, and
        that is not an oversight.

        It used to read "You are offline. Scanned receipts will be queued in
        your outbox." Nothing enqueues: `src/features/pwa/outbox.ts` has no
        callers, so that sentence promised a consumer their basement scan was
        safe when it was not. T5.3 is the task that builds the outbox and the
        wallet snapshot; T5.3 IS ALSO THE TASK THAT MAY WIDEN THIS STRING, and
        only once the enqueue call it describes exists.

        What is true today, and all that is claimed: the connection is down,
        and the NetworkFirst pages route (src/lib/pwa/runtime-caching.ts, row
        1) answers a navigation from Cache Storage when the network does not.
        "Pages saved on this device" rather than "your cards and rewards"
        because a page never opened here - or not opened since the last deploy,
        as cache names carry the build id - is not saved, and falls through to
        /offline.
      */}
      {/* `&apos;` (U+0027) not `&rsquo;`, matching the rest of the app's JSX
          copy - the escape is react/no-unescaped-entities, not typography. */}
      <span>You&apos;re offline. Pages saved on this device still work.</span>
    </motion.div>
  );
}
