import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { raiseNotification } from "@/features/notifications/server/raise";
import type { NotificationKind } from "@/features/notifications/kinds";
import type { Database, Json } from "@/lib/supabase/types";

import {
  approvedCopy,
  rejectionCopy,
  reviewCopy,
} from "../components/receipt-copy";
import type { ReceiptOutcomeCopy } from "../components/receipt-copy";
import type { ReceiptRejectReason } from "../types";
import type { AwardResult } from "./award";

// ===========================================================================
// The receipts slice's notification adapter: doc 36 Stage 10's "enqueues
// notify.push (kind='points_awarded')" and "rejection enqueues
// kind='receipt_rejected' with the reason", plus doc 36 Stage 9's routing to a
// human, which had been silent to the consumer until this slice.
//
// It exists as a separate module from the pipeline and the review service for
// the same reason ./award.ts does: BOTH of them raise the same three
// notifications, and two implementations of "what a consumer is told when
// their receipt is rejected" is exactly one too many.
//
// ---------------------------------------------------------------------------
// THE COPY IS NOT WRITTEN HERE. IT IS REUSED.
// ---------------------------------------------------------------------------
// Every string below comes from ../components/receipt-copy.ts - the consumer
// copy matrix, which is exhaustively tested reason by reason and swept by
// receipt-copy.test.ts against a vocabulary list drawn from doc 37's signal
// catalog and doc 36's confidence model (fraud, signal, score, confidence,
// threshold, velocity, hash, device, suspicious, blocked, ...).
//
// That sweep is the third of the three fences doc 33's "Never expose fraud
// signal internals" rests on, and it only covers strings that module produces.
// A second set of rejection strings written here would be outside it, would
// look identical on the day it was written, and would be one careless edit away
// from "we could not accept this receipt because it matched an earlier
// submission" - a message that narrows the search space and teaches evasion.
// So this module composes, it does not author, and notify.test.ts re-runs the
// same forbidden-vocabulary list over what it composes.
//
// Two consequences worth naming, because both are inherited rather than
// decided here:
//   * `reject_note` never appears. It is free-text reviewer commentary that can
//     name another consumer, 0017 makes the column unreadable by the client,
//     and receipt-copy.ts has no parameter that could carry it. Neither does
//     anything below.
//   * Mango (the "reward" tone) reaches `points_awarded` and never
//     `receipt_rejected`, because doc 16 makes Mango rewards language. The tone
//     is carried by the kind (../../notifications/kinds.ts), so the rule is
//     enforced by the registry rather than by whoever writes the next caller.
// ===========================================================================

/** Doc 36's status screen, which is where every one of these notifications
 * points: it renders the same copy the notification carries, plus the call to
 * action the copy names. `/receipts/{id}` in doc 30's registry does not exist
 * as a route in this app; this one does, and honest links beat doc-literal
 * ones. */
function receiptRoute(receiptId: string): string {
  return `/scan/${receiptId}`;
}

export interface ReceiptNotifyDeps {
  /** SERVICE ROLE, passed straight through to `raiseNotification` and used for
   * the shop-name read. Both callers already hold one. */
  supabase: SupabaseClient<Database>;
}

/**
 * What happened to the receipt, in the vocabulary the two callers already
 * speak. `award` is the pipeline's and the review service's shared
 * `AwardResult`, so neither of them has to translate it.
 */
export type ReceiptNotifyOutcome =
  | { status: "approved"; award: AwardResult | null }
  | { status: "review" }
  | { status: "rejected"; reason: ReceiptRejectReason | null };

export interface NotifyReceiptOutcomeInput {
  deps: ReceiptNotifyDeps;
  /** `receipts.user_id`, the consumer who submitted it. */
  userId: string;
  receiptId: string;
  businessId: string | null;
  /**
   * The shop's name, when the caller already has it (the pipeline loads the
   * business row for its Stage 8 verification check). Omit and this module
   * reads it; pass null to state that there is none and skip the read.
   */
  businessName?: string | null;
}

/**
 * Raise the one notification this outcome deserves.
 *
 * NEVER THROWS and never returns an error: `raiseNotification` swallows
 * everything, and the two reads this function makes are wrapped for the same
 * reason. A receipt decision that has already been persisted, audited and paid
 * must not be undone by a message that could not be composed.
 */
