import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

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
 */
const RECLAIM_TIMEOUT_MULTIPLIER = 2;

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
 * The heartbeat wins when there is one; otherwise the claim time stands in for
 * it, which is correct for every worker short enough not to need a heartbeat at
 * all (doc 39 requires one only above 60s). A row with neither is treated as
 * stale, because a `running` job that never recorded when it started is a row
 * no invocation is going to finish.
 */
function isStale(job: RawJob, queue: QueueName, now: Date): boolean {
  const marker = job.heartbeat_at ?? job.started_at;
  if (marker === null) return true;

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

/**
 * Record the outcome on the job row. Doc 39 step 5.
 *
 * Best effort by design, and it returns nothing. The work has already happened
 * by the time this runs, so a failure to write the outcome must not change what
 * the route tells QStash: reporting a 5xx because the bookkeeping failed would
 * re-run a send that already went out. What it costs instead is a row that the
 * reclaim path above will eventually pick up, which is the recoverable
 * direction.
 *
 * A `failed` job is left with its attempt count intact and no `finished_at`,
 * because the 0029 constraint `jobs_terminal_finished_at` says a non-terminal
 * row has not finished - and a failed job has not: QStash is about to deliver
 * it again.
 */
export async function finishJob(
  supabase: SupabaseClient<Database>,
  jobId: string,
  outcome: JobOutcome,
  now: Date = new Date(),
): Promise<void> {
  const terminal = outcome.kind !== "failed";
  try {
    const { error } = await supabase
      .from("jobs")
      .update({
        status: outcome.kind,
        last_error: outcome.kind === "succeeded" ? null : outcome.error,
        finished_at: terminal ? now.toISOString() : null,
      })
      .eq("id", jobId);
    if (error !== null) {
      console.error(`${LOG_PREFIX} could not record outcome ${outcome.kind} for job ${jobId}`, error);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} unexpected failure recording job ${jobId}`, error);
  }
}
