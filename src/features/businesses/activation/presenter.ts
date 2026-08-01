// ===========================================================================
// Pure presentation logic for merchant activation.
//
// Everything here is a total function of its arguments: no clock reads, no
// database, no React. The server loader in ./server/state.ts gathers the facts;
// this file decides what they mean and what to say about them.
//
// TOKENS ONLY applies to the components that consume this; no class string
// appears here at all, which is the reason the tone is returned as a word
// rather than as a colour.
// ===========================================================================

import { formatPeso } from "@/lib/money";

import type {
  ActivationFacts,
  BaseRuleShape,
  BusinessStatus,
  VerificationRound,
} from "./types";

/**
 * Whether a base rule would award a number, mirroring
 * `private.has_usable_base_rule` (0033) predicate for predicate.
 *
 * THE MIRRORING IS THE WHOLE POINT OF THIS FUNCTION. `points_rules` (0012)
 * constrains `rate_centavos_per_point > 0` and `fixed_points > 0` only WHEN
 * PRESENT, so an `amount_rate` row with a null rate satisfies every constraint
 * on the table, awards nothing, and makes
 * `src/features/points/compute.ts:computeBasePoints` throw. A checklist that
 * called that "done" would tick a box the activation RPC then refuses, and the
 * merchant would have no way to tell which of the two was lying.
 *
 * `null` in means "no active base rule at all", which is the same answer as an
 * unusable one for every caller here, but it is spelled out rather than
 * collapsed at the call site.
 */
export function isUsableBaseRule(rule: BaseRuleShape | null): boolean {
  if (rule === null) return false;

  if (rule.rule_type === "amount_rate") {
    return rule.rate_centavos_per_point !== null;
  }
  if (rule.rule_type === "fixed_per_visit" || rule.rule_type === "fixed_per_receipt") {
    return rule.fixed_points !== null;
  }
  if (rule.rule_type === "tiered_amount") {
    return Array.isArray(rule.tiers) && rule.tiers.length > 0;
  }
  return false;
}

/**
 * A base earning rule as one sentence, or null when there is no usable rule.
 *
 * ONE DESCRIPTION, THREE AUDIENCES. The merchant reads it on the earning-rule
 * card, the go-live checklist reads it, and the admin verification queue reads
 * it to decide whether pressing approve will be refused. A second copy would
 * drift, and the direction it drifts in is a merchant and the admin reviewing
 * them reading different sentences about the same rule.
 *
 * Null and "there is a rule but I cannot describe it" are the same answer on
 * purpose: `isUsableBaseRule` is what decides whether the rule counts, and a
 * shape it rejects has no honest sentence.
 */
