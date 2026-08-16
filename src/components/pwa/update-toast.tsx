"use client";

import { motion, useReducedMotion } from "motion/react";

// The update offer (doc 41 section 7 step 3).
//
// It is an OFFER, not a warning. Nothing has gone wrong, the user has done
// nothing, and the version they are on still works - so the copy says what is
// available and lets them ignore it. "Not now" is a real, equal choice, and it
// is why this is a snackbar rather than a dialog: a dialog would stop someone
// mid-scan to tell them about a thing that can wait.
//
// This is an MD3 snackbar. There is no snackbar primitive in the codebase yet;
// rather than invent a general one on the way past, this is the single case
// that needs one, and the surface that wants a second should be the one that
// extracts it.
export function UpdateToast({
  onRefresh,
  onDismiss,
}: {
  readonly onRefresh: () => void;
  readonly onDismiss: () => void;
}) {
  const reduce = useReducedMotion();

  return (
    <motion.div
      // `polite`, not `assertive`: a screen reader user mid-sentence should
      // hear this when they pause, not instead of what they were reading.
      role="status"
      aria-live="polite"
      // Above the bottom nav (the consumer shell reserves pb-24 for it).
      className="fixed inset-x-0 bottom-24 z-50 mx-auto flex w-[min(100%-2rem,28rem)] items-center gap-3 rounded-xl bg-inverse-surface px-4 py-3 text-body-m text-inverse-on-surface shadow-lg"
      initial={reduce ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.25, ease: [0.2, 0, 0, 1] }}
    >
      <span className="flex-1">A new version of Giya is ready.</span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-full px-3 py-1.5 text-label-l font-medium text-inverse-on-surface outline-none focus-visible:ring-2 focus-visible:ring-inverse-primary"
      >
        Not now
      </button>
      <button
        type="button"
        onClick={onRefresh}
        className="rounded-full px-3 py-1.5 text-label-l font-medium text-inverse-primary outline-none focus-visible:ring-2 focus-visible:ring-inverse-primary"
      >
        Refresh
      </button>
    </motion.div>
  );
}
