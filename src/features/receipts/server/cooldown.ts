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
 */
export async function applyCooldownIfEarned(
  deps: CooldownDeps,
  consumerId: string,
  settings: CooldownSettings,
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

  // TODO(audit): doc 37 requires a `fraud.cooldown_applied` audit row here.
  // 0022 landed the table with this slice, but the row belongs to whichever
  // caller can supply an actor and a request id: the pipeline has neither
  // (actor_kind='system'), and wiring a system-actor write is the jobs slice's
  // business rather than something to smuggle into a refactor.
  console.warn(
    `[receipts/cooldown] consumer ${consumerId} hit ${strikes} fraud-family rejections in ${COOLDOWN_WINDOW_DAYS} days; scanning blocked until ${blockedUntil.toISOString()}`,
  );
}
