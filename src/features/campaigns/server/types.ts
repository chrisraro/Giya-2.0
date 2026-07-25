import type { Database } from "@/lib/supabase/types";
import type { PayloadPresence } from "../types";

// DTOs for the server layer (repo/service/actions). Deliberately separate
// from src/features/campaigns/types.ts, which is the pure lifecycle
// engine's IO-free domain-types module (see that file's header comment: "no
// server, DB, or React imports"); these types import the generated DB
// schema, so they live here instead.

export type CampaignRow = Database["public"]["Tables"]["campaigns"]["Row"];
export type PromotionRow = Database["public"]["Tables"]["promotions"]["Row"];
export type RewardRow = Database["public"]["Tables"]["rewards"]["Row"];
export type LoyaltyProgramRow = Database["public"]["Tables"]["loyalty_programs"]["Row"];
export type PointsRuleRow = Database["public"]["Tables"]["points_rules"]["Row"];

// Light payload summary attached to each row returned by listCampaigns, so
// the campaigns list UI can show "payload incomplete" affordances without a
// second round trip per row.
export type CampaignSummary = CampaignRow & {
  payloadPresence: PayloadPresence;
};

export type ActionResult<T = undefined> =
  | { ok: true; data?: T }
  | { ok: false; message: string; code?: string };
