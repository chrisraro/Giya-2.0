"use client";

import { useOnlineStatus } from "@/hooks/use-online-status";

export function OfflineBanner() {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-error-container text-on-error-container px-4 py-2 text-center text-label-s font-medium flex items-center justify-center gap-2 shadow-sm"
    >
      <span aria-hidden className="material-symbols-rounded text-base">
        wifi_off
      </span>
      <span>You are offline. Scanned receipts will be queued in your outbox.</span>
    </div>
  );
}
