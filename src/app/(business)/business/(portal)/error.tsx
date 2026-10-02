"use client";

import { RouteError } from "@/components/shell/route-error";

// Lives in (portal), not (business), so the sidebar and topbar from
// (portal)/layout.tsx still render around it. A boundary one level up would
// replace the whole chrome and strand the owner without navigation.
export default function PortalError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} homeHref="/business/dashboard" homeLabel="Back to dashboard" />;
}
