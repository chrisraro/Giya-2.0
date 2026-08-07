import Link from "next/link";
import { EmptyState } from "@/components/consumer/empty-state";

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 py-12 text-center">
      <EmptyState
        icon="wifi_off"
        title="You're Offline"
        body="It looks like you don't have an active internet connection right now. Don't worry, your offline cached pages are still available."
      />
      <div className="mt-6 flex gap-3">
        <Link
          href="/home"
          className="rounded-full bg-primary px-6 py-2.5 text-label-m text-on-primary font-medium hover:opacity-90 transition-opacity"
        >
          Try Again
        </Link>
      </div>
    </main>
  );
}
