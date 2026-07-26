// The queue registry, in code.
//
// docs/30-modules/39-background-jobs.md is the canonical registry ("a queue
// that is not listed here does not exist, and adding one requires a PR that
// updates this file"). This module is that document's executable half: the
// names, the retry budget, the flow-control key and the timeout for each queue
// this build actually serves.
//
// PURE. No database, no network, no `server-only`. It is imported by the
// publisher, by the worker routes and by their tests, and a registry that could
// not be read without a Supabase client would be a registry nobody checks.
//
// ---------------------------------------------------------------------------
// WHY THE REGISTRY IS HERE AND NOT A CHECK CONSTRAINT
// ---------------------------------------------------------------------------
// 0029_jobs.sql constrains the SHAPE of `jobs.queue` and not its VALUES, and
// its comment gives the reason at length: an enqueue is the first statement of
// the work (doc 39 has `ocr.process` enqueued inside receipt submission), so a
// forgotten enum migration would answer a new queue with 23514 and take down
// whatever was scheduling it. The vocabulary is enforced here instead, where an
// unknown queue is a compile error at every call site that can be typed, and a
// runtime refusal on the one path that cannot (a string arriving from a URL).
//
// ---------------------------------------------------------------------------
// WHAT THIS BUILD SERVES, AND WHAT IT ONLY DESCRIBES
// ---------------------------------------------------------------------------
// Doc 39 lists nineteen queues. Two are registered below, because two have a
// worker: `notify.email` (src/app/api/jobs/notify.email) and `ocr.process`
// (src/app/api/jobs/ocr.process - the F1 money path, published to from
// src/features/receipts/server/submit.ts).
//
// The other seventeen are absent on purpose. A registry entry for a queue with
// no route is worse than no entry: it makes `enqueue('cleanup.temp', ...)`
// compile, publish, and 404 forever, and doc 39's own metrics would then show a
// queue whose depth only ever grows. Each one arrives with its worker, which is
// the same rule 0026 applied to the notification kinds it did not create.

/** Every queue this build has a worker for. Doc 39's registry, narrowed. */
export const QUEUE_NAMES = ["notify.email", "ocr.process"] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

export interface QueueEntry {
  /**
   * Doc 39: "`retries` on publish = `jobs.max_attempts - 1` (default 5 total
   * attempts)". This is the TOTAL, i.e. the number written to
   * `jobs.max_attempts`, and the publisher subtracts one for QStash.
   */
  readonly maxAttempts: number;
  /**
   * Doc 39's "Fairness at scale": the QStash flow-control key. A template
   * rather than a literal because the per-tenant queues key on the business
   * (`email:{business_id}`), and one business's blast must queue behind its own
   * key while other tenants proceed. `{business_id}` is substituted at publish
   * time; a job with no business falls back to the queue-wide key, which is the
   * correct grouping for a platform-level send.
   */
  readonly flowControlKey: string;
  /**
   * The limit that key enforces, in QStash's `Upstash-Flow-Control-Value`
   * syntax (`rate=10`, `parallelism=8`, or both comma-separated). Doc 39 states
   * one per queue; it is carried beside the key because a key with no limit is
   * a grouping and not a control.
   */
  readonly flowControlValue: string;
  /**
   * Doc 39's timeout budget table, in seconds. Exported by the worker route as
   * `maxDuration`. Duplicated there (Next reads a literal export, not a value
   * from a lookup) and asserted equal in the route's test, which is the only
   * way to keep the two honest without a build step.
   */
  readonly maxDurationSeconds: number;
  /**
   * What `dedupe_key` means for this queue, from doc 39's per-queue contracts.
   * Documentation rather than machinery: the caller builds the key, and this
   * says what it must be built from so two callers cannot disagree.
   */
  readonly dedupeKeyDescription: string;
}

