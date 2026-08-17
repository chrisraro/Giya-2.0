import { redirect } from "next/navigation";

import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { MetaCampaignComposer } from "@/features/integrations/meta/components/meta-campaign-composer";
import { MetaInsightsPanel } from "@/features/integrations/meta/components/meta-insights-panel";
import { BUSINESS_MARKETING_ROLES } from "@/features/integrations/meta/roles";
import { loadPublishView } from "@/features/integrations/meta/server/capability";
import { loadInsightsView } from "@/features/integrations/meta/server/insights";

// /business/marketing - doc 32 section 11, the marketing and analytics hub.
//
// TENANCY: `resolveStaffContext` resolves the caller's business and role from
// `business_staff` under the caller's own session, and that id is the only one
// that reaches a query. This route has no segment and no parameter, so there is
// nothing here for a forged value to point at.
//
// -----------------------------------------------------------------------------
// THIS PAGE HAS NO APPROVAL GATE, AND THAT IS THE POINT
// -----------------------------------------------------------------------------
//
// A business at `draft` or `pending_verification` reaches this screen and sees
// its Facebook figures, exactly as it reaches every other portal screen. That
// is the portal-wide posture the layout above already takes (see its header),
// and it matters more here than elsewhere: connecting a Page, reading audience
// numbers and drafting an announcement are the things a merchant DOES while
// waiting for approval. Gating them on approval hands a new merchant an empty
// product and asks them to come back in a few days.
//
// What approval actually controls is the STOREFRONT, and that control is the
// `status = 'active'` filter in features/businesses/server/public-repo.ts, a
// consumer-side read with nothing to do with this file.
//
// So there is deliberately no `status` comparison below, and marketing/
// page.test.tsx goes red if one is added.
//
// -----------------------------------------------------------------------------
// WHY THE TWO READS CANNOT TAKE THE SCREEN DOWN
// -----------------------------------------------------------------------------
//
// Both are non-throwing by contract (see their headers) and both answer with a
// state rather than an exception. Doc 42: a Meta outage makes the insights
// tiles "show 'reconnect' state; never blocks core loops". A marketing screen
// that 500s because Facebook is having an afternoon would be exactly that.
export const dynamic = "force-dynamic";

export default async function BusinessMarketingPage() {
  const context = await resolveStaffContext(BUSINESS_MARKETING_ROLES);
  if (context === null) {
    // The portal layout already turned away non-members. Reaching here means
    // an active member whose role is outside doc 32 section 11.1's audience,
    // which today is the `staff` counter seat.
    redirect("/business/dashboard");
  }

  // Sequential rather than concurrent, on purpose. Both go through
  // `readGrantedScopes`, which is memoized per request: running them in
  // parallel would start two debug_token calls for the same connection before
  // either populated the cache, doubling the traffic through a circuit breaker
  // that opens after five consecutive failures.
  const insights = await loadInsightsView({ businessId: context.businessId });
  const publish = await loadPublishView({
    businessId: context.businessId,
    canManage: true,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-headline-s text-on-surface">Marketing</h1>
        <p className="text-body-m text-on-surface-variant">
          Your Facebook figures, and announcements you choose to post.
        </p>
      </div>

      <MetaInsightsPanel view={insights} />
      <MetaCampaignComposer view={publish} />
    </div>
  );
}
