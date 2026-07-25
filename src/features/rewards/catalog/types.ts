import type { Database } from "@/lib/supabase/types";

// DTOs for the business-side rewards catalog. Mirrors
// src/features/campaigns/server/types.ts's ActionResult contract so every
// server action in the app returns the same shape.

export type RewardRow = Database["public"]["Tables"]["rewards"]["Row"];
export type CampaignRow = Database["public"]["Tables"]["campaigns"]["Row"];

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; message: string; code?: string };

/**
 * The campaign a reward hangs off, reduced to what the catalog screen needs.
 * `claimable` answers the only question the merchant actually cares about:
 * can a customer claim a reward on this campaign right now, per the combined
 * status + schedule-window guard at the top of `claim_reward`.
 */
export interface CampaignOption {
  id: string;
  name: string;
  type: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  /** True when `claim_reward`'s campaign guard would pass at `asOf`. */
  claimable: boolean;
  /**
   * True when the campaign can never host a claimable reward again: an ended
   * or archived campaign (both terminal per the lifecycle engine) or one whose
   * schedule window has already closed. Such campaigns are refused as parents.
   */
  terminal: boolean;
}

/** One row of the merchant's reward catalog list. */
export interface RewardCatalogItem {
  id: string;
  campaignId: string;
  name: string;
  description: string | null;
  pointsCost: number;
  claimKind: string;
  totalInventory: number | null;
  remaining: number | null;
  perCustomerLimit: number;
  claimExpiryDays: number;
  terms: string | null;
  isActive: boolean;
  createdAt: string;
  campaign: CampaignOption | null;
}
