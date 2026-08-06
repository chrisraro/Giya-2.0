import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";
import { loadMetrics } from "@/lib/observability/metrics";
import { QUEUE_REGISTRY, flowControlKey, isQueueName, queuePath } from "@/lib/queue/queues";
import type { QueueName } from "@/lib/queue/queues";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import type { AdminRole } from "./access";
import { canActOnLadder } from "./access";
import { describePayloadIdentity, reasonProblem } from "./presenter";
import type { DeadJobItem, QueueStatusView } from "./types";

// ===========================================================================
// `/admin/monitoring/queues`: doc 31 §5's read, and doc 39's replay procedure.
//
// ---------------------------------------------------------------------------
// READS COMPOSE t2-3's METRICS MODULE. NO NEW SQL FOR COUNTS OR SWEEP HEALTH.
// ---------------------------------------------------------------------------
// `loadMetrics` (src/lib/observability/metrics.ts) already runs the
// jobs-by-status counts and calls `sweep_job_health()`. This module's job is
// the one read that module does not do (the dead-letter LIST itself - rows,
// not counts) plus the one write doc 39 assigns this screen: replay.
//
// ---------------------------------------------------------------------------
// THE FENCE IS THE SAME AS EVERY SIBLING ADMIN MODULE.
// ---------------------------------------------------------------------------
// 0029's header: `jobs` has RLS enabled with ZERO policies and every client
// privilege revoked, so a service-role client is the only way to read or write
// it, exactly as `queue.ts` and `consequences.ts` already state for their own
// tables. `resolveAdminContext()` (the page) and the table-truth actor check
// below (the write) are the fences; nothing about `jobs` grants one of its own.
//
// ---------------------------------------------------------------------------
// REPLAY: attempts=0, NOT a raised cap, NOT a refusal at the cap - doc 39 SAYS SO.
// ---------------------------------------------------------------------------
// Doc 39 ("Replay procedure"), verbatim: "admin action `job.replayed` (audited,
// reason required): reset `attempts=0`, `status='queued'`, `last_error=null`,
// re-publish to QStash with the same `job_id`." That is a third answer to "what
// happens at max_attempts", not a fork between "raise the cap" and "refuse":
// `max_attempts` itself is never touched, so nothing about the column's own
// meaning moves, and every replay is auditable (`before` carries the exhausted
// attempt count, `after` carries the fresh `0`) - which is what keeps a reset
// from being a SILENT bypass. A caller reads the audit trail and sees exactly
// how many times, and when, this job was given a new budget.
//
// A row is only eligible at all when its CURRENT status is `'dead'` - doc 39's
// own DLQ definition - so a job mid-flight (`queued`/`running`/`failed`) or
// already terminal-successful (`succeeded`) cannot be "replayed" into losing
// whatever attempt history it has; only the row the DLQ view already shows as
// abandoned can be given a new one.
//
// ---------------------------------------------------------------------------
// WHY THE AUDIT WRITE IS A GATE HERE, NOT BEST EFFORT (contrast campaigns/audit.ts)
// ---------------------------------------------------------------------------
// `features/campaigns/server/audit.ts`'s header draws this distinction
// explicitly: its SYSTEM-actor caller (`exhaustion.ts`, budget-exhaustion
// auto-pause) treats a failed audit write as best effort, because nothing
// about a fail-soft pipeline may be allowed to un-pause a campaign over a
// bookkeeping failure. Replay is the opposite shape: it is an ADMIN-actor,
// privileged, side-effecting write, which is exactly `admin/consequences.ts`'s
// territory ("Admin actions on tenant data always require a recorded reason"),
// and that file's own header explains why write-then-audit-else-REVERT is the
// rule there: writing the audit row first would risk a false record of an
// action that never took effect, and writing the state change with no audit
// row behind it is the exact unaudited-admin-action doc 15 forbids. This
// module follows `consequences.ts`'s rule, not `campaigns/audit.ts`'s.
//
// ---------------------------------------------------------------------------
// RE-PUBLISHING TO QSTASH, WITHOUT TOUCHING `src/lib/queue/**`
// ---------------------------------------------------------------------------
// `publish.ts`'s actual QStash call is a private, unexported function, and
// this slice's constraints forbid modifying anything under `src/lib/queue/`
// beyond reading it. `republishDeadJob` below is therefore a deliberate,
// narrow near-duplicate of that call, built ONLY from `publish.ts`'s already-
// PUBLIC surface (`queuePath`, `flowControlKey`, `QUEUE_REGISTRY`) so the
// destination URL, the retries header and the flow-control key can never
// disagree with what a normal enqueue computes - including validating the
// response body against the same shape `publish.ts`'s own
// `publishResponseSchema` checks, so an HTML error page served with a 200
// (a real failure mode `publish.ts` guards against) is not read as success
// here either.
//
// ---------------------------------------------------------------------------
// A REPLAY IS NOT SUCCESSFUL UNTIL IT IS ACTUALLY DELIVERABLE - review finding I3
// ---------------------------------------------------------------------------
// A NORMAL enqueue can afford "row first, publish best-effort" (`publish.ts`'s
// own header) because doc 39 gives an unpublished `queued` row a second
// chance: the hourly reconciler re-publishes any `queued` row with no
// `qstash_message_id`. THIS BUILD HAS NO RECONCILER - `src/lib/queue/queues.ts`
// registers exactly two workers, and every "reconciler" reference in `src/` is
// a comment about future work, not a running job. So a replay that resets a
// dead row to `queued` and then merely LOGS a publish failure would not leave
// a recoverable row; it would leave an INVISIBLE one - off the dead-letter
// list (doc 39's own DLQ view), showing only as +1 on the harmless-looking
// `queued` tile, and claimed by nobody, ever. That is the exact failure this
// task exists to end, recreated one layer up.
//
// So replay treats delivery as part of the operation, not an afterthought:
// if `republishDeadJob` cannot confirm a message id, the reset is REVERTED -
// the row goes back to `dead`, visibly, in the list an operator is already
// watching - and `replayJob` reports `REPUBLISH_FAILED` rather than `ok:
// true`. This is safe to do even after the row briefly went `queued` and a
// message was already accepted by QStash in the rare split-second race: doc
// 39's own words are "idempotency guarantees make replay always safe - that
// is the design bar for every worker", and `claimJob`'s first branch (`status
// === 'dead' -> done`) is exactly that guarantee - a stray delivery for a
// row that is dead again is a no-op, not a double-run.
//
// ---------------------------------------------------------------------------
// THE DEDUPE INDEX APPLIES TO A REPLAYED ROW TOO - review finding I4
// ---------------------------------------------------------------------------
// Flipping a dead row to `queued` re-enters `jobs_dedupe_idx` (0029: unique on
// `(queue, dedupe_key)` where `status in ('queued','running')`) under its
// ORIGINAL `dedupe_key`, unchanged by replay. If a fresh submission for the
// same work already holds that key in flight - e.g. `receipts/server/
// submit.ts` re-enqueuing `ocr.process` under the image's sha256 after the
// first attempt died - the reset collides and Postgres raises 23505. That is
// not a transient fault ("try again" is wrong advice: retrying the same
// replay collides again) - it means a live job for this exact work already
// exists, so replaying the dead one would fork it into two. Detected on the
// CAS write and reported as its own `DEDUPE_CONFLICT` code.
//
// ---------------------------------------------------------------------------
// WHY THE ROW RESET GOES BEFORE DELIVERY GOES BEFORE THE AUDIT ROW
// ---------------------------------------------------------------------------
// Order is: (1) CAS the row to `queued`, (2) attempt delivery, (3) write ONE
// audit row describing the ACTUAL outcome - `job.replayed` when delivered,
// `job.replay_failed` when the reset had to be reverted. Auditing before
// knowing the outcome (the original shape of this function) would let a
// delivery failure leave an audit row asserting `after: {status: 'queued'}`
// for a row that is actually `dead` again - a false record, which is exactly
// what `consequences.ts`'s own header calls out as the reason NOT to audit
// before the state is settled. Settling delivery first costs one extra round
// trip and buys an audit trail that is never wrong about the row's own status.
//
// ---------------------------------------------------------------------------
// M1: THE RESET MAKES `attempts` NON-MONOTONIC ACROSS THE REPLAY BOUNDARY
// ---------------------------------------------------------------------------
// `claim.ts`'s CAS and `heartbeat.ts`'s `refresh()` both guard their writes on
// the tuple `(id, attempts, status='running')` as a LEASE - implicitly
// assuming that tuple names one invocation's ownership uniquely. Resetting
// `attempts` to 0 on replay means that assumption is no longer "attempts only
// goes up for this row's whole life": a job's second lifetime (post-replay)
// reuses the same low attempt numbers its first lifetime used. Doc 39
// mandates the reset (see above) and this is not a reason to change it - a
// stray delivery old enough to matter would have to survive past the
// platform's own `maxDuration` kill AND past QStash's bounded retry backoff
// AND past however long the row sat `dead` before an admin replayed it, which
// is a materially different bar than "still in flight". Named here so the
// assumption is a stated trade-off, not a silent one.
// ===========================================================================

