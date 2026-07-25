import { redirect } from "next/navigation";

import { CampaignsManager } from "@/features/campaigns/components/campaigns-manager";
import * as repo from "@/features/campaigns/server/repo";

// Server entry point for the business portal's campaigns + earning-rule
// management screen. Resolves the caller's business the same way every
// campaigns server action does (repo.resolveOwnerBusiness - never a
// client-supplied id; see actions.ts's requireOwnerBusiness), loads the
// campaign list and the single base points rule, and hands both to
// <CampaignsManager> (client) as initial data. Mutations flow back through
// the campaigns server actions, which call revalidatePath on this route, so
// CampaignsManager reads campaigns/baseRule straight from props rather than
// mirroring them into local state - same convention as
// src/app/(business)/business/(portal)/menu/page.tsx.
export default async function BusinessCampaignsPage() {
  const business = await repo.resolveOwnerBusiness();
  if (!business) {
    redirect("/business/onboarding");
  }

  const [campaignsResult, baseRule] = await Promise.all([
    repo.listCampaigns(business.id),
    repo.getBaseRule(business.id),
  ]);

  return (
    <CampaignsManager
      business={{ id: business.id, name: business.name }}
      campaigns={campaignsResult.data ?? []}
      baseRule={baseRule}
    />
  );
}
