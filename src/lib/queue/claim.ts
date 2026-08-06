import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { HEARTBEAT_INTERVAL_MS } from "./heartbeat";
import { QUEUE_REGISTRY } from "./queues";
import type { QueueName } from "./queues";

// =============================================================================
// The job lifecycle: claim, then finish.
// =============================================================================
//
// docs/30-modules/39-background-jobs.md, "Worker invocation contract" steps 3
// and 5. Every worker route calls `claimJob` before it does anything and
// `finishJob` after, and neither is a worker's own business to implement: the
// claim IS the idempotency gate for duplicate delivery, and a worker that
// hand-rolled it would be a worker that could run twice.
//
// -----------------------------------------------------------------------------
// WHY THE CLAIM IS A READ THEN A COMPARE-AND-SWAP
// -----------------------------------------------------------------------------
// Doc 39 writes the claim as one statement:
//
//   update jobs set status='running', attempts = attempts + 1, started_at = now()
//    where id = $1 and status in ('queued','failed') returning *;
//
// `attempts = attempts + 1` is a self-referential assignment, and PostgREST
// (which is the only way this codebase talks to Postgres) cannot express one:
// its update body is a literal row. The options were a stored procedure or a
// compare-and-swap, and the CAS won because it is the same guarantee with no
// migration surface: read the row, then write `attempts = observed + 1` with
// `attempts = observed` in the predicate. Two invocations racing both read the
// same value, both try to write, and exactly one matches - the other sees zero
// affected rows and knows it lost, which is precisely what doc 39's single
// statement conveys by returning no row.
//
// The predicate carries `status in ('queued','failed')` as well, so the CAS is
// not merely "nobody else moved the counter" but "the job is still claimable".
//
// -----------------------------------------------------------------------------
// THE FIVE OUTCOMES, AND WHY FOUR OF THEM ARE A 200
// -----------------------------------------------------------------------------
// A worker route answers QStash with a status code, and QStash reads 5xx as
// "try again". So the only outcome that may be a 5xx is one where trying again
// could help. Doc 39's step 3 enumerates the rest and every one of them is a
// duplicate or a terminal state, i.e. work that will never succeed by being
// re-delivered:
//
//   claimed    - do the work.
//   done       - already succeeded or already dead. Doc 39: "return 200
//                (duplicate delivery; idempotent no-op)".
//   held       - another invocation is running it and has not gone quiet.
//                200: the other one owns it.
//   exhausted  - attempts would exceed max_attempts. Marked dead, 200. Retrying
//                is the one thing we have already proved does not work.
//   missing    - no such row. A message for a job that does not exist cannot be
//                made to exist by re-delivery. 200, loudly logged.
//
// `error` is the sixth and is the only retryable one: the database was
// unreachable, so the claim itself did not conclude.

const LOG_PREFIX = "[queue/claim]";

/**
 * How long a `running` job may go without progress before another invocation
 * may take it over, as a multiple of the queue's own timeout budget.
 *
 * Two rather than one, deliberately. At exactly the budget, a worker that is
 * legitimately still finishing its last second would be reclaimed and its work
 * done twice; doubling it means a reclaim only ever happens after the original
 * invocation has provably been killed (Vercel enforces `maxDuration` itself),
 * and the cost of the extra wait is a delay on an already-failed job.
 *
 * This is the FALLBACK budget only - for a job with no LIVE heartbeat to
 * judge instead. See `HEARTBEAT_STALE_MS` and `isStale` below for why a live
 * one is judged differently, and why judging it against this instead is the
 * bug t2-6's follow-up fixed.
 */
const RECLAIM_TIMEOUT_MULTIPLIER = 2;

/**
 * How long a LIVE heartbeat may go without a refresh before the job it
 * belongs to is considered dead, independent of the queue's own maxDuration.
 *
 * Doc 39's own design for this predates `jobs.heartbeat_at`: Redis `SET
 * {env}:jobs:hb:{job_id} EX 60`, refreshed every `HEARTBEAT_INTERVAL_MS`
 * (20s) - a TTL that survives two missed refreshes and expires only on the
 * third. The `EX 60` figure is doc 39 line 45's, cited above. 0029's column
 * comment then ports the storage from Redis to Postgres, noting that "doc 39
 * puts the beat in Redis with a TTL and that is right for the 20-second
 * refresh" - it does not restate the TTL value itself. This constant carries
 * doc 39's TTL the rest of the way.
 *
 * `RECLAIM_TIMEOUT_MULTIPLIER * maxDurationSeconds` is the WRONG window for a
 * job that is actively heartbeating: `ocr.process` heartbeats every 20s until
 * Vercel kills it at its 120s `maxDuration`, so a dead worker's last
 * heartbeat is only ever a few seconds old at t=120s - judging that against
 * `2 * 120s = 240s` (as this file did before t2-6's follow-up) delays reclaim
 * to t=360s and lets every QStash redelivery in between land on `held` and
 * be permanently consumed, since a dead row does not get less dead by
 * waiting. A worker with no live heartbeat yet - dead before its first
 * refresh, or a queue with no heartbeat wiring at all (`notify.email`) -
 * still has nothing better than the maxDuration-based fallback, which is
 * exactly why `isStale` only reaches for this constant once it can tell the
 * heartbeat is actually live (see the comment there).
 */