/** doc 31 §5: "these are working lists, not archives" - same ceiling
 * `admin/queue.ts#QUEUE_LIMIT` uses for the same reason. */
const DEAD_JOBS_LIMIT = 100;

/** Bounds the replay-history read (I6) - generous relative to
 * `DEAD_JOBS_LIMIT` because several replays can share one job id. */
const REPLAY_COUNT_ROW_LIMIT = 1_000;

const ENTITY_JOB = "job";
/** A replay that was delivered. Doc 39's own verb. */
const ACTION_JOB_REPLAYED = "job.replayed";
/** A replay whose reset had to be reverted because it could not be
 * delivered (I3) - a distinct verb so the audit trail (and I6's replay-count
 * read, which only counts `ACTION_JOB_REPLAYED`) can tell "this job was
 * actually given a fresh attempt" apart from "someone tried and it did not
 * take". Doc 39 does not name this verb; 0022's constraint is on SHAPE, not
 * vocabulary, so registering one costs no migration. */
const ACTION_JOB_REPLAY_FAILED = "job.replay_failed";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface AdminJobsDeps {
  /** MUST be the service-role client. See the header. */
  supabase: SupabaseClient<Database>;
  now: () => Date;
  /**
   * Injected in tests. Defaults to a real QStash publish. Never rejects: a
   * publish failure is reported as `null`, not thrown, matching
   * `src/lib/queue/publish.ts`'s own `publish()` contract - including its
   * return type (`string | null`, the QStash message id or nothing).
   */
  republish: (
    queue: QueueName,
    jobId: string,
    payload: unknown,
    businessId: string | null,
  ) => Promise<string | null>;
}

