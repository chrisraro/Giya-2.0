import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import type { NotificationKind } from "../kinds";

// ===========================================================================
// The write half of doc 30-modules/30-platform-core.md section 5.2: `notify`,
// the service-role fan-out. One function, one row, one contract.
//
// ---------------------------------------------------------------------------
// THE CONTRACT: THIS FUNCTION NEVER THROWS, AND NEVER MATTERS
// ---------------------------------------------------------------------------
// A notification is a message ABOUT something that already happened. Every one
// of its callers has just finished doing the thing worth telling someone about
// - approving a receipt, minting points, routing a scan to a human - and every
// one of those is either already committed or already unrecoverable by the
// time this function is reached.
//
// So the failure mode has to be silence, not an exception. Concretely, and this
// is the property `raise.test.ts` pins: if this function throws, the points
// award still stands. It cannot throw, because every path below is inside the
// try, including the ones that look total (a null client, a malformed payload,
// a driver fault, a constraint violation). The worst outcome is `false` and a
// line in the log, which costs one message and nothing else.
//
// The alternative was tried in principle and rejected: letting the caller
// decide would put a try/catch around every call site, and the first one
// written without it turns a full inbox into a failed receipt. A fail-soft
// service with one implementation of the swallow is the only shape where that
// cannot regress.
//
// ---------------------------------------------------------------------------
// WHAT THIS FUNCTION DOES NOT DO
// ---------------------------------------------------------------------------
// It does not enqueue anything. Doc 30 section 5.2 step 3 and doc 39's queue
// registry have the fan-out publish `notify.push` (FCM) and `notify.email`
// (Resend) batches after the rows land. There are no VAPID keys, no service
// worker push registration, no Resend credential and no QStash credential in
// this project, so there is nothing to publish to and nothing here pretends
// otherwise. The row IS the delivery: doc 33 calls the in-app inbox "the
// guaranteed fallback channel on every platform", and today it is the only one.
// See the TODO(queue) marker below for the exact seam, written to match the one
// src/features/receipts/server/submit.ts already carries for the OCR enqueue.
//
// It does not render templates or resolve preferences either. Doc 30 section
// 5.2 steps 1-2 belong to the CALLER here, deliberately: the receipt kinds'
// copy is the fraud-safe matrix in receipt-copy.ts and must not be duplicated
// (see ../kinds.ts), and preference gating (doc 30 section 5.5) applies to
// push/email/marketing, none of which exist yet - transactional in_app "ignores
// toggles" by that same section, and every kind this codebase raises is
// transactional.
// ===========================================================================

/** The database's caps, from 0026_notifications.sql's check constraints. */
const TITLE_MAX = 120;
const BODY_MAX = 600;

export interface RaiseNotificationDeps {
  /**
   * SERVICE ROLE. 0026 gives no client audience an insert policy and no insert
   * privilege, so a row raised through a session-scoped client fails with
   * 42501. Injected rather than created here because both real callers
   * (the OCR pipeline and the review service) already hold one, and a second
   * client per notification would be a connection per message.
   */
  supabase: SupabaseClient<Database>;
}

/**
 * The production wiring. Returns null when the service-role key is absent,
 * which is `createServiceRoleClient`'s documented degraded path; `raise`
 * treats that as one more reason to write nothing and say so in the log.
 */
export function defaultRaiseNotificationDeps(): RaiseNotificationDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) return null;
  return { supabase };
}

export interface RaiseNotificationInput {
  /** `profiles.id` of the RECIPIENT. */
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** Sender tenant. Null or absent = the platform itself. */
  businessId?: string | null;
  /**
   * Doc 30 section 5.3's `{route, params}`. `route` should be an app-relative
   * path; `notificationRoute` re-validates it on the way out, so a bad one
   * costs the link rather than the row.
   *
   * NOTHING FROM THE FRAUD STAGE GOES IN HERE. `data` is read by the person
   * the notification is addressed to, so no reject note, no signal, no score,
   * no confidence, no other consumer's identifiers. Same rule as the copy
   * itself (see receipt-copy.ts's header); a jsonb column cannot enforce it,
   * so it is stated at every door.
   */
  data?: Record<string, Json>;
  /** Omit for the default wiring; pass null in tests to assert the degraded path. */
  deps?: RaiseNotificationDeps | null;
}

/**
 * Clamp rather than reject. The captions this feeds are composed from a
 * merchant name and a points total, and an unusually long shop name must cost
 * an ellipsis, not the whole message: 0026's `char_length` checks would answer
 * a too-long body with 23514, and a caller that silently loses notifications to
 * a name length would be a bug nobody ever sees.
 */
function clamp(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Write one in-app notification.
 *
 * Returns true when the row landed and false for every other outcome. NEVER
 * THROWS - see the module header for why that is the contract and not a
 * convenience.
 */
export async function raiseNotification(input: RaiseNotificationInput): Promise<boolean> {
  try {
    const deps =
      input.deps === undefined ? defaultRaiseNotificationDeps() : input.deps;
    if (deps === null) {
      console.error(
        `[notifications/raise] no service-role client; dropping ${input.kind} for ${input.userId}`,
      );
      return false;
    }

    const title = clamp(input.title, TITLE_MAX);
    const body = clamp(input.body, BODY_MAX);
    if (title.length === 0 || body.length === 0) {
      // 0026 refuses a blank title or body with 23514, and it is right to: a
      // notification that says nothing is worse than no notification. Caught
      // here so the log names the caller rather than the constraint.
      console.error(
        `[notifications/raise] refusing to raise ${input.kind} for ${input.userId}: empty title or body`,
      );
      return false;
    }

    const { error } = await deps.supabase.from("notifications").insert({
      user_id: input.userId,
      business_id: input.businessId ?? null,
      kind: input.kind,
      title,
      body,
      data: (input.data ?? {}) as Json,
    });

    if (error !== null) {
      console.error(
        `[notifications/raise] could not raise ${input.kind} for ${input.userId}`,
        error,
      );
      return false;
    }

    // TODO(queue): doc 30 section 5.2 step 3 and doc 39's registry. Once the
    // jobs slice and the delivery credentials land, this is where the row's id
    // is published - `notify.push` for the FCM send and `notify.email` for
    // Resend, batched `{notification_ids <= 500}` with flow-control key
    // `notify:{business_id}`, dedupe key `notification_id` for a singleton like
    // this one. Nothing about this call site changes shape: the row is written
    // first and is durable before any send is attempted, which is exactly what
    // doc 39 requires of the fan-out. The same marker sits on the OCR enqueue
    // in src/features/receipts/server/submit.ts.
    return true;
  } catch (error) {
    // The last-resort swallow, and the whole point of the module. Anything
    // reaching here is unexpected (a driver fault, a serialization error, a
    // programming mistake), and NONE of it may reach the caller: the receipt is
    // already decided and the points are already minted.
    console.error(
      `[notifications/raise] unexpected failure raising ${input.kind} for ${input.userId}`,
      error,
    );
    return false;
  }
}
