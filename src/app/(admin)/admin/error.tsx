"use client";

import { RouteError } from "@/components/shell/route-error";

// Renders inside the admin layout, so the AdminShell chrome (and its gate)
// stays in place around the failure.
export default function AdminError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} homeHref="/admin" homeLabel="Back to admin home" />;
}
