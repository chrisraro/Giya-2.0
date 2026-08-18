import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { notificationRoute } from "@/features/notifications/kinds";
import { rejectionCopy } from "@/features/receipts/components/receipt-copy";
import type { ReceiptRejectReason } from "@/features/receipts/types";
import { getServerEnv } from "@/lib/env";
import { jobLogger, type Logger } from "@/lib/log";
import { renderEmail } from "@/lib/email/render";
import type { EmailCopy } from "@/lib/email/render";
import { sendEmail } from "@/lib/email/send";
import type { Database } from "@/lib/supabase/types";

import type { NotifyEmailPayload } from "./schemas";

// =============================================================================
// The `notify.email` worker. Doc 39's worker invocation contract, step 4.
// =============================================================================
//
// Signature verification, payload parsing and the job claim all happen before
// this function is reached (see ../../app/api/jobs/notify.email/route.ts). What
// is left is the work itself, and it is deliberately a plain function of a
// payload and a client: doc 39 puts route files in src/app/api/** and logic in
// src/workers/**, and the split earns its keep here because everything
// interesting below is testable without an HTTP request.
//
// -----------------------------------------------------------------------------
// IDEMPOTENCY, TWICE
// -----------------------------------------------------------------------------
// Doc 39 requires a worker to be safe under duplicate delivery, and this one is
// guarded at two independent levels because they fail independently:
//
//   1. BY JOB. The claim (src/lib/queue/claim.ts) is a compare-and-swap on the
//      job row, so a second delivery of the same message never reaches this
//      function at all.
//   2. BY ENTITY. Every send is gated on `notifications.status = 'pending'` and
//      the row is moved to 'sent' the moment the provider accepts. Doc 39,
//      `notify.email`: "the worker sends only rows still pending ... a replayed
//      batch re-sends nothing already sent."
//
// Level 2 is the one that matters, and the reason is the gap level 1 cannot
// close: a worker that sends the email and then dies before recording the
// outcome leaves a `running` job that the reclaim path will legitimately hand
// to a later invocation. Without the per-row status, that invocation sends the
// email again. With it, the row already says 'sent' and the replay is a no-op.
//
// An email is the one side effect in this codebase that cannot be undone, so it
// gets the belt and the braces.
//
// -----------------------------------------------------------------------------
// THE WORDS ARE THE ROW'S, NOT THIS FILE'S
// -----------------------------------------------------------------------------
// `title` and `body` are read from the notification row and rendered verbatim.
// They were composed by src/features/receipts/server/notify.ts from
// receipt-copy.ts - the consumer-safe matrix that is swept, string by string,
// against doc 37's fraud vocabulary - and 0026 makes them immutable after the
// fact precisely so that a message says what it said when it was sent.
//
// Re-deriving them here would create a second set of rejection strings outside
// that sweep, which is the exact defect receipts/server/notify.ts's header
// warns about, made worse: an email persists in an inbox and is indexed by a
// mail provider, so a leak that narrows the search space for an abuser leaks
// permanently.
//
// The ONE thing the row does not carry is the call to action's label, because
// the in-app inbox renders the whole row as a link and never needs one. It is
// taken from receipt-copy.ts's own matrix (label AND href together, as the
// matched pair the matrix defines) rather than invented here, so this file
// still authors no copy.
//
// NOTHING ELSE from the receipt is read. Not `reject_note`, not a signal, not a
// score, not a confidence, not the matched receipt. The worker never touches
// the `receipts` table at all; the only receipt-shaped value it reads is
// `data.params.reject_reason`, which is one of six enum values the consumer is
// already shown on their own status screen.

// The correlation key is the `job_id` the payload already carries and
// src/lib/queue/claim.ts already leases - not a second scheme. The logger is
// THREADED THROUGH the per-row helpers rather than reconstructed in each of
// them, because the deepest call sites here (a preference read, an address
// lookup) are the ones whose old lines named a user and nothing else: findable
// only by someone who already knew which incident they were looking at.

export interface NotifyEmailDeps {
  /** SERVICE ROLE. `notifications` has no client write policy and `auth.admin`
   * is service-role only, so nothing here works without it. */
  readonly supabase: SupabaseClient<Database>;
  /** Injected in tests; defaults to the real Resend gateway. */
  readonly send?: typeof sendEmail;
  /** Injected in tests; defaults to APP_ORIGIN, then QSTASH_CALLBACK_ORIGIN. */
  readonly origin?: string | null;
  /** Injected in tests; resolves the recipient's address from `auth.users`. */
  readonly resolveAddress?: (userId: string) => Promise<string | null>;
}