export async function notifyReceiptOutcome(
  input: NotifyReceiptOutcomeInput & { outcome: ReceiptNotifyOutcome },
): Promise<void> {
  const { deps, userId, receiptId, businessId, outcome } = input;

  const composed = await compose(input);
  if (composed === null) return;

  await raiseNotification({
    deps,
    userId,
    kind: composed.kind,
    title: composed.copy.title,
    body: composed.copy.body,
    businessId,
    data: composed.data,
  });

  console.info(
    `[receipts/notify] raised ${composed.kind} for receipt ${receiptId} (${outcome.status})`,
  );
}

interface Composed {
  kind: NotificationKind;
  copy: ReceiptOutcomeCopy;
  data: Record<string, Json>;
}

async function compose(
  input: NotifyReceiptOutcomeInput & { outcome: ReceiptNotifyOutcome },
): Promise<Composed | null> {
  const { deps, receiptId, businessId, outcome } = input;
  const route = receiptRoute(receiptId);

  if (outcome.status === "review") {
    return {
      kind: "receipt_in_review",
      copy: reviewCopy(),
      data: { route, params: { receipt_id: receiptId } },
    };
  }

  if (outcome.status === "rejected") {
    return {
      kind: "receipt_rejected",
      // The consumer-safe matrix, by reason. `rejectionCopy(null)` is a real
      // branch of it (a rejected receipt never renders a blank explanation),
      // so a missing reason needs no special case here.
      copy: rejectionCopy(outcome.reason),
      // The reason IS carried in `data`, per doc 30 section 5.3's payload
      // (`{receipt_id, reject_reason}`), and that is safe where the free-text
      // note is not: the reason is one of six enum values the consumer is
      // already shown on the status screen, while the note is reviewer prose.
      data: {
        route,
        params: { receipt_id: receiptId, reject_reason: outcome.reason },
      },
    };
  }

  // ---- approved -----------------------------------------------------------
  const award = outcome.award;

  // A ZERO-POINT APPROVAL RAISES NOTHING, and this is a decision rather than an
  // omission. `skipped_zero_points` is a legitimate outcome (a business with no
  // active base rule, an earning floor the receipt does not clear): the receipt
  // is genuinely approved, the visit is recorded, and the ledger is correctly
  // untouched. But the only honest `points_awarded` message for it is "0 points
  // are now in your wallet", which is worse than silence - it reads as a
  // failure, invites a support ticket, and tells the consumer nothing their
  // receipt history does not already show. Doc 36 Stage 10 ties the
  // notification to the AWARD, and here there was none.
  if (award !== null && award.kind === "skipped_zero_points") return null;

  // `refused` means the ledger write did not land (0018 raised, e.g. a
  // mid-flight blacklist). The receipt IS approved and support recovers it via
  // `processed_at is null`, so the consumer is told the truthful weaker thing:
  // approvedCopy(null) is "Your points are on their way", which is the same
  // copy the status screen renders in that window. Never a guessed number.
  const points = award !== null && award.kind === "awarded" ? award.points : null;

  const businessName =
    input.businessName === undefined
      ? await readBusinessName(deps, businessId)
      : input.businessName;

  return {
    kind: "points_awarded",
    copy: approvedCopy(points, businessName),
    data: {
      route,
      params: { receipt_id: receiptId, business_id: businessId, points },
    },
  };
}

/**
 * The shop's name, for "120 points are now in your Kape Diaria wallet".
 *
 * Fails soft to null, which `approvedCopy` renders as "your wallet" - a
 * slightly plainer sentence rather than a missing notification.
 */
async function readBusinessName(
  deps: ReceiptNotifyDeps,
  businessId: string | null,
): Promise<string | null> {
  if (businessId === null) return null;
  try {
    const { data, error } = await deps.supabase
      .from("businesses")
      .select("name")
      .eq("id", businessId)
      .maybeSingle<{ name: string }>();
    if (error !== null || data === null) return null;
    return data.name;
  } catch (error) {
    console.error(
      `[receipts/notify] could not read the shop name for ${businessId}`,
      error,
    );
    return null;
  }
}