export function describeBaseRule(rule: BaseRuleShape | null): string | null {
  if (rule === null || !isUsableBaseRule(rule)) return null;

  if (rule.rule_type === "amount_rate" && rule.rate_centavos_per_point !== null) {
    return `1 point per ${formatPeso(rule.rate_centavos_per_point)} spent`;
  }
  if (rule.rule_type === "fixed_per_visit" && rule.fixed_points !== null) {
    return `${rule.fixed_points} points per visit`;
  }
  if (rule.rule_type === "fixed_per_receipt" && rule.fixed_points !== null) {
    return `${rule.fixed_points} points per receipt`;
  }
  if (rule.rule_type === "tiered_amount") {
    return "Points by amount spent, in tiers";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

export type ChecklistItemId = "earning_rule" | "menu" | "storefront";

export interface ActivationChecklistItem {
  id: ChecklistItemId;
  title: string;
  /** What it is and why it matters, in the merchant's terms. */
  body: string;
  done: boolean;
  /**
   * Required items GATE the submission and are enforced by the database.
   * Everything else is advice, and is labelled as advice on screen.
   */
  required: boolean;
}

export interface ActivationChecklist {
  items: ActivationChecklistItem[];
  /** Required and not done. Empty means the merchant may ask for review. */
  blocking: ActivationChecklistItem[];
  canSubmit: boolean;
}

/**
 * ONE REQUIRED ITEM, and the honesty of this screen depends on it staying one.
 *
 * doc 32 section 2.1 lists seven onboarding items and it is a good list, but
 * six of them are advice: nothing in the database refuses an activation over a
 * missing logo. Presenting advice as a requirement teaches a merchant that the
 * checklist is decoration, and then the one item that really does block them
 * reads as decoration too.
 *
 * So the required set here is exactly the set 0033's
 * `private.has_usable_base_rule` enforces, and the recommended set is marked as
 * recommended in the copy as well as in the flag.
 */
export function buildActivationChecklist(facts: ActivationFacts): ActivationChecklist {
  const items: ActivationChecklistItem[] = [
    {
      id: "earning_rule",
      title: "Set how customers earn points",
      body: facts.hasEarningRule
        ? "Customers earn points on every approved receipt."
        : "Without this, receipts are approved and award nothing, and your customer is told nothing. This is the one thing Giya will not let you go live without.",
      done: facts.hasEarningRule,
      required: true,
    },
    {
      id: "menu",
      title: "Add what you sell",
      body: facts.hasMenuItem
        ? "Your menu is on your public page."
        : "Customers browsing Giya see your menu on your page. Recommended, not required.",
      done: facts.hasMenuItem,
      required: false,
    },
    {
      id: "storefront",
      title: "Finish your storefront",
      body: facts.hasStorefrontDetails
        ? "Your photo and opening hours are set."
        : "A photo and your opening hours. Both are shown to customers and used when Giya answers questions about you. Recommended, not required.",
      done: facts.hasStorefrontDetails,
      required: false,
    },
  ];

  const blocking = items.filter((item) => item.required && !item.done);

  return {
    items,
    blocking,
    // Only a draft may be submitted (0033 refuses anything else with
    // SUBMIT_INVALID_STATE), so the control is not offered from any other
    // status rather than being offered and failing.
    canSubmit: facts.status === "draft" && blocking.length === 0,
  };
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

export type ActivationTone = "info" | "warning";

export interface ActivationBannerCopy {
  tone: ActivationTone;
  message: string;
}

/**
 * One sentence about where this business stands, or null when there is nothing
 * true and useful to say.
 *
 * WHAT THIS FIXED. The banner used to be driven by the raw status string and,
 * for `draft`, claimed "Your documents are under review" when nothing had ever
 * been submitted and no reviewer existed. That was corrected once already, to
 * say that document submission was not open. It is now wrong in the other
 * direction, because submission IS open, so this function replaces the copy
 * table entirely and drives every sentence off facts that were read this
 * request.
 *
 * `active` returns null deliberately: a merchant who is live does not need a
 * strip telling them so on every load, and a banner that never goes away is a
 * banner nobody reads.
 */
export function activationBannerCopy(facts: ActivationFacts): ActivationBannerCopy | null {
  const status: BusinessStatus = facts.status;

  if (status === "active") return null;

  if (status === "pending_verification") {
    return {
      tone: "info",
      message:
        "Your business is with the Giya team for review. Nothing more is needed from you right now. You can keep setting up while you wait; customers will not see you until it is approved.",
    };
  }

  if (status === "suspended") {
    return {
      tone: "warning",
      message:
        "This business is suspended and is not shown to customers. Contact Giya support to sort it out.",
    };
  }

  if (status === "closed") {
    return {
      tone: "warning",
      message: "This business is closed and is not shown to customers.",
    };
  }

  // draft, in its three meaningfully different shapes.
  const sentBack = wasSentBack(facts.latestRound);
  if (sentBack) {
    return {
      tone: "warning",
      message:
        "Your last submission was sent back. The reason is on the go-live checklist below; fix it and submit again.",
    };
  }

  if (facts.hasEarningRule) {
    return {
      tone: "info",
      message:
        "You are ready to ask for review. Customers cannot find you on Giya until the team approves you.",
    };
  }

  return {
    tone: "warning",
    message:
      "You are not shown to customers yet. The go-live checklist below has the one thing that is still missing.",
  };
}

/**
 * Whether the latest round came back as a refusal.
 *
 * `revision_requested` counts even though 0033 does not write it: the status
 * exists in 0002's constraint and doc 32 lists it as an outcome, so a round
 * that somehow carries it must not render as if nothing had happened.
 */
export function wasSentBack(round: VerificationRound | null): boolean {
  if (round === null) return false;
  return round.status === "rejected" || round.status === "revision_requested";
}

/**
 * The admin's decision text, or null when there is none to show.
 *
 * Only shown for a round that was refused. An approved round's reason is the
 * admin's internal justification for saying yes, and while it is harmless, a
 * merchant who is live does not need it and the screen that would carry it does
 * not render at all.
 */
export function sentBackReason(round: VerificationRound | null): string | null {
  if (!wasSentBack(round)) return null;
  const reason = round?.decisionReason?.trim() ?? "";
  return reason.length > 0 ? reason : null;
}

/**
 * `YYYY-MM-DD`, the only date format that is unambiguous to everyone, and null
 * when there is no usable timestamp.
 *
 * Local rather than imported from the receipts presenter on purpose: this
 * feature has one date on one screen, and reaching across features for it would
 * couple merchant activation copy to the receipt review queue's formatting
 * decisions.
 */
export function formatSubmittedOn(iso: string | null): string | null {
  if (iso === null) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The submission note
// ---------------------------------------------------------------------------

/**
 * The applicant note is OPTIONAL, unlike every admin reason in this codebase.
 *
 * 0022's `audit_logs_admin_reason_required` binds `actor_kind='admin'` rows
 * only, and 0033 writes the merchant's submission as `actor_kind='user'`
 * precisely so no justification is demanded: making a merchant explain why they
 * want to be reviewed produces filler text, and filler text is what makes the
 * field worthless on the rows that matter.
 */
export const MAX_SUBMISSION_NOTE_LENGTH = 1000;

export function submissionNoteProblem(note: string): string | null {
  if (note.trim().length > MAX_SUBMISSION_NOTE_LENGTH) {
    return `Keep it under ${MAX_SUBMISSION_NOTE_LENGTH} characters.`;
  }
  return null;
}
