import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import type { FraudRejectReason, ReceiptRejectReason } from "../types";

// ===========================================================================
// Doc 37 consequences ladder, step 2 - the ONE cooldown path.
//
// Extracted verbatim from `process.ts`, which owned it inline until the human
// review service needed exactly the same rule. Two callers now:
//
//   * the OCR pipeline, when routing lands on a fraud-family rejection;
//   * the human review service, when a reviewer rejects for a fraud-family
//     reason (spec section 4 guard 5: "a fraud-family rejection runs the same
//     cooldown-strike check the pipeline runs").
//
// The argument for sharing is the same one doc 36 makes about the award path:
// two implementations of "has this consumer earned a scan block" would drift,
// and the direction they drift in is a consumer either blocked when they
// should not be or free when they should not be. Neither is discoverable from
// a log line.
//
// Docs: docs/30-modules/37-fraud-detection.md (consequences ladder step 2,
// settings keys fraud.cooldown_strikes / fraud.cooldown_hours),
// docs/30-modules/36-receipt-ocr-pipeline.md Stage 8.
//
// ---------------------------------------------------------------------------
// THE AUDIT ROW: SYSTEM ACTOR, BEST EFFORT
// ---------------------------------------------------------------------------
// `admin/consequences.ts`'s `applyCooldown` (the MANUAL half of this ladder
// step) writes an `actor_kind='admin'` row and 0022's
// `audit_logs_admin_reason_required` constraint makes that row's `reason`
// mandatory. This is the AUTOMATIC half: nobody typed a justification, the
// justification IS the strike count, so the row below is `actor_kind='system'`
// with `actor_id` and `reason` both null - 0022's admin-reason constraint is
// scoped to `actor_kind = 'admin'` alone (its own comment: "a routine
// user/system/worker row ... has no such requirement in any doc"), so a
// system row with a null reason is already legal under the live schema. No
// migration is needed to record this.
//
// GATE OR BEST EFFORT? Three comparisons, and the one a reader reaches for
// first is the one most likely to mislead, so it goes first here too.
//
//   * `admin/consequences.ts` writes this ladder step's OTHER half - the
//     identical verb (`fraud.cooldown_applied`) on the identical entity
//     (`consumer`) - and chooses to REVERT the state change when its audit
//     write fails. That looks like the precedent to follow and is not: its
//     revert exists to serve doc 15's admin-reason requirement, which is a
//     control over ADMINS ("admin actions on tenant data always require a
//     recorded reason"). Nothing here is an admin action - `reason` is
//     structurally null on a system row and 0022 never asks this row for
//     one - so the control that justifies consequences.ts's revert simply
//     does not apply to this one, and copying the shape without the reason
//     it exists for would just be ceremony.
//   * `receipts/server/review.ts` gates its own audit write (aborts the
//     decision) because a FAILED gate there would mint UNAUDITABLE POINTS -
//     threat-model item 6, doc 15's one unforgivable failure mode. This
//     function mints nothing: the cooldown itself is the consequence, and it
//     is already correct and durable on `consumers.scan_blocked_until` by
//     the time the audit insert below runs. Aborting it now would not undo
//     the block (this function NEVER THROWS and NEVER UNDOES a write that
//     already landed - see the doc above); it would only turn one missing
//     log line into a second one.
//   * So this follows `receipts/server/escalate.ts`'s posture instead: log
//     loudly, at error level, naming the consumer and the block, and carry
//     on. The block is real either way, and it is not the only trace of
//     itself - `consumers.scan_blocked_until` is durable state a support
//     engineer can read directly, exactly as escalate.ts notes
//     `escalated_at` is for its own best-effort row.
//
// NOTE ON RE-PROCESSING (append-only, and deliberately so). A receipt that
// is re-processed after already earning a block (a reclaim, a manual re-run)
// re-evaluates the strike count and, if it still meets the threshold, writes
// a SECOND `fraud.cooldown_applied` row and may extend `scan_blocked_until`
// further into the future (never shorten it - see the never-shorten guard
// below). This is not a bug: `audit_logs` is append-only by design (0022),
// and two rows both correctly describe two real evaluations. Said explicitly
// here because nothing else in this file would tell a reader whether a
// second row on the same consumer means a second offense or a duplicate
// write.
// ===========================================================================

