// ===========================================================================
// Pure presentation logic for the admin portal.
//
// Everything here is a total function of its arguments: no clock reads, no
// database, no React.
//
// WHAT IS NOT HERE, ON PURPOSE. There is no second `describeSignal`, no second
// severity chip, no second SLA state and no second money formatter. Doc 37's
// evidence display contract is implemented once, in
// `features/receipts/review/presenter.ts`, and this portal imports it. The
// admin fraud queue is the platform-wide SIBLING of the business review queue,
// not a different product: an admin and a merchant looking at the same
// `image_hash_dup` row must read the same sentence about it, or the escalation
// conversation starts with the two of them disagreeing about what the detector
// said. The re-exports at the bottom of this file exist so a screen never has
// to reach into the business feature directly and quietly fork a copy.
//
// What IS here is everything the business queue could not answer because it
// was tenant-scoped: platform standing, the cooldown clock, the ladder's
// vocabulary, and the audit verbs.
//
// TOKENS ONLY. Every class string names an MD3 token; no raw colour appears
// anywhere. Tertiary (Mango) is absent: it is rewards language, and nothing on
// this portal is a reward.
// ===========================================================================

import { formatPeso } from "@/lib/money";

import { formatDateTime } from "../receipts/review/presenter";
import type {
  AdminFraudFilter,
  AdminReceiptFilter,
  ClawbackEligibility,
  ConsumerStandingView,
} from "./types";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export const ADMIN_FRAUD_TABS: ReadonlyArray<{ value: AdminFraudFilter; label: string }> = [
  { value: "open", label: "Needs a decision" },
  { value: "blocked", label: "Auto-blocked" },
  { value: "all", label: "All flagged" },
];

export const ADMIN_RECEIPT_TABS: ReadonlyArray<{ value: AdminReceiptFilter; label: string }> = [
  { value: "review", label: "In review" },
  { value: "unmatched", label: "No business matched" },
  { value: "recent", label: "Recently decided" },
];

export function isAdminFraudFilter(value: string): value is AdminFraudFilter {
  return ADMIN_FRAUD_TABS.some((tab) => tab.value === value);
}

export function isAdminReceiptFilter(value: string): value is AdminReceiptFilter {
  return ADMIN_RECEIPT_TABS.some((tab) => tab.value === value);
}

// ---------------------------------------------------------------------------
// Consumer standing (doc 37's "consumer's history summary")
// ---------------------------------------------------------------------------

/**
 * The approval ratio as a sentence, including the case the number cannot be
 * computed. `0/0` is not "0% approved", it is "nothing decided yet", and an
 * admin shown 0% for a brand new account will read it as a red flag.
 */
export function formatApprovalRatio(standing: ConsumerStandingView): string {
  if (standing.approvalRatio === null) return "Nothing decided yet";
  return `${Math.round(standing.approvalRatio * 100)}% approved (${standing.approved} of ${
    standing.approved + standing.rejected
  })`;
}

export type StandingTone = "neutral" | "attention" | "alarm";

export interface StandingChip {
  label: string;
  tone: StandingTone;
}

export function standingChipClass(tone: StandingTone): string {
  if (tone === "alarm") return "bg-error-container text-on-error-container";
  if (tone === "attention") {
    return "border border-outline bg-surface-container-highest text-on-surface";
  }
  return "bg-surface-container-high text-on-surface-variant";
}

/**
 * doc 37's cooldown ladder step 2, read off `consumers.scan_blocked_until`.
 *
 * `now` is injected rather than read so the rendered clock is deterministic in
 * a test and cannot produce a hydration mismatch between the server render and
 * the client.
 */
export interface CooldownState {
  active: boolean;
  label: string;
}

export function cooldownState(scanBlockedUntil: string | null, now: Date): CooldownState {
  if (scanBlockedUntil === null) return { active: false, label: "Not in cooldown" };

  const until = new Date(scanBlockedUntil);
  if (Number.isNaN(until.getTime())) return { active: false, label: "Not in cooldown" };

  const remainingMs = until.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return { active: false, label: `Cooldown ended ${formatDateTime(scanBlockedUntil)}` };
  }

  const hours = Math.ceil(remainingMs / 3_600_000);
  return {
    active: true,
    label:
      hours <= 1
        ? "Scanning blocked for under an hour more"
        : `Scanning blocked for ${hours} more hours`,
  };
}

/**
 * The standing summary as chips, worst first.
 *
 * Only facts that are actionable get a chip. A consumer with a clean record
 * gets exactly one ("No fraud signals"), because a row of grey chips saying
 * nothing is how a reviewer learns to stop reading chips.
 */
