import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { enqueue } from "@/lib/queue/publish";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import { kindEmails } from "../kinds";
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
// WHAT THIS FUNCTION NOW DOES: THE SECOND CHANNEL
// ---------------------------------------------------------------------------
// Doc 30 section 5.2 step 3 has the fan-out insert one row PER CHANNEL and then
// enqueue the sends. This function does both, and both are inside the same
// swallow: `notify.email` is published only for kinds whose registry entry lists
// the email channel (today exactly one, `receipt_rejected`; ../kinds.ts argues
// each inclusion and each exclusion at length).
//
// The ORDER matters and it is doc 39's, not a preference:
//
//   1. the in_app row      - the guaranteed channel (doc 33 calls the inbox
//                            "the guaranteed fallback channel on every
//                            platform"), so it lands first and alone decides
//                            whether this function reports success
//   2. the email row       - `status='pending'`, durable BEFORE any send is
//                            attempted, which is what makes the send idempotent
//                            and replayable
//   3. the enqueue         - which itself writes a `jobs` row before publishing
//
// Every step after the first is best effort. A consumer who gets the inbox
// message and no email has been told; a consumer who gets neither has not. So
// the email row failing, or QStash being unreachable, returns `true` and logs -
// and `enqueue` itself never throws, for the same reason this function does not.
//
// `notify.push` is still absent: there are no VAPID keys and no service worker
// push registration, so a push row would be a row nothing sends. It arrives with
// the slice that can deliver it, which is the rule ../kinds.ts and 0026 both
// follow.
//
// It does not render templates or resolve preferences either. Doc 30 section
// 5.2 steps 1-2 belong to the CALLER here, deliberately: the receipt kinds'
// copy is the fraud-safe matrix in receipt-copy.ts and must not be duplicated
// (see ../kinds.ts). Preference gating (doc 30 section 5.5) is not done here
// either, and that is now a positive decision rather than an absence: doc 30
// requires the check "at fan-out AND re-checked by the worker at send time",
// and doing it only in the worker is the half that cannot go stale. A consumer
// who turns email off between the row landing and the send is honoured; one who
// was checked here and not there would not be. The cost is a `pending` row that
// resolves to `failed` with a suppression reason, which is a more useful record
// than no row at all.
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

    const message = {
      user_id: input.userId,
      business_id: input.businessId ?? null,
      kind: input.kind,
      title,
      body,
      data: (input.data ?? {}) as Json,
    };

    const { error } = await deps.supabase.from("notifications").insert({
      ...message,
      // The inbox row. `sent` at insert because there is no send to wait for:
      // doc 30 section 5.2 step 3, "in_app rows are sent immediately". Written
      // explicitly rather than left to 0030's `pending` default, which is right
      // for the channels that have a worker and wrong for this one.
      channel: "in_app",
      status: "sent",
      sent_at: new Date().toISOString(),
    });

    if (error !== null) {
      console.error(
        `[notifications/raise] could not raise ${input.kind} for ${input.userId}`,
        error,
      );
      return false;
    }

    // Doc 30 section 5.2 step 3's second half. Everything below is best effort
    // and cannot change what this function returns: the guaranteed channel has
    // already landed.
    if (kindEmails(input.kind)) {
      await raiseEmailChannel(deps, message);
    }

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

interface ChannelMessage {
  user_id: string;
  business_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
  data: Json;
}

/**
 * The email half of the fan-out: one `channel='email'`, `status='pending'` row,
 * then one `notify.email` job for it.
 *
 * ROW FIRST, JOB SECOND, for the reason the queue publisher states about its own
 * two writes: the row is the thing that makes the send idempotent and
 * replayable, so it must exist before anything can be asked to send it. A job
 * published for a row that is not there would fail on every delivery until it
 * died; a row with no job is picked up the moment anyone re-enqueues it, and in
 * the meantime it is a visible `pending` row rather than a message that
 * silently never existed.
 *
 * Returns nothing and never throws. See the module header: the inbox row has
 * already landed and the caller's own work is long committed.
 */
async function raiseEmailChannel(
  deps: RaiseNotificationDeps,
  message: ChannelMessage,
): Promise<void> {
  const { data: inserted, error } = await deps.supabase
    .from("notifications")
    .insert({ ...message, channel: "email", status: "pending" })
    .select("id")
    .single();

  if (error !== null || inserted === null) {
    console.error(
      `[notifications/raise] could not raise the email channel for ${message.kind}`,
      error,
    );
    return;
  }

  // Doc 39's `notify.email` contract: `{job_id, notification_ids}` with dedupe
  // key `notification_id` for a singleton. The dedupe key is the row's own id,
  // which makes a double-enqueue of the same message impossible while the first
  // job is in flight - and, because `jobs_dedupe_idx` is partial over
  // queued/running, still allows an operator replay after it has finished.
  const result = await enqueue({
    queue: "notify.email",
    payload: { notification_ids: [inserted.id] },
    businessId: message.business_id,
    dedupeKey: inserted.id,
  });

  if (result.status === "failed") {
    console.error(
      `[notifications/raise] email row ${inserted.id} exists but could not be enqueued: ${result.reason}`,
    );
  }
}