/** Doc 37 consequences ladder step 2: strikes counted over 30 days. */
export const COOLDOWN_WINDOW_DAYS = 30;

/**
 * Doc 37 ladder step 2 counts "fraud-family rejections". These are exactly the
 * two reasons `fraudVerdict` can produce; `unreadable`, `too_old`,
 * `wrong_business` and `manual` are quality or matching outcomes and must
 * never accumulate toward a scan block.
 *
 * The same list bounds what a HUMAN reviewer can do: a manager rejecting for
 * `duplicate` or `fraud_suspected` strikes the consumer, and rejecting for
 * `unreadable` does not, because the reviewer is answering the same question
 * the pipeline answers.
 */
export const FRAUD_FAMILY_REJECT_REASONS: readonly FraudRejectReason[] = [
  "duplicate",
  "fraud_suspected",
];

export function isFraudFamilyRejectReason(
  reason: ReceiptRejectReason,
): reason is FraudRejectReason {
  return reason === "duplicate" || reason === "fraud_suspected";
}

/** Doc 37's reviewer-action -> `audit_logs.action` mapping, verbatim - the
 * same string `admin/consequences.ts` writes for the manual half of this
 * ladder step, since both describe the same consequence. */
const AUDIT_ACTION_COOLDOWN_APPLIED = "fraud.cooldown_applied";

/** `audit_logs.entity_type`, matching `admin/consequences.ts`'s `ENTITY_CONSUMER`. */
const AUDIT_ENTITY_TYPE = "consumer";

/**
 * The one audit row this module writes. Best-effort - see the header for why
 * a failure here does not undo the cooldown that already landed.
 */
async function writeCooldownAuditRow(
  deps: CooldownDeps,
  input: {
    consumerId: string;
    previousBlockedUntil: string | null;
    blockedUntil: string;
    hours: number;
    /** The count the strike-check READ, which is capped at
     * `settings.cooldownStrikes` by the `.limit(...)` on that query (a
     * consumer with 9 fraud rejections reads back exactly 3 here when the
     * threshold is 3). Recorded under a name that says so, rather than as
     * `strikes`, which would misstate a cost-bounded read as an exact count
     * of the consumer's own rejections (M2). */
    strikesAtOrAbove: number;
    requestId: string | null;
  },
): Promise<void> {
  const { error } = await deps.supabase.from("audit_logs").insert({
    actor_id: null,
    actor_kind: "system",
    actor_role: null,
    // Platform-level, per `admin/consequences.ts`'s identical call for the
    // manual half: a cooldown blocks scanning everywhere, not at one merchant.
    business_id: null,
    action: AUDIT_ACTION_COOLDOWN_APPLIED,
    entity_type: AUDIT_ENTITY_TYPE,
    entity_id: input.consumerId,
    before: { scan_blocked_until: input.previousBlockedUntil },
    after: {
      scan_blocked_until: input.blockedUntil,
      hours: input.hours,
      strikes_at_or_above: input.strikesAtOrAbove,
    },
    reason: null,
    request_id: input.requestId,
  });

  if (error !== null) {
    console.error(
      `[receipts/cooldown] could not audit the cooldown applied to consumer ${input.consumerId}; the cooldown stands`,
      error,
    );
  }
}

/**
 * The subset of `ProcessReceiptDeps` this rule needs. Declared structurally so
 * the pipeline's deps object satisfies it without either module importing the
 * other's dependency type.
 *
 * `supabase` MUST be the SERVICE ROLE client: `consumers.scan_blocked_until`
 * has no client write policy.
 */
export interface CooldownDeps {
  supabase: SupabaseClient<Database>;
  now: () => Date;
}

/** The subset of `ReceiptSettings` this rule reads. */
export interface CooldownSettings {
  readonly cooldownStrikes: number;
  readonly cooldownHours: number;
}

