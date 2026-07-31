// ===========================================================================
// The merchant activation lifecycle, as the types every layer of it shares.
//
// Migration 0033 is the authority on this lifecycle and these types are its
// shadow: `draft -> pending_verification -> active`, with a rejection returning
// the tenant to `draft` and a `business_verifications` round recording each
// decision. Nothing here invents a state the database cannot hold.
// ===========================================================================

/** `businesses.status`, 0002's check constraint, verbatim. */
export const BUSINESS_STATUSES = [
  "draft",
  "pending_verification",
  "active",
  "suspended",
  "closed",
] as const;

export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export function isBusinessStatus(value: string): value is BusinessStatus {
  return (BUSINESS_STATUSES as readonly string[]).includes(value);
}

/** `business_verifications.status`, 0002's check constraint, verbatim. */
export type VerificationRoundStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "revision_requested";

/**
 * One review round, as the merchant's own screens read it.
 *
 * `decisionReason` is the admin's text and it is shown to the merchant
 * VERBATIM (doc 32 section 2.2). That is a deliberate difference from the fraud
 * ladder, whose reasons stay in `audit_logs` because they can name other
 * tenants; a verification decision is a message TO this merchant and useless
 * anywhere else.
 */
export interface VerificationRound {
  id: string;
  status: VerificationRoundStatus;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/**
 * The shape of a base earning rule, reduced to the fields that decide whether
 * it can award anything.
 *
 * Deliberately structural rather than the full `points_rules` row: the only
 * question this domain asks of a rule is "would this award a number", and
 * `isUsableBaseRule` in ./presenter.ts is the one place that answers it.
 */
export interface BaseRuleShape {
  rule_type: string;
  rate_centavos_per_point: number | null;
  fixed_points: number | null;
  tiers: unknown;
}

/**
 * Everything the activation surfaces need to know about one tenant, read once
 * per request.
 *
 * `hasEarningRule` is computed from the rule row by `isUsableBaseRule`, which
 * mirrors `private.has_usable_base_rule` (0033) predicate for predicate. That
 * mirroring is the point: a checklist that ticks the box while the RPC refuses
 * the submission is worse than no checklist, because the merchant has no way to
 * tell which of the two is wrong.
 */
export interface ActivationFacts {
  businessId: string;
  status: BusinessStatus;
  hasEarningRule: boolean;
  /** At least one product row. Not required to go live; recommended. */
  hasMenuItem: boolean;
  /** A logo or cover, and opening hours. Not required to go live; recommended. */
  hasStorefrontDetails: boolean;
  /** The most recent round, whatever its status, or null when none was opened. */
  latestRound: VerificationRound | null;
}
