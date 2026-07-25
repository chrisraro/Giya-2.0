import { notFound } from "next/navigation";

import { RedemptionQr } from "@/features/rewards/components/redemption-qr";
import { assertClaimOwner } from "@/features/rewards/server/claim-ownership";
import { getClaim } from "@/features/rewards/server/repo";
import { createClient } from "@/lib/supabase/server";

type PageParams = { claimId: string };

/**
 * Server entry point for the redemption QR screen. Pre-loads the claim via
 * repo.getClaim and 404s for anything that isn't "this exact signed-in
 * consumer's own claim" - reward_claims RLS is a UNION of the consumer-self
 * and staff-of-business select policies (0012_campaigns.sql), so getClaim
 * alone does not prove ownership; this page reuses the same
 * assertClaimOwner predicate the token-mint API route enforces (doc 35 s12),
 * and answers the same generic 404 for "doesn't exist" and "exists but
 * isn't yours" alike (doc 13). Actual minting happens client-side in
 * <RedemptionQr> against that same route.
 */
export default async function RedemptionQrPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { claimId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const claim = await getClaim(claimId);
  if (!claim || !assertClaimOwner(claim, user.id)) notFound();

  return <RedemptionQr claim={claim} />;
}
