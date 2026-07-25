import type { Database } from "@/lib/supabase/types";

// DTOs and shared result types for the rewards feature's server layer
// (repo/service/actions). Mirrors src/features/campaigns/server/types.ts's
// ActionResult contract so every server action in the app returns the same
// { ok } | { ok: false, message, code? } shape.

export type RewardRow = Database["public"]["Tables"]["rewards"]["Row"];
export type RewardClaimRow = Database["public"]["Tables"]["reward_claims"]["Row"];
export type BusinessCustomerRow = Database["public"]["Tables"]["business_customers"]["Row"];
export type PointsTransactionRow = Database["public"]["Tables"]["points_transactions"]["Row"];

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; message: string; code?: string };

// A reward a consumer can currently claim: an active, non-deleted reward
// belonging to a campaign that is active and inside its schedule window
// (the window check is not expressible in RLS alone - see
// server/repo.ts:listClaimableRewards).
export interface ClaimableRewardDTO {
  rewardId: string;
  campaignId: string;
  name: string;
  description: string | null;
  pointsCost: number;
  remaining: number | null;
  perCustomerLimit: number;
  businessId: string;
  businessName: string;
  businessSlug: string;
}

// A row from the caller's own reward_claims, with the reward/business
// names resolved for display.
export interface MyClaimDTO {
  claimId: string;
  rewardId: string;
  rewardName: string;
  businessId: string;
  businessName: string;
  status: string;
  pointsSpent: number;
  claimedAt: string;
  expiresAt: string;
  redeemedAt: string | null;
}

// getClaim's DTO additionally carries consumerId: RLS on reward_claims is a
// UNION of reward_claims_consumer_select (consumer_id = auth.uid()) and
// reward_claims_staff_select (staff of the business), so a row returned by
// getClaim is not necessarily the caller's own claim. Callers that must be
// scoped to the claim owner only (e.g. the mint-token route, doc 35 s12)
// need consumerId to check that themselves - see
// src/features/rewards/server/claim-ownership.ts.
export interface ClaimDetailDTO extends MyClaimDTO {
  consumerId: string;
}

// One of the caller's business_customers rows (their balance at one
// business), with the business name/slug resolved for display.
export interface BalanceDTO {
  businessId: string;
  businessName: string;
  businessSlug: string;
  pointsBalance: number;
  lifetimePoints: number;
}

// One row of the caller's points_transactions ledger.
export interface LedgerEntryDTO {
  id: string;
  businessId: string;
  type: string;
  points: number;
  balanceAfter: number;
  createdAt: string;
  claimId: string | null;
  campaignId: string | null;
}
