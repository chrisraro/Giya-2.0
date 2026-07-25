import { createClient } from "@/lib/supabase/server";

import type {
  BalanceDTO,
  ClaimableRewardDTO,
  ClaimDetailDTO,
  LedgerEntryDTO,
  MyClaimDTO,
} from "../types";

// Consumer-facing reads for the rewards/wallet slice. RLS is the real
// authorization boundary here (see supabase/migrations/0012_campaigns.sql
// for reward_claims/business_customers/points_transactions's P3 consumer-
// self policies, and rewards_public_select / campaigns_public_select for
// the public catalog reads) - same convention as
// src/features/campaigns/server/repo.ts. This layer issues plain
// single-table queries and joins them in application code (no PostgREST
// embedded-resource selects), matching every other repo in this codebase,
// then shapes rows into DTOs; it never widens what RLS already allows.

/**
 * Rewards a consumer can currently claim: active, non-deleted rewards whose
 * owning campaign is 'active' AND inside its schedule window. RLS
 * (rewards_public_select / campaigns_public_select) only enforces
 * is_active/status - not the starts_at/ends_at window - so that window is
 * re-checked here at the app layer, same as the promotions/rewards public
 * read comments in 0012_campaigns.sql call out.
 */
export async function listClaimableRewards(): Promise<ClaimableRewardDTO[]> {
  const supabase = await createClient();

  const { data: rewards, error } = await supabase
    .from("rewards")
    .select(
      "id, campaign_id, name, description, points_cost, remaining, per_customer_limit, business_id",
    )
    .eq("is_active", true)
    .is("deleted_at", null);

  if (error || !rewards || rewards.length === 0) return [];

  const campaignIds = Array.from(new Set(rewards.map((r) => r.campaign_id)));
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, starts_at, ends_at")
    .in("id", campaignIds)
    .eq("status", "active")
    .is("deleted_at", null);

  const now = new Date();
  const liveCampaignIds = new Set(
    (campaigns ?? [])
      .filter((c) => {
        const startsOk = !c.starts_at || new Date(c.starts_at) <= now;
        const endsOk = !c.ends_at || new Date(c.ends_at) > now;
        return startsOk && endsOk;
      })
      .map((c) => c.id),
  );

  const liveRewards = rewards.filter((r) => liveCampaignIds.has(r.campaign_id));
  if (liveRewards.length === 0) return [];

  const businessIds = Array.from(new Set(liveRewards.map((r) => r.business_id)));
  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, name, slug")
    .in("id", businessIds);
  const businessById = new Map((businesses ?? []).map((b) => [b.id, b]));

  return liveRewards.map((r) => {
    const business = businessById.get(r.business_id);
    return {
      rewardId: r.id,
      campaignId: r.campaign_id,
      name: r.name,
      description: r.description,
      pointsCost: r.points_cost,
      remaining: r.remaining,
      perCustomerLimit: r.per_customer_limit,
      businessId: r.business_id,
      businessName: business?.name ?? "",
      businessSlug: business?.slug ?? "",
    };
  });
}

/**
 * The caller's own reward claims (RLS: reward_claims_consumer_select),
 * newest first, with reward/business names resolved for display.
 */
export async function listMyClaims(): Promise<MyClaimDTO[]> {
  const supabase = await createClient();

  const { data: claims, error } = await supabase
    .from("reward_claims")
    .select("id, reward_id, business_id, status, points_spent, claimed_at, expires_at, redeemed_at")
    .order("claimed_at", { ascending: false });

  if (error || !claims || claims.length === 0) return [];

  const rewardIds = Array.from(new Set(claims.map((c) => c.reward_id)));
  const businessIds = Array.from(new Set(claims.map((c) => c.business_id)));

  const [{ data: rewards }, { data: businesses }] = await Promise.all([
    supabase.from("rewards").select("id, name").in("id", rewardIds),
    supabase.from("businesses").select("id, name").in("id", businessIds),
  ]);

  const rewardById = new Map((rewards ?? []).map((r) => [r.id, r]));
  const businessById = new Map((businesses ?? []).map((b) => [b.id, b]));

  return claims.map((c) => ({
    claimId: c.id,
    rewardId: c.reward_id,
    rewardName: rewardById.get(c.reward_id)?.name ?? "",
    businessId: c.business_id,
    businessName: businessById.get(c.business_id)?.name ?? "",
    status: c.status,
    pointsSpent: c.points_spent,
    claimedAt: c.claimed_at,
    expiresAt: c.expires_at,
    redeemedAt: c.redeemed_at,
  }));
}

/**
 * One claim by id, with reward/business names resolved. RLS scopes this to
 * claims the caller may see (their own claim, or staff of the owning
 * business); a claim outside that scope simply does not come back, so this
 * returns null both for "does not exist" and "not visible to you" -
 * indistinguishable by design (doc 13's 404 rule).
 */
export async function getClaim(claimId: string): Promise<ClaimDetailDTO | null> {
  const supabase = await createClient();

  const { data: claim } = await supabase
    .from("reward_claims")
    .select("id, reward_id, business_id, status, points_spent, claimed_at, expires_at, redeemed_at")
    .eq("id", claimId)
    .maybeSingle();

  if (!claim) return null;

  const [{ data: reward }, { data: business }] = await Promise.all([
    supabase.from("rewards").select("name").eq("id", claim.reward_id).maybeSingle(),
    supabase.from("businesses").select("name").eq("id", claim.business_id).maybeSingle(),
  ]);

  return {
    claimId: claim.id,
    rewardId: claim.reward_id,
    rewardName: reward?.name ?? "",
    businessId: claim.business_id,
    businessName: business?.name ?? "",
    status: claim.status,
    pointsSpent: claim.points_spent,
    claimedAt: claim.claimed_at,
    expiresAt: claim.expires_at,
    redeemedAt: claim.redeemed_at,
  };
}

/**
 * The caller's business_customers rows (their balance at every business
 * they have a relationship with), with business name/slug resolved.
 */
export async function getMyBalances(): Promise<BalanceDTO[]> {
  const supabase = await createClient();

  const { data: balances, error } = await supabase
    .from("business_customers")
    .select("business_id, points_balance, lifetime_points");

  if (error || !balances || balances.length === 0) return [];

  const businessIds = Array.from(new Set(balances.map((b) => b.business_id)));
  const { data: businesses } = await supabase
    .from("businesses")
    .select("id, name, slug")
    .in("id", businessIds);
  const businessById = new Map((businesses ?? []).map((b) => [b.id, b]));

  return balances.map((b) => {
    const business = businessById.get(b.business_id);
    return {
      businessId: b.business_id,
      businessName: business?.name ?? "",
      businessSlug: business?.slug ?? "",
      pointsBalance: b.points_balance,
      lifetimePoints: b.lifetime_points,
    };
  });
}

/**
 * The caller's points_transactions ledger (RLS: pt_consumer_select), newest
 * first, optionally filtered to one business.
 */
export async function listMyLedger(businessId?: string): Promise<LedgerEntryDTO[]> {
  const supabase = await createClient();

  let query = supabase
    .from("points_transactions")
    .select("id, business_id, type, points, balance_after, created_at, claim_id, campaign_id")
    .order("created_at", { ascending: false });

  if (businessId) {
    query = query.eq("business_id", businessId);
  }

  const { data, error } = await query;
  if (error || !data) return [];

  return data.map((t) => ({
    id: t.id,
    businessId: t.business_id,
    type: t.type,
    points: t.points,
    balanceAfter: t.balance_after,
    createdAt: t.created_at,
    claimId: t.claim_id,
    campaignId: t.campaign_id,
  }));
}
