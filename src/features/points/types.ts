// Pure domain types for the points engine (docs/30-modules/35-points-engine.md).
// Rule fields mirror the points_rules columns in
// docs/20-data/23-schema-campaigns.md (snake_case, as loaded from the DB);
// compute input/output use camelCase like the rest of the app layer.
// This module is IO-free: no server, DB, or React imports anywhere in
// src/features/points/{types,conditions,compute}.ts.

export type RuleKind = "base" | "multiplier" | "bonus";

export type RuleType =
  | "amount_rate"
  | "fixed_per_visit"
  | "fixed_per_receipt"
  | "tiered_amount";

// floor = house default (round down), round = half-up, ceil = promotional.
export type RoundingMode = "floor" | "round" | "ceil";

// One tier of a tiered_amount rule. maxCentavos null = open-ended top tier.
// A receipt amount matches the tier when
// minCentavos <= amount and (maxCentavos is null or amount <= maxCentavos).
export interface RuleTier {
  minCentavos: number;
  maxCentavos: number | null;
  points: number;
}

// Conditions DSL (all keys optional; present keys AND together; {} = always).
// Validated by ruleConditionsSchema in ./conditions.ts.
export interface RuleConditions {
  days?: number[]; // ISO weekdays, 1 = Monday .. 7 = Sunday
  time_from?: string; // "HH:MM" wall clock, inclusive
  time_to?: string; // "HH:MM" wall clock, exclusive; from > to spans midnight
  min_amount_centavos?: number; // total_centavos >= value
  birthday?: boolean; // true gates on visit context isBirthday
  first_visit?: boolean; // true gates on visit context isFirstVisit
}

// A points rule row (subset of points_rules relevant to computation).
// Which value fields are meaningful depends on rule_type / kind:
//   amount_rate       -> rate_centavos_per_point
//   fixed_per_visit   -> fixed_points
//   fixed_per_receipt -> fixed_points
//   tiered_amount     -> tiers
//   kind=multiplier   -> multiplier (e.g. 2 for a 2x campaign)
//   kind=bonus        -> bonus_points
export interface PointsRule {
  id?: string;
  kind: RuleKind;
  rule_type: RuleType;
  rate_centavos_per_point?: number;
  fixed_points?: number;
  tiers?: RuleTier[];
  multiplier?: number;
  bonus_points?: number;
  conditions?: RuleConditions;
  rounding: RoundingMode;
}

// Visit-level facts the engine cannot derive from the receipt alone; the
// caller (award pipeline or preview) resolves them from customer state.
export interface VisitContext {
  isFirstVisit?: boolean;
  isBirthday?: boolean;
}

export interface ComputePointsInput {
  amountCentavos: number;
  receiptDate: Date;
  // IANA timezone the receipt's wall clock is evaluated in, e.g. "Asia/Manila".
  businessTimezone: string;
  baseRule: PointsRule;
  // Multiplier/bonus rules already pre-filtered by the caller for campaign
  // liveness, audience, and budget (34-campaign-engine.md); this pure engine
  // only evaluates each rule's conditions DSL.
  candidateRules: PointsRule[];
  visitContext?: VisitContext;
}

export interface PointsBreakdown {
  basePoints: number;
  effectiveMultiplier: number;
  multipliedBase: number;
  bonusPoints: number;
  total: number;
}

export interface PointsResult {
  // Final integer award, always >= 0.
  points: number;
  breakdown: PointsBreakdown;
  // Frozen record of the applied rules ("every write is explainable").
  ruleSnapshot: unknown;
}
