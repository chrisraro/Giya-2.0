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

  // THIS LAYOUT IS NOT AN APPROVAL GATE, AND THAT IS DELIBERATE.
  //
  // A business nobody has approved yet - `draft`, which is what
  // `register_business` creates, or `pending_verification`, which is what
  // submitting for review sets - gets the WHOLE portal. The portal is where a
  // merchant builds its profile, menu, promos and rewards while it waits, so
  // gating it on approval would mean handing a new merchant an empty product
  // and asking them to come back in a few days. What approval actually
  // controls is the STOREFRONT, and that control is the `status = 'active'`
  // filter in src/features/businesses/server/public-repo.ts - a consumer-side
  // read, nothing to do with this file.
  //
  // WHAT USED TO BE HERE, so nobody re-derives it as a bug fix:
  //
  //   if (portal.business.status === "pending") redirect("/business/pending-approval");
  //
  // "pending" is not a status this system has. `businesses_status_check` allows
  // exactly ('draft','pending_verification','active','suspended','closed'), so
  // that branch could never fire - unapproved merchants reached the portal by
  // accident rather than by decision, and `/business/pending-approval` was
  // unreachable from here. Correcting the comparison would have locked every
  // unapproved merchant out of the product. It is deleted instead, and
  // layout.test.tsx goes red if anyone reinstates it in either spelling.
  //
  // Doc 30 section 2.8: `suspended` is the one status that does block the whole
  // portal, for every staff role. `portal.business.status` was already resolved
  // above via `resolveOwnerBusiness` (0004's staff-scoped read), so this is a
  // comparison and not a second query - the same table-truth read the
  // dashboard's verification banner relies on, just acted on here too. Like the
  // consumer layout's equivalent gate this redirect is a courtesy: the actual
  // control is `validateRedemption`'s BUSINESS_SUSPENDED refusal
  // (src/lib/auth/suspension.ts), which does not depend on this layout ever
  // rendering.
  if (portal.business.status === "suspended") {
    redirect("/suspended?type=business");
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