const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;

export interface JobRow {
  readonly id: string;
  readonly queue: string;
  readonly status: string;
  readonly payload: unknown;
  readonly businessId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export type ClaimResult =
  | { readonly status: "claimed"; readonly job: JobRow }
  | { readonly status: "done"; readonly jobStatus: string }
  | { readonly status: "held" }
  | { readonly status: "exhausted" }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly reason: string };

export interface ClaimJobInput {
  readonly supabase: SupabaseClient<Database>;
  readonly jobId: string;
  /** The queue whose route received the message. Asserted against the row. */
  readonly queue: QueueName;
  readonly now?: () => Date;
}

interface RawJob {
  id: string;
  queue: string;
  status: string;
  payload: unknown;
  business_id: string | null;
  attempts: number;
  max_attempts: number;
  started_at: string | null;
  heartbeat_at: string | null;
}

const JOB_COLUMNS =
  "id, queue, status, payload, business_id, attempts, max_attempts, started_at, heartbeat_at";

/**
 * Claim a job for this invocation. Never throws: a database fault is reported
 * as `error`, which the route turns into the one retryable status it is allowed
 * to return.
 */
export async function claimJob(input: ClaimJobInput): Promise<ClaimResult> {
  const { supabase, jobId, queue } = input;
  const now = input.now?.() ?? new Date();

  try {
    const { data: job, error } = await supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("id", jobId)
      .maybeSingle<RawJob>();

    if (error !== null) {
      console.error(`${LOG_PREFIX} could not read job ${jobId}`, error);
      return { status: "error", reason: error.message };
    }

    if (job === null) {
      // A signed message naming a job row that is not there. The signature was
      // valid, so this is our own bug or a replay of a message whose row was
      // rolled back, never an attacker. Loud, and terminal.
      console.error(`${LOG_PREFIX} job ${jobId} does not exist`);
      return { status: "missing" };
    }

    // A correctly signed message for the WRONG route. Cannot happen through
    // verify.ts (which pins the destination path) but is asserted anyway,
    // because the cost of being wrong is running one queue's payload through
    // another queue's worker.
    if (job.queue !== queue) {
      console.error(
        `${LOG_PREFIX} job ${jobId} belongs to ${job.queue}, not ${queue}; refusing to run it here`,
      );
      return { status: "missing" };
    }

    if (job.status === "succeeded" || job.status === "dead") {
      return { status: "done", jobStatus: job.status };
    }

    if (job.status === "running" && !isStale(job, queue, now)) {
      // Doc 39: "0 rows and status='running' with a live heartbeat -> 200
      // (concurrent duplicate; the other invocation owns it)."
      return { status: "held" };
    }

    // Doc 39: "attempts >= max_attempts after increment -> mark dead". Checked
    // BEFORE the claim so an exhausted job is never marked `running` on its way
    // to `dead`, which would leave a window where the DLQ view says it is still
    // being worked.
    if (job.attempts + 1 > job.max_attempts) {
      await markDead(
        supabase,
        job.id,
        `attempt budget of ${job.max_attempts} exhausted`,
        now,
      );
      return { status: "exhausted" };
    }

    // The compare-and-swap. `attempts` is both the value being written and the
    // guard, which is what makes two racing invocations resolve to one winner.
    const { data: claimed, error: claimError } = await supabase
      .from("jobs")
      .update({
        status: "running",
        attempts: job.attempts + 1,
        started_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
      })
      .eq("id", job.id)
      .eq("attempts", job.attempts)
      .in("status", ["queued", "failed", "running"])
      .select("id")
      .maybeSingle<{ id: string }>();

    if (claimError !== null) {
      console.error(`${LOG_PREFIX} could not claim job ${jobId}`, claimError);
      return { status: "error", reason: claimError.message };
    }

    if (claimed === null) {
      // Lost the race. The winner is doing the work; this invocation says so
      // and returns 200, exactly as doc 39's "0 rows" branch does.
      return { status: "held" };
    }

    return {
      status: "claimed",
      job: {
        id: job.id,
        queue: job.queue,
        status: "running",
        payload: job.payload,
        businessId: job.business_id,
        attempts: job.attempts + 1,
        maxAttempts: job.max_attempts,
      },
    };
  } catch (error) {
    console.error(`${LOG_PREFIX} unexpected failure claiming job ${jobId}`, error);
    return { status: "error", reason: "unexpected failure" };
  }
}