export function defaultAdminJobsDeps(): AdminJobsDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[admin/jobs] SUPABASE_SERVICE_ROLE_KEY is not configured; the queue status screen cannot read anything",
    );
    return null;
  }
  return { supabase, now: () => new Date(), republish: republishDeadJob };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface DeadJobRow {
  id: string;
  queue: string;
  business_id: string | null;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  finished_at: string | null;
  created_at: string;
}

const DEAD_JOB_COLUMNS =
  "id, queue, business_id, payload, attempts, max_attempts, last_error, finished_at, created_at";

function toDeadJobItem(row: DeadJobRow, replayCount: number | null): DeadJobItem {
  return {
    jobId: row.id,
    queue: row.queue,
    businessId: row.business_id,
    payloadIdentity: describePayloadIdentity(row.payload),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    deadAt: row.finished_at,
    createdAt: row.created_at,
    replayCount,
  };
}

/**
 * How many times `job.replayed` has landed on each of the given job ids
 * (I6: "recorded" must also mean "discoverable" - `attempts` resets on every
 * replay, so a job on its fifth replay is otherwise indistinguishable on this
 * screen from one on its first).
 *
 * `null` on a read failure - NOT `0` for every row, which would tell an
 * operator "never replayed" about a job this could simply not find out about.
 * Same "null means unreadable, never a guessed zero" rule every sibling read
 * in this module and `loadMetrics` follow.
 */
