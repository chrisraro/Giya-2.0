/**
 * Draining the offline receipt outbox (doc 41 section 3, "Replay").
 *
 * Per item: presign, PUT the image, POST with the STORED `Idempotency-Key` and
 * `client_sha256`. All three steps are `submitCapturedReceipt`, the same
 * function the capture screen uses, injected rather than imported so this
 * module has no opinion about the network.
 *
 * WHY THE STORED KEY IS THE WHOLE POINT. A replay is a second (or fifth)
 * attempt at ONE logical submission. The key is minted when the consumer
 * confirms the photo and lives in the row, so the same submission keeps one
 * identity across restarts and the server replays its original answer instead
 * of filing a second receipt for the same purchase. `receipt-capture.test.tsx`
 * pins that property for a retry within one session; the stored column is what
 * carries it across a process death.
 *
 * WHAT IS NOT DURABLE HERE, AND WHY THAT IS FINE. The backoff schedule (when an
 * item may next be tried) lives in memory, not in IndexedDB. Doc 41's nine-field
 * schema has no slot for it, and losing it is safe in the only direction that
 * matters: a forgotten schedule retries SOONER, never later, and never loses a
 * receipt. What bounds the retries is `attempts`, which IS a durable column, so
 * "five attempts and then wait for a human" survives every restart. That is the
 * opposite of the module this task replaced, which kept the RECEIPT in memory.
 */

import {
  submitCapturedReceipt,
  type CaptureError,
  type ReceiptSubmissionOutcome,
} from "../receipts/upload";
import {
  deleteOutboxItem,
  listOutboxItems,
  updateOutboxItem,
  type OutboxItem,
} from "./outbox";
import {
  OUTBOX_ALREADY_SENT_MESSAGE,
  OUTBOX_FAILED_MESSAGE,
  OUTBOX_TERMINAL_MESSAGE,
  OUTBOX_UPLOADED_MESSAGE,
} from "./outbox-copy";

/** Doc 41 sections 3 and 6: the one-shot Background Sync tag. */
export const OUTBOX_SYNC_TAG = "receipt-outbox";

/** Doc 41 section 3 step 3: "exponential 30s -> 2m -> 10m -> 1h, max 5 attempts". */
export const OUTBOX_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000] as const;
export const OUTBOX_MAX_ATTEMPTS = 5;

/**
 * How long to hold an item that has just failed for the Nth time.
 *
 * `attempts` is the count AFTER the failure, so attempt 1 waits 30s. The last
 * step repeats for anything past the table, which cannot happen while
 * OUTBOX_MAX_ATTEMPTS is 5 but must not become an undefined delay if it changes.
 */
export function backoffMsForAttempts(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), OUTBOX_BACKOFF_MS.length) - 1;
  return OUTBOX_BACKOFF_MS[index] ?? OUTBOX_BACKOFF_MS[OUTBOX_BACKOFF_MS.length - 1] ?? 0;
}

/** Only this tag drains the queue; every other sync event is somebody else's. */
export function isOutboxSyncTag(tag: string | undefined): boolean {
  return tag === OUTBOX_SYNC_TAG;
}

/** The Background Sync slice of a registration, which TypeScript's DOM lib omits. */
type SyncCapableRegistration = ServiceWorkerRegistration & {
  readonly sync?: { register(tag: string): Promise<void> };
};

/**
 * Asks the browser to drain the queue in the background (doc 41 section 3
 * step 1), and reports whether it agreed to.
 *
 * `false` is the ORDINARY answer, not an error: doc 41 section 6's support
 * matrix has one-shot Background Sync unsupported on iOS Safari and on Firefox
 * Android, which between them are a large share of this market. On those
 * browsers the launch and `online` replays in
 * `src/components/pwa/receipt-outbox.tsx` are the whole story, so the caller
 * must not treat the answer as a precondition for anything. Feature-detected
 * (`'sync' in registration`), never sniffed, per doc 41 section 6.
 */