/**
 * Has a `running` job gone quiet long enough to be taken over?
 *
 * Two different windows, for two different situations, and telling them apart
 * is the whole function:
 *
 *   A LIVE heartbeat - one that has advanced past the claim-time instant
 *   `claimJob`'s CAS wrote into BOTH `started_at` and `heartbeat_at` - is
 *   judged against `HEARTBEAT_STALE_MS` (60s), because a live heartbeat is
 *   the fresher and more direct signal doc 39 designed it to be: a worker
 *   heartbeating every `HEARTBEAT_INTERVAL_MS` is provably alive within
 *   seconds of its last refresh, and - after `HEARTBEAT_STALE_MS` of silence -
 *   overwhelmingly likely to be dead, independent of the queue's own
 *   `maxDuration` budget.
 *
 *   "Likely", not "provably". The fallback arm below inherits a genuine
 *   proof: `2 * maxDuration` is past the point Vercel itself kills the
 *   invocation, so a reclaim there cannot race a live worker. The live arm
 *   has no such guarantee, because it rests on the refreshes succeeding -
 *   which is precisely the thing a heartbeat cannot assume about itself.
 *   Three consecutive failed `UPDATE`s, or 60s of event-loop starvation,
 *   and this arm will reclaim a worker that is still running. That trade is
 *   deliberate and is doc 39's own design (60s of exposure beats 120s of
 *   wasted `held` responses on a dead row), but it is an inference, not a
 *   proof, and the difference matters downstream: `finishJob` (t2-8) now
 *   guards its own write on the same `(id, attempts, status='running')` lease
 *   tuple `heartbeat.ts`'s refresh() guards on, rather than resting on the
 *   guarantee this arm gives up - so a worker this arm reclaims wrongly can
 *   no longer overwrite the terminal status of the worker that now owns the
 *   row.
 *
 *   Everything else - no `heartbeat_at` at all, or one still equal to
 *   `started_at` because no refresh has landed yet - falls back to
 *   `2 * maxDuration` on whichever marker exists. This is deliberately the
 *   coarser, slower check: it is what queues with no heartbeat wiring
 *   (`notify.email`, whose 60s budget doc 39 does not require one for) have
 *   always relied on, and it is the right answer for a worker that has not
 *   heartbeated yet either, because "hasn't heartbeated yet" and "will never
 *   heartbeat" are indistinguishable from a single reading.
 *
 * A row with neither marker at all is treated as stale, because a `running`
 * job that never recorded when it started is a row no invocation is going to
 * finish.
 */
function isStale(job: RawJob, queue: QueueName, now: Date): boolean {
  const marker = job.heartbeat_at ?? job.started_at;
  if (marker === null) return true;

  if (job.heartbeat_at !== null && job.started_at !== null) {
    const heartbeatAtMs = new Date(job.heartbeat_at).getTime();
    const startedAtMs = new Date(job.started_at).getTime();
    if (heartbeatAtMs > startedAtMs) {
      // A live heartbeat: at least one refresh has landed since the claim.
      return now.getTime() - heartbeatAtMs > HEARTBEAT_STALE_MS;
    }
  }

  const elapsedMs = now.getTime() - new Date(marker).getTime();
  const budgetMs =
    QUEUE_REGISTRY[queue].maxDurationSeconds * RECLAIM_TIMEOUT_MULTIPLIER * 1_000;
  return elapsedMs > budgetMs;
}

async function markDead(
  supabase: SupabaseClient<Database>,
  jobId: string,
  reason: string,
  now: Date,
): Promise<void> {
  const { error } = await supabase
    .from("jobs")
    .update({
      status: "dead",
      last_error: reason,
      finished_at: now.toISOString(),
    })
    .eq("id", jobId);
  if (error !== null) {
    console.error(`${LOG_PREFIX} could not mark job ${jobId} dead`, error);
  }
}

export type JobOutcome =
  | { readonly kind: "succeeded" }
  /** Retryable: QStash should deliver again. */
  | { readonly kind: "failed"; readonly error: string }
  /** Terminal: retrying cannot help (doc 39's failure taxonomy). */
  | { readonly kind: "dead"; readonly error: string };

export type FinishResult =
  | { readonly kind: "recorded" }
  /**
   * The guarded write matched zero rows: this invocation's lease on
   * `(id, attempts)` has moved on, either because a reclaim already won the
   * row (another `claimJob` bumped `attempts`) or because a previous
   * `finishJob` call already moved the row's status off `running`. Not an
   * error - the work this invocation did may well have succeeded, it simply
   * no longer owns the row to say so. See `finishJob`'s own comment for why
   * this must never become a retryable failure.
   */
  | { readonly kind: "lease-lost" }
  | { readonly kind: "error"; readonly reason: string };

