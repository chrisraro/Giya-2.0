"use client";

import { useOnlineStatus } from "@/hooks/use-online-status";

// WHY THE LIVE REGION IS ALWAYS MOUNTED: screen readers only announce changes
// to a live region that already exists in the DOM. A region inserted at the
// moment the connection drops is frequently skipped, so the empty wrapper
// stays and only its content comes and goes.
//
// WHY STICKY TOP: the consumer shell pins BottomNav to the bottom edge, so a
// bottom banner would fight it for the thumb zone and the safe-area inset.
// Top-sticky never overlaps it; the top inset keeps it out from under a notch.
export function OfflineBanner() {
  const isOnline = useOnlineStatus();

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 pt-[env(safe-area-inset-top)] empty:hidden"
    >
      {!isOnline && (
        <div className="bg-error-container text-on-error-container px-4 py-2 text-center text-label-s font-medium flex items-center justify-center gap-2 shadow-sm">
          <span aria-hidden className="material-symbols-rounded text-base">
            wifi_off
          </span>
          <span>You are offline. Scanned receipts will be queued in your outbox.</span>
        </div>
      )}
    </div>
  );
}
