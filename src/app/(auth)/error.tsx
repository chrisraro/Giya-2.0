"use client";

import { RouteError } from "@/components/shell/route-error";

// Auth pages sit under the logo-only AuthLayout, so the way back is the login
// screen rather than an app home the visitor may not be signed in to reach.
export default function AuthError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} homeHref="/login" homeLabel="Back to log in" />;
}
