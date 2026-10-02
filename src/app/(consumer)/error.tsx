"use client";

import { RouteError } from "@/components/shell/route-error";

// Renders inside (consumer)/layout.tsx, so the bottom nav stays mounted and a
// consumer is one tap from anywhere. Errors thrown by the layout itself fall
// through to global-error.tsx, as Next specifies.
export default function ConsumerError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} homeHref="/home" homeLabel="Back to home" />;
}