/**
 * Record the outcome on the job row. Doc 39 step 5.
 *
 * `attempts` is the ownership half of the `(id, attempts)` lease `claimJob`
 * granted this invocation - `ClaimResult`'s `job.attempts` on the `"claimed"`
 * branch, the same value `startHeartbeat` is handed. The write is guarded on
 * `id` + that `attempts` + `status = 'running'`, which is deliberately the
 * SAME ownership tuple `heartbeat.ts`'s `refresh()` guards its own write on -
 * see that module's header for why this exact tuple and not something
 * looser. Before t2-6 that guard would have been redundant: reclaim only
 * happened past `2 * maxDuration`, so a reclaim could not race a live
 * worker and a stale `finishJob` filtering on `id` alone was harmless. t2-6
 * gave the live heartbeat arm a 60s window that is an inference rather than
 * a proof (see `isStale`'s header), which means a worker CAN be reclaimed
 * while it is still genuinely running - and without this guard, that
 * worker's own late `finishJob` would overwrite the reclaiming worker's live
 * claim with a terminal status that was never true for the row it now is.
 * Matching `attempts` alone is not enough either: a second `finishJob` call
 * for the same claim (e.g. a caller bug, or the schema-failure branch racing
 * a claim that already ran) must not resurrect an already-terminal row, so
 * `status = 'running'` is required too, exactly as `heartbeat.ts` requires it.
 *
 * Pass `attempts: null` ONLY when no claim was ever established for this
 * jobId by THIS invocation - the schema-validation-failure branches in both
 * worker routes, which mark a job dead from a payload that failed to parse
 * BEFORE `claimJob` ever ran. There is no lease to check there, so the write
 * is guarded on `id` alone, exactly as every `finishJob` call was before this
 * task.
 *
 * Best effort by design. The work has already happened by the time this
 * runs, so a failure to write the outcome - for ANY reason, including a lost
 * lease - must not change what the route tells QStash: reporting a 5xx
 * because the bookkeeping failed (or lost a race) would re-run a send that
 * already went out, or re-run work whose real owner is already running it.
 * What it costs instead is a row that the reclaim path above will eventually
 * resolve on its own, which is the recoverable direction. Callers are not
 * required to inspect the return value for correctness; it exists so a
 * lease-lost outcome can be logged and dropped rather than silently ignored.
 *
 * A `failed` job is left with its attempt count intact and no `finished_at`,
 * because the 0029 constraint `jobs_terminal_finished_at` says a non-terminal
 * row has not finished - and a failed job has not: QStash is about to deliver
 * it again.
 */
export async function finishJob(
  supabase: SupabaseClient<Database>,
  jobId: string,
  attempts: number | null,
  outcome: JobOutcome,
  now: Date = new Date(),
): Promise<FinishResult> {
  const terminal = outcome.kind !== "failed";
  const patch = {
    status: outcome.kind,
    last_error: outcome.kind === "succeeded" ? null : outcome.error,
    finished_at: terminal ? now.toISOString() : null,
  };

  try {
    if (attempts === null) {
      // No claim to guard on - see the doc comment above. Filtered on `id`
      // alone, unchanged from before this task.
      const { error } = await supabase.from("jobs").update(patch).eq("id", jobId);
      if (error !== null) {
        console.error(`${LOG_PREFIX} could not record outcome ${outcome.kind} for job ${jobId}`, error);
        return { kind: "error", reason: error.message };
      }
      return { kind: "recorded" };
    }

    const { data, error } = await supabase
      .from("jobs")
      .update(patch)
      .eq("id", jobId)
      .eq("attempts", attempts)
      .eq("status", "running")
      .select("id")
      .maybeSingle<{ id: string }>();

    if (error !== null) {
      console.error(`${LOG_PREFIX} could not record outcome ${outcome.kind} for job ${jobId}`, error);
      return { kind: "error", reason: error.message };
    }

    if (data === null) {
      // Zero rows matched: this invocation no longer owns the row - see
      // `FinishResult`'s `"lease-lost"` doc above for the two ways that
      // happens. Dropped, not retried: there is nothing here another
      // delivery could fix.
      console.info(
        `${LOG_PREFIX} job ${jobId} no longer matches this invocation's claim (attempts=${attempts}, status='running'); dropping outcome ${outcome.kind}`,
      );
      return { kind: "lease-lost" };
    }

    return { kind: "recorded" };
  } catch (error) {
    console.error(`${LOG_PREFIX} unexpected failure recording job ${jobId}`, error);
    return { kind: "error", reason: "unexpected failure" };
  }
}
