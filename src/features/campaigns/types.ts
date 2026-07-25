// Pure domain types for the campaign lifecycle engine
// (docs/30-modules/34-campaign-engine.md). This module is IO-free: no
// server, DB, or React imports anywhere in src/features/campaigns/
// {types,lifecycle}.ts. Shapes use camelCase like the rest of the app
// layer; loaders map DB snake_case columns into these.

// Exactly the campaign_status enum (doc 34 section 2).
export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "active"
  | "paused"
  | "ended"
  | "archived";

// The 10 campaign types (doc 34 section 1 mapping table / section 7).
export type CampaignType =
  | "promotion"
  | "discount"
  | "seasonal"
  | "holiday"
  | "event"
  | "reward"
  | "loyalty"
  | "membership"
  | "birthday"
  | "referral";

// Transition triggers, one per doc 34 transition family:
//   schedule   T1 draft -> scheduled
//   activate   T2 draft -> active, T3 scheduled -> active
//   unschedule T4 scheduled -> draft
//   pause      T5 active -> paused
//   resume     T6 paused -> active
//   end        T7 active|paused -> ended
//   archive    T8 draft|ended -> archived
// T9 "duplicate" is not a transition of the source row (new draft row),
// so it is intentionally not a CampaignAction.
export type CampaignAction =
  | "schedule"
  | "activate"
  | "unschedule"
  | "pause"
  | "resume"
  | "end"
  | "archive";

// campaigns.budget JSONB, camelCased. All keys optional; absent = unlimited.
// Doc 34 section 5: every present key must be a positive integer.
export interface CampaignBudget {
  maxTotalPoints?: number;
  maxRedemptions?: number;
  perCustomerLimit?: number;
}

// Lightweight campaign shape: only the columns the pure engine reads.
// startsAt/endsAt are absolute instants (timestamptz stored UTC); timezone
// is the interpretation zone for wall-clock input and recurrence [V1].
export interface Campaign {
  id?: string;
  type: CampaignType;
  status: CampaignStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
  budget: CampaignBudget;
}

// Presence summary of the type-specific payload rows, resolved by the
// caller (service layer) from the DB. The pure gate G2 only checks these
// booleans/counts against the type -> payload mapping; row-internal
// validity (e.g. percent_off set for percent_off offers) is enforced by
// the payload schemas at save time.
export interface PayloadPresence {
  hasPromotion: boolean;
  rewardCount: number;
  hasLoyaltyProgram: boolean;
  hasLoyaltyPrize: boolean;
  pointsRuleCount: number;
}

// Minimal business standing shape for gate G1.
export interface Business {
  status: string;
}

export interface GateFailure {
  code: string;
  message: string;
}

export interface GateResult {
  ok: boolean;
  failures: GateFailure[];
}