export interface NotifyEmailResult {
  readonly sent: number;
  /** Rows that were not sent and should not be: already sent, suppressed by a
   * preference, no address, not an email row. Not failures. */
  readonly skipped: number;
  /** Rows whose send failed terminally. Recorded on the row, not retried. */
  readonly failedTerminal: number;
  /** Rows whose send failed in a way another attempt could fix. */
  readonly failedRetryable: number;
}

interface NotificationRow {
  id: string;
  user_id: string;
  business_id: string | null;
  kind: string;
  channel: string;
  status: string;
  title: string;
  body: string;
  data: unknown;
}

const NOTIFICATION_COLUMNS =
  "id, user_id, business_id, kind, channel, status, title, body, data";

/**
 * Send one batch of pending email notifications.
 *
 * Never throws: every row is handled independently and a fault on one is
 * recorded on that row rather than abandoning the other 499. The route turns
 * `failedRetryable > 0` into the one 5xx it is allowed to return.
 */
export async function runNotifyEmail(
  payload: NotifyEmailPayload,
  deps: NotifyEmailDeps,
): Promise<NotifyEmailResult> {
  const { supabase } = deps;
  const send = deps.send ?? sendEmail;
  const origin = deps.origin === undefined ? resolveOrigin() : deps.origin;
  const log = jobLogger(payload.job_id).with({ worker: "notify.email" });
  const resolveAddress =
    deps.resolveAddress ?? ((userId: string) => readAddress(supabase, userId, log));

  let sent = 0;
  let skipped = 0;
  let failedTerminal = 0;
  let failedRetryable = 0;

  const { data: rows, error } = await supabase
    .from("notifications")
    .select(NOTIFICATION_COLUMNS)
    .in("id", payload.notification_ids)
    // The idempotency gate, expressed in the QUERY rather than in a branch
    // below, so there is no code path at all that reads a non-pending row and
    // then decides what to do with it.
    .eq("channel", "email")
    .eq("status", "pending")
    .returns<NotificationRow[]>();

  if (error !== null) {
    // The batch could not even be read. Retryable: the rows are still pending
    // and a later delivery will find them.
    log.error("could not read the batch", {
      err: error,
      requested: payload.notification_ids.length,
    });
    return { sent: 0, skipped: 0, failedTerminal: 0, failedRetryable: payload.notification_ids.length };
  }

  const found = rows ?? [];
  // Every id that did not come back was already sent, already failed, or is not
  // an email row. All three are correct no-ops under replay.
  skipped += payload.notification_ids.length - found.length;

  for (const row of found) {
    const outcome = await deliver(row, { supabase, send, origin, resolveAddress, log });
    if (outcome === "sent") sent += 1;
    else if (outcome === "skipped") skipped += 1;
    else if (outcome === "terminal") failedTerminal += 1;
    else failedRetryable += 1;
  }

  log.info("batch complete", {
    requested: payload.notification_ids.length,
    sent,
    skipped,
    terminal: failedTerminal,
    retryable: failedRetryable,
  });

  return { sent, skipped, failedTerminal, failedRetryable };
}

type DeliveryOutcome = "sent" | "skipped" | "terminal" | "retryable";

interface DeliverDeps {
  readonly supabase: SupabaseClient<Database>;
  readonly send: typeof sendEmail;
  readonly origin: string | null;
  readonly resolveAddress: (userId: string) => Promise<string | null>;
  readonly log: Logger;
}

