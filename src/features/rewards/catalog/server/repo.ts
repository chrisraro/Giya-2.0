import { createClient } from "@/lib/supabase/server";

import type { CampaignRow, RewardRow } from "../types";

// Repo is the only layer in this slice that touches the Supabase client. Every
// function returns the raw `{ data, error }` shape the supabase-js query
// builder yields; service.ts turns that into the { ok } | { ok: false, message }
// contract the UI expects. RLS (supabase/migrations/0012_campaigns.sql:
// rewards_staff_select / rewards_staff_insert / rewards_staff_update, all
// converted to the table-truth helper `private.is_active_staff` by 0011) is the
// real authorization boundary; the `.eq("business_id", businessId)` scoping
// below is defense in depth, not the sole gate - same convention as
// src/features/campaigns/server/repo.ts.

export type Result<T> = { data: T | null; error: { message: string; code?: string } | null };

/**
 * The tenant's whole reward catalog, in any state (active, deactivated), newest
 * first. Soft-deleted rows are excluded: `rewards` has no delete policy, so
 * removal is a `deleted_at` stamp and a deleted reward is gone from the
 * merchant's view exactly as it is gone from the consumer's.
 */
export async function listRewards(businessId: string): Promise<Result<RewardRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rewards")
    .select("*")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  return { data, error };
}

/**
 * The tenant's campaigns, for the "which campaign does this reward belong to"
 * picker and for resolving each listed reward's parent. Archived campaigns are
 * included so an existing reward's parent still resolves for display; the
 * service layer is what refuses them as the parent of a NEW reward.
 */
export async function listCampaigns(businessId: string): Promise<Result<CampaignRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  return { data, error };
}

export async function getCampaign(
  businessId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  return data ?? null;
}

export async function getReward(businessId: string, rewardId: string): Promise<RewardRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("rewards")
    .select("*")
    .eq("id", rewardId)
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .maybeSingle();

  return data ?? null;
}

export interface InsertRewardPatch {
  campaignId: string;
  name: string;
  description: string | null;
  pointsCost: number;
  totalInventory: number | null;
  perCustomerLimit: number;
  claimExpiryDays: number;
  terms: string | null;
}

/**
 * `remaining` is seeded from `total_inventory` (null stays null = unlimited),
 * which is the invariant `claim_reward` step 2 then maintains transactionally.
 * `claim_kind` is left at its 'points' default: the other two kinds
 * ('loyalty_completion', 'granted') are minted by the loyalty wizard and by
 * engine grants, never by hand from this screen.
 */
export async function insertReward(
  businessId: string,
  patch: InsertRewardPatch,
): Promise<Result<RewardRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rewards")
    .insert({
      business_id: businessId,
      campaign_id: patch.campaignId,
      name: patch.name,
      description: patch.description,
      points_cost: patch.pointsCost,
      total_inventory: patch.totalInventory,
      remaining: patch.totalInventory,
      per_customer_limit: patch.perCustomerLimit,
      claim_expiry_days: patch.claimExpiryDays,
      terms: patch.terms,
    })
    .select()
    .single();

  return { data, error };
}

export interface UpdateRewardPatch {
  name: string;
  description: string | null;
  points_cost: number;
  total_inventory: number | null;
  remaining: number | null;
  per_customer_limit: number;
  claim_expiry_days: number;
  terms: string | null;
}

export async function updateReward(
  businessId: string,
  rewardId: string,
  patch: UpdateRewardPatch,
): Promise<Result<RewardRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rewards")
    .update(patch)
    .eq("id", rewardId)
    .eq("business_id", businessId)
    .select()
    .single();

  return { data, error };
}

export async function setRewardActive(
  businessId: string,
  rewardId: string,
  isActive: boolean,
): Promise<Result<RewardRow>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rewards")
    .update({ is_active: isActive })
    .eq("id", rewardId)
    .eq("business_id", businessId)
    .select()
    .single();

  return { data, error };
}
