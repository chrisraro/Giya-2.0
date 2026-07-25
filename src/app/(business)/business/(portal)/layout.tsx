import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { PortalShell } from "@/components/business/portal-shell";
import { initialsOf, resolvePortalContext } from "@/features/businesses/server/portal-context";
import { resolveReviewerContext } from "@/features/receipts/review/access";
import { countPendingReview } from "@/features/receipts/review/queue";
import { createClient } from "@/lib/supabase/server";

// Dashboard chrome (sidebar + topbar) for every /business/* portal page
// EXCEPT onboarding, which lives outside this nested group and stays
// chrome-free. Stays a server component; PortalShell is the client glue
// that owns the shared mobile drawer state.
//
// Membership enforcement lives here, not in middleware (doc 12: claims are
// hints, tables are truth). middleware.ts only checks for a session; this
// layout is the authoritative gate, resolving the caller's business from
// `business_staff` directly so it is correct even before the custom access
// token hook stamps biz claims into a user's JWT (or if the hook isn't
// enabled at all).
//
// The resolution itself is `resolvePortalContext`, which delegates to the
// shared `resolveOwnerBusiness` (migration 0004's business_staff self-select
// policy is what lets a signed-in user read their own membership rows). This
// layout used to query `business_staff` inline; it no longer does, because the
// dashboard page under it needs the same answer and two independent membership
// queries in one request are two chances to disagree about the tenant.
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Belt and braces: middleware already redirects unauthenticated users
    // away from portal routes, but a server component rendering business
    // data should not rely on that alone.
    redirect("/login");
  }

  // Null here means "signed in, but no active membership" (the no-session case
  // was already handled above), which is exactly the onboarding condition.
  const portal = await resolvePortalContext();
  if (portal === null) {
    redirect("/business/onboarding");
  }

  // The sidebar's Receipts badge (doc 36 Stage 9: the queue-age and backlog
  // are surfaced portal-wide, not just on the queue screen).
  //
  // `resolveReviewerContext` returns null for an active member whose role
  // cannot review receipts (marketing, staff), and the badge is simply absent
  // for them. It is memoized per request, so the page underneath this layout
  // reuses this resolution rather than repeating the session round trip.
  //
  // `countPendingReview` answers null when it could not read the count, and
  // that is passed straight through rather than flattened to 0: the Sidebar
  // renders no badge for null, because a badge is a number people act on and a
  // stale or invented one is worse than none. The queue screen is where the
  // failure is explained.
  const reviewer = await resolveReviewerContext();
  const pendingReviewCount =
    reviewer === null ? null : await countPendingReview(reviewer.businessId);

  return (
    <PortalShell
      pendingReviewCount={pendingReviewCount}
      userName={portal.displayName}
      userInitials={initialsOf(portal.displayName)}
      businessName={portal.business.name}
    >
      {children}
    </PortalShell>
  );
}