async function deliver(row: NotificationRow, deps: DeliverDeps): Promise<DeliveryOutcome> {
  try {
    // Doc 30 section 5.5: preferences are re-checked BY THE WORKER, not only at
    // fan-out. The window between the two is small and the rule is not about
    // size: an opt-out that arrives after the row was written must win, because
    // the consumer's last word is the one that counts.
    const suppression = await suppressionReason(deps.supabase, row.user_id, row.kind, deps.log);
    if (suppression !== null) {
      await markRow(deps.supabase, row.id, "failed", suppression, deps.log);
      return "skipped";
    }

    const address = await deps.resolveAddress(row.user_id);
    if (address === null) {
      // No address on the account. Terminal by nature - an address does not
      // appear because we asked five times - and recorded on the row so an
      // operator can see why this consumer never hears from us.
      await markRow(deps.supabase, row.id, "failed", "no email address on the account", deps.log);
      return "skipped";
    }

    const rendered = renderEmail({
      copy: emailCopy(row, deps.origin),
      origin: deps.origin,
      businessName: null,
    });

    const result = await deps.send({
      to: address,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });

    if (result.ok) {
      await markRow(deps.supabase, row.id, "sent", null, deps.log);
      return "sent";
    }

    if (result.retryable) {
      // Left PENDING on purpose. Moving it to 'failed' would take it out of the
      // query above, and the next delivery of this job would find nothing to
      // do - which is exactly the message being dropped silently. The job row
      // carries the failure; the notification row carries only outcomes that
      // are final.
      deps.log.warn("retryable send failure; row left pending", {
        notification_id: row.id,
        user_id: row.user_id,
        reason: result.reason,
      });
      return "retryable";
    }

    await markRow(deps.supabase, row.id, "failed", result.reason, deps.log);
    return "terminal";
  } catch (error) {
    // One row's fault must not abandon the rest of the batch. Treated as
    // retryable because an unexpected exception is not evidence that another
    // attempt would fail the same way.
    deps.log.error("unexpected failure delivering a row", {
      err: error,
      notification_id: row.id,
      user_id: row.user_id,
    });
    return "retryable";
  }
}

/**
 * Kinds addressed to business staff rather than a consumer (doc 30 section
 * 5.3's staff-facing row). Review fix (task 1.2, I4): a profile with no
 * `consumers` row is EXPECTED for one of these - `campaign_budget_exhausted`
 * is addressed to a business owner, who by definition never has a consumers
 * row - so it must not be suppressed on that basis alone. Every OTHER kind
 * that reaches this channel is still consumer-only, and a staff profile
 * there remains a mismatch worth suppressing rather than emailing
 * incorrectly.
 */
const STAFF_FACING_KINDS: ReadonlySet<string> = new Set(["campaign_budget_exhausted"]);

/**
 * Why this recipient must not be emailed, or null when they may be.
 *
 * Fails CLOSED: an unreadable preference row suppresses the send. That is the
 * opposite of most reads in this codebase and it is the right direction here,
 * because the two answers are not symmetric - a message not sent can be sent
 * later, and a message sent to someone who opted out cannot be unsent.
 */
async function suppressionReason(
  supabase: SupabaseClient<Database>,
  userId: string,
  kind: string,
  log: Logger,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_suspended, consumers(email_enabled)")
    .eq("id", userId)
    .maybeSingle<{ is_suspended: boolean; consumers: { email_enabled: boolean } | null }>();

  if (error !== null) {
    log.error("could not read preferences; failing closed", { err: error, user_id: userId });
    return "preferences unreadable";
  }
  if (data === null) return "no profile";

  // Doc 30 section 5.5: "Suspended users receive nothing except
  // suspension/appeal emails." This is not one of those. Applies to staff
  // and consumers alike - `is_suspended` is a platform-wide identity column
  // (0002), not a consumer-only one.
  if (data.is_suspended) return "recipient is suspended";

  // Review fix (task 1.2, N6): checked BEFORE either consumer-shaped
  // suppression below, unconditionally. Doc 30 section 5.5 treats a
  // staff-facing kind as a transactional business alert, not a consumer
  // preference - and an owner who ALSO happens to hold a `consumers` row
  // (nothing prevents one person from being both) must not have
  // `campaign_budget_exhausted` muted by THAT row's `email_enabled` toggle,
  // any more than a staff profile with no `consumers` row at all should be
  // suppressed by "recipient is not a consumer" (review I4, below). Both are
  // the same mismatch in opposite directions; this bypasses both at once.
  if (STAFF_FACING_KINDS.has(kind)) return null;

  if (data.consumers === null) {
    // A profile with no consumers row is staff, and every kind that reaches
    // here is consumer-only (the one staff-facing kind was already handled
    // above), so this remains a mismatch worth suppressing.
    return "recipient is not a consumer";
  }

  // Doc 30 section 5.5 exempts TRANSACTIONAL email from `email_enabled`, and
  // its examples are account and security mail: password change, staff invite,
  // verification decision. A receipt rejection is none of those. It is an
  // outcome the consumer can also read in the app at any time, so honouring the
  // toggle costs them nothing they cannot get, and overriding it would spend
  // the exemption that exists for messages they genuinely cannot afford to
  // miss.
  if (!data.consumers.email_enabled) return "recipient has email turned off";

  return null;
}