/**
 * "3 fraud-family rejections / 30 days (`fraud.cooldown_strikes`) -> 24h scan
 * block (`fraud.cooldown_hours`)". Automatic, auto-expiring, audited.
 *
 * Doc 37's parenthetical says the strikes are "counted from
 * fraud_signals_consumer_idx", but a signal is not a rejection: an approved
 * receipt with three warn rows would otherwise strike a consumer who did
 * nothing wrong, and one rejection carrying four signals would strike them
 * four times over. The count is therefore taken over REJECTIONS - the noun the
 * sentence actually uses - reading `receipts` for this consumer's
 * `duplicate`/`fraud_suspected` rows inside the window. The receipt just
 * rejected is already written, so it counts itself, which is what makes the
 * third strike (not the fourth) fire the block.
 *
 * CALLER CONTRACT, unchanged by the extraction: call this only AFTER the
 * rejection is persisted, and only when the reason is fraud-family.
 *
 * NEVER THROWS. A cooldown that could not be applied must not undo a rejection
 * that already landed.
 *
 * `requestId` correlates the audit row with the request log line (doc 25),
 * exactly as every other writer's `request_id` does. Optional and defaulted
 * to null because the OCR pipeline caller (`process.ts`) has none to give -
 * "no request context, no session, no supplied payload" is that module's own
 * documented shape - while the human review service (`review.ts`) already has
 * one in scope for its own audit row and passes it through here too.
 */
export async function applyCooldownIfEarned(
  deps: CooldownDeps,
  consumerId: string,
  settings: CooldownSettings,
  requestId: string | null = null,
): Promise<void> {
  const now = deps.now();
  const windowStart = new Date(
    now.getTime() - COOLDOWN_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await deps.supabase
    .from("receipts")
    .select("id")
    .eq("user_id", consumerId)
    .eq("status", "rejected")
    .in("reject_reason", [...FRAUD_FAMILY_REJECT_REASONS])
    .gte("created_at", windowStart)
    // Only "did we reach the threshold" matters, so the read stops there.
    .limit(settings.cooldownStrikes);

  if (error !== null) {
    console.error("[receipts/cooldown] cooldown strike count failed", error);
    return;
  }

  const strikes = (data ?? []).length;
  if (strikes < settings.cooldownStrikes) return;

  const blockedUntil = new Date(now.getTime() + settings.cooldownHours * 3_600_000);

  const { data: consumer, error: readError } = await deps.supabase
    .from("consumers")
    .select("scan_blocked_until")
    .eq("id", consumerId)
    .maybeSingle<{ scan_blocked_until: string | null }>();

  if (readError !== null) {
    console.error("[receipts/cooldown] could not read the existing cooldown", readError);
    return;
  }

  // Never shorten an existing block. A longer cooldown may have been applied
  // by an admin (ladder step 2 is also a manual action), and re-running the
  // pipeline over an old receipt must not hand an abuser an early release.
  const existing =
    consumer?.scan_blocked_until === undefined || consumer.scan_blocked_until === null
      ? null
      : new Date(consumer.scan_blocked_until);
  if (existing !== null && existing.getTime() >= blockedUntil.getTime()) return;

  const { error: writeError } = await deps.supabase
    .from("consumers")
    .update({ scan_blocked_until: blockedUntil.toISOString() })
    .eq("id", consumerId);

  if (writeError !== null) {
    console.error("[receipts/cooldown] could not apply the scan cooldown", writeError);
    return;
  }

  console.warn(
    `[receipts/cooldown] consumer ${consumerId} hit ${strikes} fraud-family rejections in ${COOLDOWN_WINDOW_DAYS} days; scanning blocked until ${blockedUntil.toISOString()}`,
  );

  // Best-effort, per the header note above: the block already stands.
  await writeCooldownAuditRow(deps, {
    consumerId,
    previousBlockedUntil: consumer?.scan_blocked_until ?? null,
    blockedUntil: blockedUntil.toISOString(),
    hours: settings.cooldownHours,
    strikesAtOrAbove: strikes,
    requestId,
  });
}
