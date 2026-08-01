import { notFound } from "next/navigation";

import { resolveAdminContext } from "@/features/admin/access";
import { OverviewScreen } from "@/features/admin/overview-screen";
import { loadPlatformOverview } from "@/features/admin/queue";
import { loadRoutingBreakdown } from "@/features/receipts/server/routing-stats";

// `/admin` - doc 31 §2's platform dashboard, cut to what live tables can answer.
//
// The layout above this page already 404s a non-admin. This page checks again
// anyway, and that repetition is deliberate: `src/app/design/page.tsx` records
// that a layout-only guard leaked once in this codebase, because a layout
// receives `children` already resolved. Two independent checks cost one table
// read that React's `cache` has already memoised for this request.
//
// Dynamic because every number is a live count and a cached render of the
// platform's fraud posture is the one thing this page must never serve.
export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const admin = await resolveAdminContext();
  if (admin === null) notFound();

  // Both reads are independent, and neither can fail the other: a routing
  // breakdown that could not be read renders its own "cannot read right now"
  // inside a page whose tiles are otherwise fine.
  //
  // `businessId: null` is the platform-wide call, and this is the ONLY place in
  // the codebase entitled to make it: `resolveAdminContext()` two lines above is
  // the fence, exactly as it is for every other read in `features/admin/queue.ts`.
  const [overview, routing] = await Promise.all([
    loadPlatformOverview(),
    loadRoutingBreakdown({ businessId: null }),
  ]);

  return (
    <OverviewScreen
      overview={overview}
      adminName={admin.displayName}
      now={new Date()}
      routing={routing}
    />
  );
}