/**
 * The recipient's address, from `auth.users`.
 *
 * `profiles` deliberately carries no email column (0002): the address is
 * authentication data and lives with the identity, so the one way to read it is
 * the admin API under the service role. Fails soft to null, which the caller
 * records on the row as a terminal reason.
 */
async function readAddress(
  supabase: SupabaseClient<Database>,
  userId: string,
  log: Logger,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error !== null || data.user === null) {
      log.error("could not read the address", { err: error, user_id: userId });
      return null;
    }
    const email = data.user.email;
    return email === undefined || email.length === 0 ? null : email;
  } catch (error) {
    log.error("unexpected failure reading the address", { err: error, user_id: userId });
    return null;
  }
}

/**
 * The email's copy: the stored message plus the matrix's own call to action.
 *
 * See the module header for why the title and body are read rather than
 * composed. The action is looked up from receipt-copy.ts as a matched
 * label-and-href pair, and it is dropped entirely when there is no origin to
 * make the href absolute (render.ts refuses a relative link rather than
 * shipping one that goes nowhere).
 */
export function emailCopy(row: NotificationRow, origin: string | null): EmailCopy {
  const base = { title: row.title, body: row.body };
  if (origin === null) return base;

  if (row.kind === "receipt_rejected") {
    // `rejectionCopy(null)` is a real branch of the matrix, so an unreadable or
    // absent reason needs no special case: it yields the generic rejection's
    // action, which is the same one the consumer sees on their status screen.
    const action = rejectionCopy(readRejectReason(row.data)).action;
    return action === undefined ? base : { ...base, action };
  }

  // Any other kind that reaches this channel later: link to wherever the row
  // already points, with a neutral label. `notificationRoute` has already
  // shape-checked the stored route (one leading slash, never two), and
  // render.ts checks it again on the way out.
  const route = notificationRoute(row.data);
  return route === null ? base : { ...base, action: { label: "Open Giya", href: route } };
}

/** `data.params.reject_reason`, treated as untrusted even though only the
 * service role writes it: it is a jsonb column, and the matrix's default branch
 * is the correct answer to anything unrecognised. */
function readRejectReason(data: unknown): ReceiptRejectReason | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const params = (data as Record<string, unknown>).params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const reason = (params as Record<string, unknown>).reject_reason;
  return typeof reason === "string" ? (reason as ReceiptRejectReason) : null;
}

/** Doc 39: the worker updates status/sent_at/error per row. 0030 widened the
 * immutability trigger by exactly these three columns and no others. */
async function markRow(
  supabase: SupabaseClient<Database>,
  notificationId: string,
  status: "sent" | "failed",
  error: string | null,
  log: Logger,
): Promise<void> {
  const { error: updateError } = await supabase
    .from("notifications")
    .update({
      status,
      sent_at: status === "sent" ? new Date().toISOString() : null,
      error,
    })
    .eq("id", notificationId)
    // Re-asserted so a row that another invocation moved in the meantime is a
    // no-op rather than an overwrite. Same shape as 0028's sweep, and the same
    // reason: the predicate that selected the row must hold at the write.
    .eq("status", "pending");

  if (updateError !== null) {
    // The email is already out. This is bookkeeping, and losing it must not
    // change what the route tells QStash - reporting a failure here would
    // re-send a message that has already arrived.
    log.error("sent, but could not record the outcome on the row", {
      err: updateError,
      notification_id: notificationId,
      status,
    });
  }
}

/**
 * The origin links are made absolute against: the app's own, then the callback
 * origin, then nothing. See env.ts for why the two keys exist separately.
 */
function resolveOrigin(): string | null {
  try {
    const env = getServerEnv();
    return env.APP_ORIGIN ?? env.QSTASH_CALLBACK_ORIGIN ?? null;
  } catch {
    return null;
  }
}