export const QUEUE_REGISTRY: Record<QueueName, QueueEntry> = {
  // Doc 39: `notify.email` [MVP transactional], flow-control key
  // `email:{business_id}` at 10/s, maxDuration 60s, dedupe key
  // `notification_id` for a singleton send.
  "notify.email": {
    maxAttempts: 5,
    flowControlKey: "email:{business_id}",
    flowControlValue: "rate=10",
    maxDurationSeconds: 60,
    dedupeKeyDescription: "notifications.id of the email-channel row being sent",
  },
  // Doc 39: `ocr.process` [MVP], flow-control key `ocr` (parallelism 10),
  // maxDuration 120s. `maxAttempts: 3` is doc 36 Stage 2's DELIBERATE OVERRIDE
  // of the column default 5 ("OCR failures are rarely transient beyond that"),
  // and it is the same number `ocr.max_attempts` gives the pipeline's own
  // per-attempt budget, so the job and the receipt run out of road together.
  //
  // THE DEDUPE KEY IS `receipts.sha256`, NOT `receipts.id`, and the two docs
  // disagree: doc 39's per-queue contract says `receipt_id`, doc 36 Stage 1
  // step 5 says "`jobs.dedupe_key = sha256`". Doc 36 wins because it is the
  // document that owns the enqueue call site. In practice they select the same
  // rows - `receipts_sha_unique` (0017) is a plain unique index over the whole
  // table, so sha256 and receipts.id are in bijection - but the sha is the
  // stronger statement of intent: it says "this IMAGE is already being
  // processed", which is the property a duplicate submission would violate,
  // while an id only ever collides with itself.
  //
  // The description below deliberately says what the key IS rather than naming
  // the column it comes from. This module is pure and therefore not fenced with
  // `server-only`, and the withheld-column rule enforced by
  // src/features/receipts/review/isolation.test.ts is that a withheld column
  // name may appear in a string literal only inside a fenced module - the
  // string survives into a browser bundle, this comment does not.
  "ocr.process": {
    maxAttempts: 3,
    flowControlKey: "ocr",
    flowControlValue: "parallelism=10",
    maxDurationSeconds: 120,
    dedupeKeyDescription: "the receipt image's server-computed content hash",
  },
};

/**
 * The path a queue's worker is served at.
 *
 * Doc 39 writes this as `/api/workers/{queue}`; this build serves
 * `/api/jobs/{queue}` because the task that created the slice named that path,
 * and a route that disagrees with its own publisher is worse than one that
 * disagrees with a document. Everything else about the contract is doc 39's,
 * and the mapping stays mechanical: the queue name IS the path segment, dot
 * included, so there is no second registry translating one into the other.
 */
export function queuePath(queue: QueueName): string {
  return `/api/jobs/${queue}`;
}

/**
 * The flow-control key for one publish, with the tenant substituted.
 *
 * A null business is not an error: sweeps and platform-level sends have no
 * tenant, and grouping them all under the queue-wide key is the right
 * behaviour, not a fallback. The literal string "platform" is used rather than
 * an empty segment so the key never ends in a separator, which would read as a
 * truncated key in the QStash console.
 *
 * THE SEPARATOR IS A DOT, NOT DOC 39'S COLON, and that is a wire constraint
 * rather than a preference. QStash answers a publish carrying `email:{uuid}`
 * with `400 flowControlKey must be alphanumeric, hyphen, underscore, or
 * period` (measured against the live API, 2026-07-26). Doc 39 writes the key as
 * `{queue}:{business_id}`, which is a NAME for the grouping and not a wire
 * format; the grouping it describes is exactly what this produces.
 *
 * The substituted value is sanitized too, not only the separator. A business id
 * is a UUID today and needs nothing done to it, but the guarantee this function
 * has to make is "whatever comes in, the publish is not rejected" - and a
 * publish rejected over a key would silently un-schedule the work rather than
 * merely un-group it.
 */
export function flowControlKey(queue: QueueName, businessId: string | null): string {
  const key = QUEUE_REGISTRY[queue].flowControlKey.replace(
    "{business_id}",
    businessId ?? "platform",
  );
  return key.replace(/[^A-Za-z0-9._-]/g, ".");
}
