"use client";

import { RouteError } from "@/components/shell/route-error";

// Renders between the marketing nav and footer, so visitors keep the site's
// own navigation; the link is the landing page.
export default function MarketingError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} homeHref="/" homeLabel="Go to Giya home" />;
}
