import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

// =============================================================================
// The heartbeat: keeps `jobs.heartbeat_at` fresh while a claimed job's handler
// is actually running.
// =============================================================================
//
// docs/30-modules/39-background-jobs.md: "Heartbeat (long jobs only) ...
// refreshed every 20s. Required for any worker with maxDuration > 60." Without
// it, `claim.ts`'s `isStale` has only `started_at` to go on, and a queue whose
// budget is minutes wide (`ocr.process` at 120s) would have to wait the full
// reclaim window (2x maxDuration) to tell a worker that died at second 3 from
// one that is 90 healthy seconds into a legitimate OCR call.
//
// -----------------------------------------------------------------------------
// WHY THE REFRESH REUSES THE CLAIM'S OWNERSHIP TUPLE, AND IS DELIBERATELY
// TIGHTER THAN THE CLAIM'S OWN PREDICATE
// -----------------------------------------------------------------------------
// `claimJob`'s compare-and-swap writes `attempts = observed + 1` guarded by
// `attempts = observed`, and the value it hands back as `JobRow.attempts` IS
// that new, already-incremented number - the row's `attempts` column reads
// exactly that until somebody else claims the row again. That tuple, `(id,
// attempts)`, is this invocation's lease. A refresh that only matched on `id`
// would still take effect after another worker reclaimed a stale row (its own
// CAS bumps `attempts` again), pushing `heartbeat_at` forward under a job the
// reclaiming worker now owns and undoing the very staleness check that let it
// take over. Matching `attempts` too means a lost lease makes the UPDATE match
// zero rows, which this module treats as "stop, quietly" rather than an error.
//
// This is NOT the same predicate `claimJob`'s CAS uses, though - it is a
// strictly narrower one, on purpose. The CAS accepts `status IN ('queued',
// 'failed', 'running')` because a reclaim has to be able to pick a row up FROM
// `running`; this refresh requires `status = 'running'` alone, because it must
// NOT be able to. That extra guard is not redundant with the `attempts` match:
// `finishJob` writes a terminal status without touching `attempts` at all, so
// in the window between a handler settling and this module's `stop()`
// actually clearing the interval, a refresh already scheduled would still
// match on `(id, attempts)` alone. Requiring `running` closes exactly that
// window - the one case doc 39's own warning ("a heartbeat written after
// completion is worse than none") is about.
//
// -----------------------------------------------------------------------------
// WHY THIS NEVER FAILS THE JOB
// -----------------------------------------------------------------------------
// Same rule as the audit writers (src/features/campaigns/server/audit.ts) and
// `finishJob` itself: a heartbeat is an observation ABOUT the job, not a gate
// ON it. `setInterval`'s callback is fire-and-forget by construction - nothing
// here is awaited by the caller - so every failure, expected or not, is caught
// and logged inside `refresh` and never propagates. The worst a broken
// heartbeat can do is let a healthy job be reclaimed late; the job's own
// outcome, decided by `finishJob`, is never touched by this module.

const LOG_PREFIX = "[queue/heartbeat]";

/** Doc 39: "refreshed every 20s". */
export const HEARTBEAT_INTERVAL_MS = 20_000;

export interface HeartbeatHandle {
  /**
   * Stop refreshing. Idempotent - safe to call from a `finally` no matter how
   * the handler settled, and safe to call again even if this module already
   * stopped itself after losing the lease.
   */
  stop(): void;
}

export interface StartHeartbeatInput {
  readonly supabase: SupabaseClient<Database>;
  readonly jobId: string;
  /**
   * The attempts value THIS invocation claimed - `ClaimResult`'s
   * `job.attempts` on the `"claimed"` branch. The ownership half of the
   * `(id, attempts)` lease `claim.ts` establishes.
   */
  readonly attempts: number;
  readonly intervalMs?: number;
  readonly now?: () => Date;
}

/**
 * Start refreshing `jobs.heartbeat_at` for a claimed job every
 * `HEARTBEAT_INTERVAL_MS` (overridable for tests). Call `stop()` when the
 * handler settles - success, failure or throw, from a `finally` - so no
 * refresh is scheduled after the job is done.
 */
export function startHeartbeat(input: StartHeartbeatInput): HeartbeatHandle {
  const { supabase, jobId, attempts } = input;
  const intervalMs = input.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = input.now ?? (() => new Date());

  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    void refresh(supabase, jobId, attempts, now(), stop);
  }, intervalMs);

  // Hoisted, so the closure above can reference it: by the time it actually
  // runs (asynchronously, on a later tick), `timer` is already assigned.
  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  // A live interval must never be the reason a Node process is seen as still
  // busy - `finally` clears it long before the platform's own `maxDuration`
  // would, but `unref` (where the runtime supports it) is a free second line
  // of defense.
  const unrefable = timer as unknown as { unref?: () => void };
  if (typeof unrefable.unref === "function") {
    unrefable.unref();
  }

  return { stop };
}

async function refresh(
  supabase: SupabaseClient<Database>,
  jobId: string,
  attempts: number,
  now: Date,
  stop: () => void,
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .update({ heartbeat_at: now.toISOString() })
      .eq("id", jobId)
      .eq("attempts", attempts)
      .eq("status", "running")
      .select("id")
      .maybeSingle<{ id: string }>();

    if (error !== null) {
      console.error(`${LOG_PREFIX} could not refresh heartbeat for job ${jobId}`, error);
      return;
    }

    if (data === null) {
      // Zero rows matched, which this predicate cannot tell apart from two
      // different, equally legitimate causes: either another invocation's
      // reclaim already won the (id, attempts) lease this one held, OR
      // `finishJob` already moved the row off `running` and this refresh
      // simply lost the race with the handler settling. Neither is a
      // failure, and both call for the same response - stop quietly rather
      // than keep trying to write a heartbeat for a job this invocation no
      // longer (or no longer provably) owns.
      console.info(
        `${LOG_PREFIX} job ${jobId} no longer matches this invocation's claim (attempts=${attempts}, status='running'); stopping`,
      );
      stop();
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} unexpected failure refreshing heartbeat for job ${jobId}`, error);
  }
}