export function standingChips(
  standing: ConsumerStandingView,
  now: Date,
): StandingChip[] {
  const chips: StandingChip[] = [];

  if (standing.isSuspended) {
    chips.push({ label: "Suspended platform-wide", tone: "alarm" });
  }

  const cooldown = cooldownState(standing.scanBlockedUntil, now);
  if (cooldown.active) chips.push({ label: cooldown.label, tone: "alarm" });

  if (standing.strikes > 0) {
    chips.push({
      label: `${standing.strikes} fraud rejection${standing.strikes === 1 ? "" : "s"} in 30 days`,
      tone: standing.strikes >= 3 ? "alarm" : "attention",
    });
  }

  if (standing.priorSignals === 0) {
    chips.push({ label: "No fraud signals", tone: "neutral" });
  } else {
    chips.push({
      label: `${standing.priorSignals} signal${standing.priorSignals === 1 ? "" : "s"} on record`,
      tone: standing.priorSignals >= 5 ? "attention" : "neutral",
    });
  }

  if (standing.devices > 1) {
    chips.push({ label: `${standing.devices} devices`, tone: standing.devices >= 3 ? "attention" : "neutral" });
  }
  if (standing.businesses > 1) {
    chips.push({ label: `Scans at ${standing.businesses} businesses`, tone: "neutral" });
  }

  return chips;
}

// ---------------------------------------------------------------------------
// The consequences ladder (doc 37)
// ---------------------------------------------------------------------------

/**
 * The ladder actions this portal offers, in doc 37's own order.
 *
 * Steps 1 and 3 are absent and that is the doc's assignment, not a gap: step 1
 * (reject) is automatic or a review decision, and step 3 (blacklist) belongs to
 * the owner/manager of the tenant that benefits from it, which is why it lives
 * in the business portal's customers screen and writes
 * `customer.segment_changed` there.
 */
export const LADDER_ACTIONS = [
  "cooldown_apply",
  "cooldown_lift",
  "suspend",
  "unsuspend",
  "clawback",
] as const;

export type LadderAction = (typeof LADDER_ACTIONS)[number];

export interface LadderCopy {
  /** The button. */
  label: string;
  /** What the admin is about to do, in the confirm panel. */
  description: string;
  /** doc 37's reviewer-action to `audit_logs.action` mapping. */
  auditAction: string;
  /** Destructive actions get the error tone; reversals do not. */
  destructive: boolean;
}

export const LADDER_COPY: Record<LadderAction, LadderCopy> = {
  cooldown_apply: {
    label: "Apply cooldown",
    description:
      "Blocks this customer from scanning for 24 hours. Scans they attempt are refused with a neutral message; nothing about the detector is shown to them.",
    auditAction: "fraud.cooldown_applied",
    destructive: true,
  },
  cooldown_lift: {
    label: "Lift cooldown",
    description: "Ends the scan block now. Use this when the block was applied on evidence that did not hold up.",
    auditAction: "fraud.cooldown_lifted",
    destructive: false,
  },
  suspend: {
    label: "Suspend account",
    description:
      "Locks this person out of Giya entirely, on every business. Reserved for cross-business abuse and rings (ladder step 4).",
    auditAction: "consumer.suspended",
    destructive: true,
  },
  unsuspend: {
    label: "Lift suspension",
    description: "Restores full access to the account.",
    auditAction: "consumer.unsuspended",
    destructive: false,
  },
  clawback: {
    label: "Claw back points",
    description:
      "Reverses the points this receipt earned and rejects it as fraud. If the points have already been spent, only what remains can be recovered and the rest is recorded as a shortfall.",
    auditAction: "fraud.clawback_applied",
    destructive: true,
  },
};

/**
 * What the clawback control says, given what the ledger allows.
 *
 * Doc 37 registers `CLAWBACK_INVALID_STATE` for both unavailable cases and the
 * RPC raises exactly that; this turns the two into different sentences, because
 * "there was never anything to claw back" and "someone already did this" lead
 * an admin to completely different next steps.
 */
export function clawbackCopy(eligibility: ClawbackEligibility): {
  available: boolean;
  summary: string;
} {
  if (eligibility.kind === "eligible") {
    return {
      available: true,
      summary: `This receipt earned ${eligibility.earnPoints} points. Clawing back reverses them as far as the balance allows.`,
    };
  }
  if (eligibility.kind === "already_reversed") {
    return {
      available: false,
      summary: `Already clawed back: ${eligibility.clawedPoints} points were reversed. The ledger allows one reversal per earn.`,
    };
  }
  return {
    available: false,
    summary: "This receipt never earned points, so there is nothing to claw back. Reject it in review instead.",
  };
}

// ---------------------------------------------------------------------------
// Audit verbs
// ---------------------------------------------------------------------------

