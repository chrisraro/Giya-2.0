import { redirect } from "next/navigation";

import { resolveReviewerContext } from "@/features/receipts/review/access";
import {
  countPendingReview,
  defaultReviewQueueDeps,
  isReviewQueueStatus,
  listReviewQueue,
} from "@/features/receipts/review/queue";
import { ReviewQueueScreen } from "@/features/receipts/review/queue-screen";
import type { ReviewQueueStatus } from "@/features/receipts/review/types";

// /business/receipts - the tenant's receipt review queue (doc 32 route
// inventory, doc 36 Stage 9 "Human review queue", spec section 5).
//
// TENANCY, in one paragraph, because this page is the entry point to every
// service-role read in the slice: `resolveReviewerContext()` resolves the
// caller's business from `business_staff` under the caller's OWN session, and
// that id is the only one passed downward. The `?status=` parameter is
// caller-supplied and is validated against the three-value union before it
// reaches a query; it selects a filter, never a tenant. There is no route
// segment or query parameter anywhere on this page that can name a business.
//
// Dynamic because every read is per-caller and per-session; a cached render of
// one tenant's queue is the one thing this page must never produce.
export const dynamic = "force-dynamic";

type SearchParams = { status?: string | string[] };

function readStatus(params: SearchParams): ReviewQueueStatus {
  const raw = Array.isArray(params.status) ? params.status[0] : params.status;
  return raw !== undefined && isReviewQueueStatus(raw) ? raw : "review";
}

export default async function BusinessReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const reviewer = await resolveReviewerContext();
  if (reviewer === null) {
    // The portal layout has already sent anyone without an active membership
    // to onboarding, so reaching here means an active member whose role cannot
    // review receipts (doc 32 section 13: owner and manager only).
    redirect("/business/dashboard");
  }

  const status = readStatus(await searchParams);

  // One deps object for both reads, so a missing service-role key is detected
  // once and rendered as "cannot load" rather than as an empty queue.
  const deps = defaultReviewQueueDeps();

  const [items, pendingCount] = await Promise.all([
    listReviewQueue(
      { businessId: reviewer.businessId, status, viewerId: reviewer.userId },
      deps,
    ),
    countPendingReview(reviewer.businessId, deps),
  ]);

  return (
    <ReviewQueueScreen
      businessName={reviewer.businessName}
      status={status}
      items={items}
      pendingCount={pendingCount}
      now={new Date()}
      unavailable={deps === null}
    />
  );
}
