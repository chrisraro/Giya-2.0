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
  /** Spend an attempt and back off. `pauseSeconds` also stops the drain. */
  | { readonly kind: "retry"; readonly error: string; readonly pauseSeconds?: number | undefined }
  /** Stop the drain WITHOUT spending an attempt; nothing here can succeed yet. */
  | { readonly kind: "pause"; readonly error: string; readonly pauseSeconds?: number | undefined };

/** Doc 41 section 3 step 4 treats both of these as success-already-processed. */
const ALREADY_SENT_CODES = new Set(["RECEIPT_DUPLICATE", "IDEMPOTENCY_REPLAYED"]);

/**
 * How long to wait when the server rate-limited us without a usable
 * `Retry-After`. One minute is the smallest pause that is not effectively a
 * busy loop against a limiter.
 */
const RATE_LIMIT_FALLBACK_SECONDS = 60;

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
 *   409 IDEMPOTENCY_IN_PROGRESS next, the other 4xx that waiting fixes.
 *
 *   Then the generic rule: any remaining 4xx is an ANSWER, not a missing
 *   connection, and is terminal. This branch is why `CaptureError` carries a
 *   status at all. Classifying by `kind` would send an unmapped 400 round the
 *   retry loop five times, because `mapSubmitError`'s fallback is written for a
 *   screen with a Try again button rather than for an unattended drain.
 */
export function classifyReplayOutcome(outcome: ReceiptSubmissionOutcome): ReplayDisposition {
  if (outcome.ok) return { kind: "sent" };

  const error: CaptureError = outcome.error;

  if (error.code === "OFFLINE") return { kind: "pause", error: "offline" };
  if (error.kind === "unauthenticated") return { kind: "pause", error: "unauthenticated" };

  if (error.kind === "rate_limited") {
    return {
      kind: "retry",
      error: "rate_limited",
      pauseSeconds: error.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS,
    };
  }

  if (ALREADY_SENT_CODES.has(error.code)) return { kind: "already-sent" };
  if (error.kind === "in_progress") return { kind: "retry", error: "in_progress" };

  if (error.status !== undefined && error.status >= 400 && error.status < 500) {
    return { kind: "terminal", error: error.code };
  }

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
 * A row the automatic drain is allowed to pick up.
 *
 * `failed` is excluded: five attempts are spent and doc 41 hands it to the
 * manual Retry button. `uploading` is INCLUDED, which is a deliberate departure
 * from doc 41's `getAll({status: ['queued','failed']})` sketch: a row is only
 * ever `uploading` because an attempt did not report back (the tab was closed,
 * the worker was killed), and leaving it out strands that receipt on the phone
 * forever with no automatic path out. The stored Idempotency-Key is what makes
 * picking it up again safe.
 */
function isDrainable(item: OutboxItem): boolean {
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
    if (!isDrainable(item)) continue;
    if (deps.now() < (deps.schedule.itemDueAt.get(item.id) ?? 0)) continue;

    await updateOutboxItem(item.id, { status: "uploading" });
    attempted += 1;

    const outcome = await deps.submit({
      blob: item.image,
      idempotencyKey: item.idempotency_key,
      // Stored as null; the wire format omits an absent field rather than
      // sending a literal null, and the two spell differently in a body the
      // server fingerprints under the Idempotency-Key.
      businessId: item.business_id ?? undefined,
      clientSha256: item.client_sha256 ?? undefined,
      imagePath: null,
    });

    const disposition = classifyReplayOutcome(outcome);

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
      // waiting exactly as it was.
      await updateOutboxItem(item.id, { status: item.status === "failed" ? "failed" : "queued" });
      attempted -= 1;
      return { attempted, sent, removed, paused: true, pauseSeconds: null };
    }

    const attempts = item.attempts + 1;
    const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;
    await updateOutboxItem(item.id, {
      attempts,
      last_error: disposition.error,
      status: exhausted ? "failed" : "queued",
    });

    if (exhausted) {
      // The row STAYS. Doc 41 section 8: the outbox is the one thing on the
      // device that is not safe to lose, so running out of automatic retries
      // hands the receipt to a button, it does not throw the photo away.
      deps.notify({ type: "failed", id: item.id, message: OUTBOX_FAILED_MESSAGE });
    } else {
      deps.schedule.itemDueAt.set(item.id, deps.now() + backoffMsForAttempts(attempts));
    }

    if (disposition.pauseSeconds !== undefined) {
      pauseSeconds = disposition.pauseSeconds;
      deps.schedule.drainDueAt = deps.now() + disposition.pauseSeconds * 1000;
      return { attempted, sent, removed, paused: true, pauseSeconds };
    }
  }

  return { attempted, sent, removed, paused: false, pauseSeconds };
}