/**
 * The registry doc 25 keeps in prose and 0022 constrains only the SHAPE of.
 * Unknown verbs fall through to a humanised form rather than to a blank cell:
 * a slice that registers a new verb must not make its own audit rows invisible
 * on the one screen that reads them back.
 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  "receipt.review_approved": "Approved in review",
  "receipt.review_rejected": "Rejected in review",
  "fraud.cooldown_applied": "Cooldown applied",
  "fraud.cooldown_lifted": "Cooldown lifted",
  "fraud.clawback_applied": "Points clawed back",
  "customer.segment_changed": "Customer segment changed",
  "consumer.suspended": "Account suspended",
  "consumer.unsuspended": "Suspension lifted",
  "job.replayed": "Job replayed",
  "job.replay_failed": "Replay attempted (not delivered)",
};

export function describeAuditAction(action: string): string {
  const known = AUDIT_ACTION_LABELS[action];
  if (known !== undefined) return known;
  return action
    .split(".")
    .join(" ")
    .split("_")
    .join(" ")
    .replace(/^./, (first) => first.toUpperCase());
}

/** doc 25's `actor_kind`, as a word rather than a column value. */
export function describeActor(actorKind: string, actorName: string | null): string {
  if (actorKind === "system" || actorKind === "worker") return "Giya (automatic)";
  return actorName ?? "Unknown";
}

// ---------------------------------------------------------------------------
// Queue Status (doc 31 §5 `/admin/monitoring/queues`, doc 39's DLQ view)
// ---------------------------------------------------------------------------

/** `_id` or `_ids`, case-sensitive: doc 39's own payload vocabulary
 * (`receipt_id`, `notification_ids`, `business_id`, ...). */
const PAYLOAD_IDENTITY_KEY = /_ids?$/;

/** `job_id` names the row itself (added by the publisher, `src/lib/queue/
 * publish.ts`) - showing it beside the dead-letter row that already carries
 * that id twice would say the same fact twice and nothing else. */
const PAYLOAD_IDENTITY_EXCLUDED_KEY = "job_id";

const MAX_PAYLOAD_IDENTITY_LENGTH = 120;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * A short, stable label for WHICH unit of work a dead job's payload names -
 * doc 31 §5's "payload identity" column on the dead-letter list.
 *
 * Doc 39: "payloads carry identifiers, never denormalized state that can go
 * stale" - every queue's payload is `{job_id, ...identifiers}`, so pulling out
 * the `_id`/`_ids` keys (job_id excluded, see above) is a general rule that
 * needs no per-queue schema knowledge. A payload shape this cannot read (not
 * an object, or an object with no identifier keys) falls back to a truncated
 * JSON dump rather than an empty cell, because "unrecognised" must still say
 * something an operator can search a log for.
 */
export function describePayloadIdentity(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return truncate(JSON.stringify(payload) ?? "null", MAX_PAYLOAD_IDENTITY_LENGTH);
  }

  const entries = Object.entries(payload as Record<string, unknown>).filter(
    ([key]) => key !== PAYLOAD_IDENTITY_EXCLUDED_KEY && PAYLOAD_IDENTITY_KEY.test(key),
  );

  if (entries.length === 0) {
    return truncate(JSON.stringify(payload), MAX_PAYLOAD_IDENTITY_LENGTH);
  }

  const summary = entries
    .map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.length}]` : String(value)}`)
    .join(" ");
  return truncate(summary, MAX_PAYLOAD_IDENTITY_LENGTH);
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

export function formatPlatformAmount(centavos: number | null): string {
  return centavos === null ? "Not read" : formatPeso(centavos);
}

/**
 * doc 31 §11's reason-required pattern, as a single predicate both the client
 * island and the server action call.
 *
 * The database has the last word (`audit_logs_admin_reason_required` refuses a
 * null or whitespace-only reason on any `actor_kind='admin'` row), so this is
 * not the enforcement - it is the thing that keeps an admin from typing a
 * paragraph of evidence and then losing it to a 23514.
 */
export const MIN_REASON_LENGTH = 8;
export const MAX_REASON_LENGTH = 1000;

export function reasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "A reason is required. It is recorded in the audit log.";
  if (trimmed.length < MIN_REASON_LENGTH) {
    return `Say a little more: at least ${MIN_REASON_LENGTH} characters, so the record is worth reading later.`;
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    return `Keep it under ${MAX_REASON_LENGTH} characters.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Re-exports: doc 37's evidence contract, implemented once
// ---------------------------------------------------------------------------
// These are the business review presenter's own functions, surfaced here so an
// admin screen imports them from its own feature without a second copy ever
// existing. If one of these needs to behave differently for an admin, the
// correct move is a parameter on the shared function, never a fork.
export {
  compositeFraudScore,
  confidenceTone,
  describeSignal,
  evidenceRows,
  fieldChip,
  formatAmount,
  formatConfidence,
  formatDate,
  formatDateTime,
  highestSeverity,
  queueAge,
  severityMeta,
  slaChipClass,
  toneChipClass,
  REJECT_REASON_LABELS,
} from "../receipts/review/presenter";