export async function registerOutboxSync(
  container: ServiceWorkerContainer | undefined,
): Promise<boolean> {
  if (container === undefined || container === null) return false;

  try {
    const registration = (await container.ready) as SyncCapableRegistration;
    if (registration.sync === undefined) return false;
    await registration.sync.register(OUTBOX_SYNC_TAG);
    return true;
  } catch {
    // Permission denied, storage blocked, or a registration that never resolves
    // ready. None of it changes what the consumer was told: the receipt is in
    // IndexedDB either way, and the fallback replays still run.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ReplayDisposition =
  /** 202. Delete the row. */
  | { readonly kind: "sent" }
  /** The server already has this submission. Delete the row, say so kindly. */
  | { readonly kind: "already-sent" }
  /** A 4xx answer on the merits. Delete the row; retrying can never work. */
  | { readonly kind: "terminal"; readonly error: string }
  /**
   * Spend an attempt and back off. `pauseSeconds` also stops the drain;
   * `clearPath` forgets the row's `image_path` so the next attempt presigns.
   */
  | {
      readonly kind: "retry";
      readonly error: string;
      readonly pauseSeconds?: number | undefined;
      readonly clearPath?: boolean | undefined;
    }
  /** Stop the drain WITHOUT spending an attempt; nothing here can succeed yet. */
  | { readonly kind: "pause"; readonly error: string; readonly pauseSeconds?: number | undefined };

/** Doc 41 section 3 step 4 treats both of these as success-already-processed. */
const ALREADY_SENT_CODES = new Set(["RECEIPT_DUPLICATE", "IDEMPOTENCY_REPLAYED"]);

/**
 * THE ONLY FAILURES THAT DELETE A CONSUMER'S RECEIPT.
 *
 * An ALLOWLIST, and the direction is the whole point. This started as
 * "any 4xx is terminal", read off doc 41 section 3's examples, and that rule
 * was already wrong for a code that exists today: `submit.ts` throws
 * `409 CONFLICT` with the message "This receipt could not be saved. Please try
 * again." on an unexpected unique-constraint violation. `mapSubmitError` has no
 * branch for it, so it arrived as kind "unknown" carrying status 409, matched
 * `>= 400 && < 500`, and the drain destroyed the only copy of a photo the
 * server had just invited us to resend.
 *
 * A denylist has to be complete to be safe, and this one could not be: every
 * future 4xx that means "wait" rather than "no" - a maintenance window, a
 * per-business pause, a verification hold - would silently start deleting
 * receipts on the day it shipped, and nothing in this repo would fail.
 * Allowlisting inverts the cost of being wrong, from PERMANENT UNRECOVERABLE
 * LOSS to a row sitting in the queue with a Retry button next to it. Doc 41
 * section 8 puts the outbox on the short list of things that are not safe to
 * lose; this is what that sentence means in code.
 *
 * Each entry is a judgement that no amount of waiting changes:
 *
 *   RECEIPT_INVALID_IMAGE  the server could not read these bytes (but see the
 *                          stale-path exception in classifyReplayOutcome)
 *   VALIDATION_FAILED      the body is malformed; the same body always will be
 *   FORBIDDEN              this caller may not do this
 *
 * Adding a code here is a decision to destroy data. Removing one costs a retry.
 */
const TERMINAL_CODES = new Set(["RECEIPT_INVALID_IMAGE", "VALIDATION_FAILED", "FORBIDDEN"]);

/**
 * `submit.ts` also throws `400 RECEIPT_INVALID_IMAGE` ("We could not find your
 * uploaded photo. Please try again.") when the object at `image_path` is
 * missing from storage - a different failure wearing the same code.
 *
 * That became reachable from the outbox only when rows started carrying
 * `image_path`: the drain now skips the presign and the PUT for a row that has
 * one, so a vanished object is answered with a code on the allowlist above
 * while the bytes are still sitting in IndexedDB and one fresh ticket would
 * have sent them.
 */
const STALE_PATH_CODE = "RECEIPT_INVALID_IMAGE";

/**
 * How long to wait when the server told us to slow down without a usable
 * `Retry-After`. One minute is the smallest pause that is not effectively a
 * busy loop, and erring short is safe: the server simply says so again.
 */
const SERVER_PAUSE_FALLBACK_SECONDS = 60;

/**
 * 4xx codes that mean "wait", not "no", and that carry a `Retry-After` saying
 * how long.
 *
 * `CONSUMER_SCAN_BLOCKED` is here and it is the important one.
 * `submit.ts`'s `assertNotBlocked` throws it for doc 37's consequences ladder
 * against `consumers.blocked_until`: the block is, in that code's own words,
 * "automatic, auto-expiring, audited", the consumer is told "Please try again
 * later", and the response carries the exact number of seconds until it lifts.
 *
 * Doc 41 section 3's terminal examples - `RECEIPT_DUPLICATE`,
 * `VALIDATION_FAILED` - are permanent judgements ABOUT THE RECEIPT. This is a
 * temporary judgement ABOUT THE ACCOUNT. Letting it fall through to the generic
 * 4xx branch deleted a photo that was never uploaded and that nothing on the
 * server can restore, over a cooldown that expires by itself. Section 8 puts
 * the outbox on the short list of things that are not safe to lose.
 */
const WAIT_AND_RETRY_CODES = new Set(["CONSUMER_SCAN_BLOCKED"]);

/**
 * What the drain should do about one submission's outcome.
 *
 * The order of the branches is the specification, not a style choice:
 *
 *   OFFLINE first, because `submitCapturedReceipt` returns it BEFORE it fetches
 *   anything. No attempt was made, so counting one would burn all five over
 *   five signal-less launches and mark every receipt failed without a single
 *   one of them having been sent.
 *
 *   401 next, for the same reason from the other end: nothing in the queue can
 *   succeed signed out, and spending attempts on a session the consumer can
 *   renew in ten seconds would delete their queue for them.
 *
 *   429 next, because it is a 4xx that IS worth retrying, and because doc 41
 *   makes it pause the whole drain.
 *
 *   Then the TERMINAL ALLOWLIST, and nothing else deletes anything. Everything
 *   that reaches the bottom of this function is retried, spends an attempt, and
 *   after five of them lands in `failed` - which keeps the row and hands it to
 *   the Retry button the queue card draws. See `TERMINAL_CODES` for why the
 *   default has to be that way round.
 *
 * `reusedStoredPath` says whether this attempt sent the `image_path` already on
 * the row (true) or presigned a fresh one for itself (false). It changes the
 * meaning of exactly one code; see `STALE_PATH_CODE`. It is a required
 * parameter rather than an option with a default, because the safe answer
 * differs between the two and a default would silently pick one.
 */
export function classifyReplayOutcome(
  outcome: ReceiptSubmissionOutcome,
  reusedStoredPath: boolean,
): ReplayDisposition {
  if (outcome.ok) return { kind: "sent" };

  const error: CaptureError = outcome.error;

  if (error.code === "OFFLINE") return { kind: "pause", error: "offline" };
  if (error.kind === "unauthenticated") return { kind: "pause", error: "unauthenticated" };

  // Both branches of "the server told us to wait, and said for how long".
  // WAIT_AND_RETRY_CODES is checked BEFORE the generic 4xx rule below, because
  // status alone cannot tell a permanent refusal from an auto-expiring one.
  if (error.kind === "rate_limited" || WAIT_AND_RETRY_CODES.has(error.code)) {
    return {
      kind: "retry",
      error: error.kind === "rate_limited" ? "rate_limited" : error.code.toLowerCase(),
      pauseSeconds: error.retryAfterSeconds ?? SERVER_PAUSE_FALLBACK_SECONDS,
    };
  }

  if (ALREADY_SENT_CODES.has(error.code)) return { kind: "already-sent" };

  // The stale-path exception, checked before the allowlist because it wears an
  // allowlisted code. The bytes are in IndexedDB and the object they were
  // uploaded to is gone, so the remedy is a fresh ticket, not a funeral.
  if (error.code === STALE_PATH_CODE && reusedStoredPath) {
    return { kind: "retry", error: "stale_image_path", clearPath: true };
  }

  if (TERMINAL_CODES.has(error.code)) return { kind: "terminal", error: error.code };

  // Everything else - unmapped codes, 5xx, transport failures, and every 4xx
  // nobody has written down yet. Retrying costs a row in the queue; guessing
  // terminal costs the receipt.
  return { kind: "retry", error: error.kind };
}

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

export type SubmitReceipt = typeof submitCapturedReceipt;

/** What the UI is told, one per item the drain resolved. */
export type OutboxReplayEvent = {
  readonly type: "sent" | "already-sent" | "terminal" | "failed";
  readonly id: string;
  readonly message: string;
};

/**
 * When each item may next be attempted, and when the drain as a whole may
 * resume. In memory on purpose; see this file's header for why that is safe
 * here and was not safe for the receipts themselves.
 */
export interface BackoffSchedule {
  readonly itemDueAt: Map<string, number>;
  /** Set by a `Retry-After`, and it gates every item, not just the one. */
  drainDueAt: number;
}

export function createBackoffSchedule(): BackoffSchedule {
  return { itemDueAt: new Map<string, number>(), drainDueAt: 0 };
}

export interface DrainDeps {
  /** `submitCapturedReceipt` in production. Never defaulted: see below. */
  readonly submit: SubmitReceipt;
  readonly now: () => number;
  readonly schedule: BackoffSchedule;
  /**
   * May this run touch rows that have already spent their five attempts?
   *
   * Required, never optional, because it is a decision about a consumer's last
   * copy of a receipt and every caller has to make it out loud. `true` only for
   * runs triggered by a genuinely new circumstance - an `online` transition, a
   * Background Sync event, a tap on Retry - and never for the ordinary drain
   * that happens whenever the queue card mounts.
   *
   * Doc 41's own sketch drains `['queued','failed']` unconditionally. This is
   * narrower because five attempts are spendable in one bad afternoon and a
   * hair-trigger re-drain would spend them; it is wider than "never", because
   * doc 41 section 8 gives an iOS outbox about seven days before eviction and a
   * row nothing will ever touch again is a receipt with a deadline on it.
   */
  readonly retryFailed: boolean;
  readonly notify: (event: OutboxReplayEvent) => void;
}

export interface DrainResult {
  readonly attempted: number;
  readonly sent: number;
  readonly removed: number;
  readonly paused: boolean;
  readonly pauseSeconds: number | null;
}

/**
 * A row this run is allowed to pick up.
 *
 * `uploading` is always included, which is a deliberate departure from doc 41's
 * `getAll({status: ['queued','failed']})` sketch: a row is only ever
 * `uploading` because an attempt did not report back (the tab was closed, the
 * worker was killed), and leaving it out strands that receipt on the phone
 * forever with no automatic path out. The stored Idempotency-Key is what makes
 * picking it up again safe.
 *
 * `failed` depends on `retryFailed`; see `DrainDeps`.
 */
function isDrainable(item: OutboxItem, retryFailed: boolean): boolean {
  if (item.status === "failed") return retryFailed;
  return item.status === "queued" || item.status === "uploading";
}

/**
 * Drains the queue FIFO, one item at a time.
 *
 * Never throws. It runs unattended on app launch and inside a `sync` handler,
 * where an unhandled rejection is a broken worker rather than a visible bug, and
 * a browser with no IndexedDB has to cost an inert no-op.
 */
export async function drainOutbox(deps: DrainDeps): Promise<DrainResult> {
  let attempted = 0;
  let sent = 0;
  let removed = 0;
  let pauseSeconds: number | null = null;

  const now = deps.now();
  if (now < deps.schedule.drainDueAt) {
    return { attempted, sent, removed, paused: true, pauseSeconds: null };
  }

  let items: OutboxItem[];
  try {
    items = await listOutboxItems();
  } catch {
    return { attempted, sent, removed, paused: false, pauseSeconds: null };
  }

  for (const item of items) {
    if (!isDrainable(item, deps.retryFailed)) continue;
    if (deps.now() < (deps.schedule.itemDueAt.get(item.id) ?? 0)) continue;

    await updateOutboxItem(item.id, { status: "uploading" });
    attempted += 1;

    // Whether this attempt is about to reuse a path from an earlier one. Read
    // before the submit, because the outcome carries whatever path the attempt
    // ENDED with and that cannot tell the two cases apart.
    const reusedStoredPath = (item.image_path ?? null) !== null;

    const outcome = await deps.submit({
      blob: item.image,
      idempotencyKey: item.idempotency_key,
      // Stored as null; the wire format omits an absent field rather than
      // sending a literal null, and the two spell differently in a body the
      // server fingerprints under the Idempotency-Key.
      businessId: item.business_id ?? undefined,
      clientSha256: item.client_sha256 ?? undefined,
      // The path this submission already uploaded to, if any. Reusing it is
      // what keeps the body byte-identical across replays; see
      // `OutboxItem.image_path` for what re-presigning costs.
      imagePath: item.image_path ?? null,
    });

    const disposition = classifyReplayOutcome(outcome, reusedStoredPath);

    if (disposition.kind === "sent" || disposition.kind === "already-sent") {
      await deleteOutboxItem(item.id);
      deps.schedule.itemDueAt.delete(item.id);
      removed += 1;
      if (disposition.kind === "sent") sent += 1;
      deps.notify({
        type: disposition.kind,
        id: item.id,
        message: disposition.kind === "sent" ? OUTBOX_UPLOADED_MESSAGE : OUTBOX_ALREADY_SENT_MESSAGE,
      });
      continue;
    }

    if (disposition.kind === "terminal") {
      await deleteOutboxItem(item.id);
      deps.schedule.itemDueAt.delete(item.id);
      removed += 1;
      deps.notify({ type: "terminal", id: item.id, message: OUTBOX_TERMINAL_MESSAGE });
      continue;
    }

    if (disposition.kind === "pause") {
      // No attempt was made, so nothing is counted and the row goes back to
      // waiting exactly as it was - INCLUDING a `failed` row, which a
      // retryFailed run can have reached. Writing "queued" unconditionally
      // would quietly promote a spent row, taking its Retry button and its
      // "Not sent yet" label away while nothing was going to retry it.
      await updateOutboxItem(item.id, {
        status: item.status,
        image_path: outcome.imagePath,
      });
      attempted -= 1;
      return { attempted, sent, removed, paused: true, pauseSeconds: null };
    }

    // Capped, so an item that keeps failing across `online` events does not
    // climb forever and the "you have run out of attempts" announcement below
    // fires on the transition rather than every time.
    const attempts = Math.min(item.attempts + 1, OUTBOX_MAX_ATTEMPTS);
    const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;
    await updateOutboxItem(item.id, {
      attempts,
      last_error: disposition.error,
      status: exhausted ? "failed" : "queued",
      // Persisted on EVERY surviving row: an attempt that presigned and
      // uploaded before it failed leaves its path here, and an attempt whose
      // PUT itself failed leaves null so the next one mints a fresh ticket.
      // `clearPath` forces null for a path the server says points at nothing.
      image_path: disposition.clearPath === true ? null : outcome.imagePath,
    });

    // Held even when exhausted, so ten `online` events in a minute cost the
    // server nothing. backoffMsForAttempts clamps to the last step, one hour.
    deps.schedule.itemDueAt.set(item.id, deps.now() + backoffMsForAttempts(attempts));

    if (exhausted && item.attempts < OUTBOX_MAX_ATTEMPTS) {
      // The row STAYS. Doc 41 section 8: the outbox is the one thing on the
      // device that is not safe to lose, so running out of automatic retries
      // hands the receipt to a button, it does not throw the photo away.
      deps.notify({ type: "failed", id: item.id, message: OUTBOX_FAILED_MESSAGE });
    }

    if (disposition.pauseSeconds !== undefined) {
      pauseSeconds = disposition.pauseSeconds;
      deps.schedule.drainDueAt = deps.now() + disposition.pauseSeconds * 1000;
      return { attempted, sent, removed, paused: true, pauseSeconds };
    }
  }

  return { attempted, sent, removed, paused: false, pauseSeconds };
}