async function loadReplayCounts(
  deps: AdminJobsDeps,
  jobIds: readonly string[],
): Promise<Map<string, number> | null> {
  if (jobIds.length === 0) return new Map();

  const { data, error } = await deps.supabase
    .from("audit_logs")
    .select("entity_id")
    .eq("entity_type", ENTITY_JOB)
    .eq("action", ACTION_JOB_REPLAYED)
    .in("entity_id", [...jobIds])
    .limit(REPLAY_COUNT_ROW_LIMIT);

  if (error !== null) {
    console.error("[admin/jobs] replay-count read failed", error);
    return null;
  }

  const counts = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ entity_id: string | null }>) {
    if (row.entity_id === null) continue;
    counts.set(row.entity_id, (counts.get(row.entity_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The dead-letter LIST - doc 31 §5's "dead list with `payload`, `last_error`,
 * attempts, linked entity", which `loadMetrics` (t2-3) does not read: that
 * module answers "how many are dead", never "which ones".
 *
 * `null` on any read failure, `[]` on a genuinely clean platform - see
 * `QueueStatusView`'s own doc for why the distinction is load-bearing here.
 *
 * OLDEST FIRST (`finished_at` ascending) - review finding I5. The cap below
 * is real (`DEAD_JOBS_LIMIT`, "working lists, not archives" per
 * `admin/queue.ts`'s identical ceiling), and on a platform with more than 100
 * simultaneously dead jobs the choice of which 100 to show is not neutral:
 * newest-first would truncate away exactly the jobs that have been sitting
 * dead the longest - the forgotten ones, and the ones an SLA-minded operator
 * needs to see first. Same reasoning `admin/queue.ts`'s `open` filter states
 * for its own oldest-first order.
 */
async function loadDeadJobs(deps: AdminJobsDeps): Promise<DeadJobItem[] | null> {
  const { data, error } = await deps.supabase
    .from("jobs")
    .select(DEAD_JOB_COLUMNS)
    .eq("status", "dead")
    .order("finished_at", { ascending: true })
    .limit(DEAD_JOBS_LIMIT);

  if (error !== null) {
    console.error("[admin/jobs] dead-letter read failed", error);
    return null;
  }

  const rows = (data ?? []) as DeadJobRow[];
  const replayCounts = await loadReplayCounts(
    deps,
    rows.map((row) => row.id),
  );

  return rows.map((row) =>
    toDeadJobItem(row, replayCounts === null ? null : (replayCounts.get(row.id) ?? 0)),
  );
}

/**
 * Everything `/admin/monitoring/queues` renders. Composes `loadMetrics`
 * (jobs-by-status, `sweep_job_health()`) with `loadDeadJobs` above, run
 * concurrently since neither depends on the other.
 */
export async function loadQueueStatus(
  deps: AdminJobsDeps | null = defaultAdminJobsDeps(),
): Promise<QueueStatusView> {
  if (deps === null) {
    return { byStatus: null, sweepHealth: null, deadJobs: null };
  }

  const [metrics, deadJobs] = await Promise.all([
    loadMetrics({ supabase: deps.supabase }),
    loadDeadJobs(deps),
  ]);

  // `loadMetrics` only returns null when handed a null deps object (no
  // service-role client at all) - never true here, since `deps.supabase` is
  // already proven non-null by this point. `?? null` fails safe (unavailable)
  // rather than throwing on `metrics.jobs` if that invariant ever changes,
  // without adding a branch this module would need to prove reachable.
  return {
    byStatus: metrics?.jobs.byStatus ?? null,
    sweepHealth: metrics?.sweepJobHealth ?? null,
    deadJobs,
  };
}

// ---------------------------------------------------------------------------
// Replay (doc 39 "Replay procedure", doc 31 §5's "requeue action (audited)")
// ---------------------------------------------------------------------------

export type ReplayErrorCode =
  | "REASON_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "WRITE_FAILED"
  /** The CAS write hit `jobs_dedupe_idx` (0029): a live job already owns
   * this row's dedupe key. See the module header (I4) - NOT the same as
   * `WRITE_FAILED`, because retrying this replay cannot succeed until the
   * conflicting job finishes. */
  | "DEDUPE_CONFLICT"
  | "AUDIT_WRITE_FAILED"
  /** The reset could not be confirmed delivered, so it was reverted; the job
   * is still `dead`. See the module header (I3). */
  | "REPUBLISH_FAILED"
  | "DEPENDENCY_UNAVAILABLE";

export interface ReplayJobInput {
  jobId: string;
  actorId: string;
  reason: string;
  requestId: string;
}

export interface ReplayJobDetail {
  status: "queued";
  attempts: 0;
  /** The QStash message id this replay was delivered under. Always present
   * on success: `ok: true` now MEANS delivered - see the module header (I3).
   * A replay that could not be confirmed delivered is `ok: false` with code
   * `REPUBLISH_FAILED`, not a "succeeded but undelivered" detail flag. */
  messageId: string;
}

/** The shared failure shape - standalone (not a slice of `ReplayJobResult`)
 * so `fail()` also type-checks as `assertCanReplay`'s own `{ok:false, ...}`
 * arm below, which has a DIFFERENT `ok:true` shape (`{role}`, not
 * `{detail}`). Same reasoning as `consequences.ts`'s `ConsequenceFailure`. */
export interface ReplayFailure {
  ok: false;
  code: ReplayErrorCode;
  message: string;
}

export type ReplayJobResult = { ok: true; detail: ReplayJobDetail } | ReplayFailure;

function fail(code: ReplayErrorCode, message: string): ReplayFailure {
  return { ok: false, code, message };
}

interface JobRow {
  id: string;
  queue: string;
  status: string;
  payload: unknown;
  business_id: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  finished_at: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  scheduled_at: string;
  qstash_message_id: string | null;
}

const JOB_COLUMNS =
  "id, queue, status, payload, business_id, attempts, max_attempts, last_error, finished_at, started_at, heartbeat_at, scheduled_at, qstash_message_id";

/** Guard 1, shared with every consequence-ladder action's shape. */
function checkReason(reason: string): { ok: true; reason: string } | { ok: false; message: string } {
  const problem = reasonProblem(reason);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, reason: reason.trim() };
}

/**
 * Guard 2, by TABLE TRUTH - the same second, write-time read
 * `consequences.ts#assertCanAct` performs and for the identical reason: the
 * layout's `resolveAdminContext()` gated the PAGE render, and however long an
 * admin spends typing a reason sits between that and this write.
 *
 * Doc 31 §5 scopes `/admin/monitoring/queues` to `admin, super_admin` - NOT
 * `support` (§5's row lists it under the two, and §4.3 states "support ...
 * never mutates"). `canActOnLadder` already encodes exactly that predicate
 * (`role !== "support"`), so replay reuses it rather than inventing a second
 * copy of the same rule under a different name.
 */
async function assertCanReplay(
  deps: AdminJobsDeps,
  actorId: string,
): Promise<{ ok: true; role: AdminRole } | ReplayFailure> {
  const { data, error } = await deps.supabase
    .from("platform_admins")
    .select("role, is_active")
    .eq("user_id", actorId)
    .eq("is_active", true)
    .maybeSingle<{ role: string; is_active: boolean }>();

  if (error !== null) {
    console.error("[admin/jobs] actor verification failed", error);
    return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
  }
  if (data === null) {
    return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
  }

  const role = data.role as AdminRole;
  if (!canActOnLadder(role)) {
    return fail("FORBIDDEN", "Support accounts are read-only. Ask an admin to replay this job.");
  }
  return { ok: true, role };
}

/** Postgres unique violation - `jobs_dedupe_idx` firing on the CAS write
 * (I4). Same constant, same meaning as `queue/publish.ts`'s own. */
const UNIQUE_VIOLATION = "23505";

/**
 * Replay a dead job: doc 39's "Replay procedure", run as one guarded write,
 * a delivery attempt, and an audited record of the ACTUAL outcome. See the
 * module header for why every design choice below is what it is; this
 * function is the shape those choices add up to.
 *
 * GUARD ORDER (the same normative order `consequences.ts` documents and uses):
 *   1. A non-blank reason                     -> REASON_REQUIRED
 *   2. The actor may act (table truth)        -> FORBIDDEN
 *   3. The job exists                         -> NOT_FOUND
 *   4. The job is actually dead                -> INVALID_STATE
 *   5. Write the reset, guarded on `status='dead'` so a race loses cleanly;
 *      a `jobs_dedupe_idx` collision reports DEDUPE_CONFLICT specifically
 *   6. Attempt delivery. Not confirmed -> REVERT the reset, audit the
 *      failed attempt (`job.replay_failed`), report REPUBLISH_FAILED -
 *      never leave an undeliverable row sitting invisibly `queued` (I3)
 *   7. Delivered -> best-effort record the new `qstash_message_id`, write
 *      the `job.replayed` audit row; on audit failure, UNDO step 5
 */
export async function replayJob(
  input: ReplayJobInput,
  deps: AdminJobsDeps | null = defaultAdminJobsDeps(),
): Promise<ReplayJobResult> {
  if (deps === null) {
    return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");
  }

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  const actor = await assertCanReplay(deps, input.actorId);
  if (!actor.ok) return actor;

  const { data: job, error: readError } = await deps.supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("id", input.jobId)
    .maybeSingle<JobRow>();

  if (readError !== null) {
    console.error("[admin/jobs] job read failed", readError);
    return fail("WRITE_FAILED", "That job could not be read. Try again.");
  }
  if (job === null) return fail("NOT_FOUND", "That job no longer exists.");

  if (job.status !== "dead") {
    return fail(
      "INVALID_STATE",
      `Only dead jobs can be replayed. This job is currently "${job.status}".`,
    );
  }

  const now = deps.now();
  const patch = {
    status: "queued" as const,
    attempts: 0,
    last_error: null,
    finished_at: null,
    started_at: null,
    heartbeat_at: null,
    scheduled_at: now.toISOString(),
    qstash_message_id: null,
  };

  // The CAS: guarded on `status='dead'` so a concurrent change to this row
  // between the read above and this write (another admin replaying it, or a
  // worker somehow claiming it) loses cleanly rather than silently
  // overwriting whatever state won the race.
  const { data: updated, error: writeError } = await deps.supabase
    .from("jobs")
    .update(patch)
    .eq("id", input.jobId)
    .eq("status", "dead")
    .select("id")
    .maybeSingle<{ id: string }>();

  if (writeError !== null) {
    if (writeError.code === UNIQUE_VIOLATION) {
      // I4: a live job already owns this row's dedupe key. Not transient -
      // retrying THIS replay will collide again every time.
      return fail(
        "DEDUPE_CONFLICT",
        "Another job is already in flight for this exact work. This dead job cannot be replayed while that one is running.",
      );
    }
    console.error("[admin/jobs] job replay write failed", writeError);
    return fail("WRITE_FAILED", "The job could not be replayed. Try again.");
  }
  if (updated === null) {
    return fail(
      "INVALID_STATE",
      "This job changed while you were working. Refresh and check its current status.",
    );
  }

  // ---- Delivery, BEFORE the audit row - see the module header for why. ----
  // `isQueueName` narrows `job.queue` only within this expression; captured
  // in `queueName` (rather than a boolean `deliverable`) so that narrowing
  // survives into the `republish` call below.
  const queueName: QueueName | null = isQueueName(job.queue) ? job.queue : null;
  const deliverable = queueName !== null;
  const messageId =
    queueName === null
      ? null
      : await deps.republish(queueName, input.jobId, job.payload, job.business_id);

  if (messageId === null) {
    // I3: an undelivered `queued` row is invisible in this build (no
    // reconciler exists to ever pick it up), which is worse than dead. Undo
    // the reset so the job stays on the DLQ view, and say so plainly.
    await revertReplay(deps, input.jobId, job, {
      lastError: deliverable
        ? "Replay attempted but could not be redelivered to QStash; the job was left dead."
        : `Replay attempted but "${job.queue}" has no worker registered in this build; the job was left dead.`,
    });

    // Best effort: this is a forensic record of the ATTEMPT, not a state
    // change that needs the same write-then-audit-else-revert gate step 7
    // uses - the row is already back to what it was, so there is nothing
    // left to protect if this insert itself fails, only something useful to
    // lose (see I6: this is what lets an operator see a job was already
    // tried and failed to deliver, not merely that it exists).
    const { error: failureAuditError } = await deps.supabase.from("audit_logs").insert({
      actor_id: input.actorId,
      actor_kind: "admin",
      actor_role: actor.role,
      business_id: job.business_id,
      action: ACTION_JOB_REPLAY_FAILED,
      entity_type: ENTITY_JOB,
      entity_id: input.jobId,
      before: { status: job.status, attempts: job.attempts, last_error: job.last_error } as unknown as Json,
      after: { status: "dead", attempts: job.attempts, redelivered: false } as unknown as Json,
      reason: reason.reason,
      request_id: input.requestId,
    });
    if (failureAuditError !== null) {
      console.error("[admin/jobs] could not record the failed replay attempt for job", input.jobId, failureAuditError);
    }

    return fail(
      "REPUBLISH_FAILED",
      deliverable
        ? "The job was reset but could not be redelivered, so it was left dead. Try again once the delivery problem is fixed."
        : `This build has no worker for queue "${job.queue}", so nothing was replayed. The job was left dead.`,
    );
  }

  // Best effort, same standing as `enqueue()`'s own post-publish write:
  // losing this costs DLQ/QStash correlation on the NEXT dead-lettering,
  // nothing about the delivery that already happened.
  const { error: messageIdError } = await deps.supabase
    .from("jobs")
    .update({ qstash_message_id: messageId })
    .eq("id", input.jobId);
  if (messageIdError !== null) {
    console.error(
      `[admin/jobs] job ${input.jobId} was redelivered as ${messageId} but the id could not be recorded`,
      messageIdError,
    );
  }

  const { error: auditError } = await deps.supabase.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_kind: "admin",
    actor_role: actor.role,
    business_id: job.business_id,
    action: ACTION_JOB_REPLAYED,
    entity_type: ENTITY_JOB,
    entity_id: input.jobId,
    before: {
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      last_error: job.last_error,
    } as unknown as Json,
    after: { status: patch.status, attempts: patch.attempts, last_error: patch.last_error } as unknown as Json,
    reason: reason.reason,
    request_id: input.requestId,
  });

  if (auditError !== null) {
    console.error("[admin/jobs] audit write failed for job replay", auditError);
    await revertReplay(deps, input.jobId, job);
    return fail("AUDIT_WRITE_FAILED", "The job was not replayed because it could not be recorded.");
  }

  return { ok: true, detail: { status: "queued", attempts: 0, messageId } };
}

/**
 * Put the row back after either (a) the audit row that was supposed to
 * justify the replay failed to write, or (b) delivery could not be
 * confirmed (I3) - the same UNDO `consequences.ts#revert` performs, best
 * effort, loud on failure. See that module's header for why neither write
 * order avoids case (a), and the module header above for why (b) exists at
 * all.
 *
 * `overrides.lastError` lets the (b) caller leave a note explaining WHY the
 * job is dead again, instead of restoring the stale error from whatever
 * killed it the first time - an operator reading the DLQ row should see
 * "someone already tried this and it didn't deliver", not silence.
 */
async function revertReplay(
  deps: AdminJobsDeps,
  jobId: string,
  original: JobRow,
  overrides: { lastError?: string } = {},
): Promise<void> {
  const { error } = await deps.supabase
    .from("jobs")
    .update({
      status: original.status,
      attempts: original.attempts,
      last_error: overrides.lastError ?? original.last_error,
      finished_at: original.finished_at,
      started_at: original.started_at,
      heartbeat_at: original.heartbeat_at,
      scheduled_at: original.scheduled_at,
      qstash_message_id: original.qstash_message_id,
    })
    .eq("id", jobId);

  if (error !== null) {
    console.error(
      `[admin/jobs] UNAUDITED CHANGE: the replay of job ${jobId} could not be recorded and could not be reverted`,
      error,
    );
    return;
  }
  console.warn(`[admin/jobs] the replay of job ${jobId} was reverted (${overrides.lastError ?? "audit write failed"})`);
}

// ---------------------------------------------------------------------------
// Re-publishing to QStash - see the module header for why this exists here.
// ---------------------------------------------------------------------------

const REPUBLISH_TIMEOUT_MS = 5_000;

/** The same shape `queue/publish.ts`'s own `publishResponseSchema` checks -
 * see the module header on why an HTML error page served with a 200 must
 * not be read as a delivered message here either. */
const republishResponseSchema = z.union([
  z.object({ messageId: z.string().min(1) }),
  z.array(z.object({ messageId: z.string().min(1) })).min(1),
]);

/**
 * Re-deliver an already-reset job row to QStash under its ORIGINAL `job_id`
 * (doc 39's own words). Never throws; every failure - unconfigured,
 * unreachable, refused, or a 200 whose body does not actually name a
 * message - returns `null`, exactly as `queue/publish.ts`'s own `publish()`
 * treats the identical set of failures. `replayJob` treats `null` as "not
 * delivered", not merely "not confirmed" - see the module header (I3) for
 * why the two are NOT the same thing to this caller, unlike a normal
 * `enqueue()`.
 *
 * Exported (unlike a purely internal helper) so it can be tested directly
 * against a fake `fetchImpl`, the same seam `publish()` uses - not because
 * anything outside this module is meant to call it; `defaultAdminJobsDeps()`
 * is the one production call site.
 */
export async function republishDeadJob(
  queue: QueueName,
  jobId: string,
  payload: unknown,
  businessId: string | null,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    console.warn(`[admin/jobs] server env is unreadable; could not redeliver job ${jobId}`, error);
    return null;
  }

  const { QSTASH_URL, QSTASH_TOKEN, QSTASH_CALLBACK_ORIGIN } = env;
  if (QSTASH_URL === undefined || QSTASH_TOKEN === undefined || QSTASH_CALLBACK_ORIGIN === undefined) {
    console.warn(`[admin/jobs] QStash is not configured; could not redeliver job ${jobId}`);
    return null;
  }

  const baseUrl = QSTASH_URL.replace(/\/+$/, "");
  const callbackOrigin = QSTASH_CALLBACK_ORIGIN.replace(/\/+$/, "");
  const destination = `${callbackOrigin}${queuePath(queue)}`;
  const entry = QUEUE_REGISTRY[queue];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPUBLISH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}/v2/publish/${destination}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${QSTASH_TOKEN}`,
        "Content-Type": "application/json",
        "Upstash-Retries": String(Math.max(0, entry.maxAttempts - 1)),
        "Upstash-Flow-Control-Key": flowControlKey(queue, businessId),
        "Upstash-Flow-Control-Value": entry.flowControlValue,
      },
      body: JSON.stringify({ job_id: jobId, ...(payload as Record<string, Json>) }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(
        `[admin/jobs] QStash refused the replay publish for job ${jobId} with status ${response.status}`,
      );
      return null;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      console.error(`[admin/jobs] QStash returned a non-JSON body for replayed job ${jobId}`, error);
      return null;
    }

    const parsed = republishResponseSchema.safeParse(body);
    if (!parsed.success) {
      // Catches the review's own example: an HTML error page served with a
      // 200. `response.ok` alone would have read this as delivered.
      console.error(`[admin/jobs] QStash returned an unexpected body for replayed job ${jobId}`);
      return null;
    }

    return Array.isArray(parsed.data) ? (parsed.data[0]?.messageId ?? null) : parsed.data.messageId;
  } catch (error) {
    console.error(`[admin/jobs] could not reach QStash to replay job ${jobId}`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
