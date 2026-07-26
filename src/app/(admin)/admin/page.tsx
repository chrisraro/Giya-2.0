import { notFound } from "next/navigation";

import { resolveAdminContext } from "@/features/admin/access";
import { OverviewScreen } from "@/features/admin/overview-screen";
import { loadPlatformOverview } from "@/features/admin/queue";

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

  const overview = await loadPlatformOverview();

  return <OverviewScreen overview={overview} adminName={admin.displayName} now={new Date()} />;
}
