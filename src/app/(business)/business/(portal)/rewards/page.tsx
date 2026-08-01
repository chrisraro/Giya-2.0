import { redirect } from "next/navigation";

import { EmptyState } from "@/components/consumer/empty-state";
import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { REWARD_CATALOG_ROLES } from "@/features/rewards/catalog/roles";
import { RewardsManager } from "@/features/rewards/catalog/components/rewards-manager";
import { loadCatalog } from "@/features/rewards/catalog/server/service";

// /business/rewards - the merchant's reward catalog (doc 32 section 9.3).
//
// The consumer half of this domain has shipped for a while: `claim_reward`
// (supabase/migrations/0013_reward_claim_rpcs.sql) and the wallet screens both
// exist. This page is the missing half - until it landed, a merchant had no way
// to create anything for a customer to claim.
//
// TENANCY: `resolveStaffContext` reads the caller's business and role from
// `business_staff` under the caller's OWN session. Nothing on this route can
// name a business - there is no segment, no query parameter, and no form field
// that carries one.
export const dynamic = "force-dynamic";

export default async function BusinessRewardsPage() {
  const context = await resolveStaffContext(REWARD_CATALOG_ROLES);
  if (context === null) {
    // The portal layout has already sent anyone without an active membership to
    // onboarding, so reaching here means an active member whose role cannot
    // manage rewards (doc 01 matrix "Manage reward catalog": owner, manager,
    // marketing - `staff` is excluded).
    redirect("/business/dashboard");
  }

  const catalog = await loadCatalog(context.businessId);

  // A failed read is not an empty catalog. Rendering RewardsManager with zero
  // rewards would tell the merchant "you have no rewards", which is a different
  // and possibly false statement - the same distinction menu/page.tsx makes.
  if (!catalog.ok || !catalog.data) {
    return (
      <EmptyState
        icon="error"
        title="Could not load your rewards"
        body="Refresh to try again."
      />
    );
  }

  const { rewards, campaigns, earningRule } = catalog.data;

  return (
    <RewardsManager
      businessName={context.businessName}
      rewards={rewards}
      availableCampaigns={campaigns.filter((campaign) => !campaign.terminal)}
      earningRule={earningRule}
    />
  );
}
