"use client";

import { RouteError } from "@/components/shell/route-error";

// The OUTER business boundary. (portal)/error.tsx keeps the sidebar and topbar
// around page errors, but a boundary never catches its own segment's layout -
// and (portal)/layout.tsx now throws when the membership or business read
// fails (a failed read is an error, not "no membership"). Without this file
// those throws fell straight through to global-error.tsx.
//
// Links to sign-in, not the dashboard: the dashboard is behind the very layout
// that just failed, so sending the owner there would loop them into it.
export default function BusinessError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} homeHref="/business/login" homeLabel="Back to sign in" />;
}
