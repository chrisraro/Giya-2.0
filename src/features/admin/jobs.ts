import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

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
// disagree with what a normal enqueue computes. It is best effort, exactly as
// `enqueue()`'s own publish step is: doc 39's "Postgres is the truth" applies
// here unchanged, so a publish failure is logged and the ROW - already reset
// and already audited - is left as the durable, recoverable truth. A future
// task that is allowed to touch `queue/publish.ts` should replace this with a
// shared `republish()` export; noted rather than silently accepted.
// ===========================================================================

const DEAD_JOBS_LIMIT = 100;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface AdminJobsDeps {
  /** MUST be the service-role client. See the header. */
  supabase: SupabaseClient<Database>;
  now: () => Date;
  /**
   * Injected in tests. Defaults to a real QStash publish. Never rejects: a
   * publish failure is reported as `false`, not thrown, matching
   * `src/lib/queue/publish.ts`'s own `publish()` contract.
   */
  republish: (queue: QueueName, jobId: string, payload: unknown, businessId: string | null) => Promise<boolean>;
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

function toDeadJobItem(row: DeadJobRow): DeadJobItem {
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
  };
}

/**
 * The dead-letter LIST - doc 31 §5's "dead list with `payload`, `last_error`,
 * attempts, linked entity", which `loadMetrics` (t2-3) does not read: that
 * module answers "how many are dead", never "which ones".
 *
 * `null` on any read failure, `[]` on a genuinely clean platform - see
 * `QueueStatusView`'s own doc for why the distinction is load-bearing here.
 */
async function loadDeadJobs(deps: AdminJobsDeps): Promise<DeadJobItem[] | null> {
  const { data, error } = await deps.supabase
    .from("jobs")
    .select(DEAD_JOB_COLUMNS)
    .eq("status", "dead")
    .order("finished_at", { ascending: false })
    .limit(DEAD_JOBS_LIMIT);

  if (error !== null) {
    console.error("[admin/jobs] dead-letter read failed", error);
    return null;
  }

  return ((data ?? []) as DeadJobRow[]).map(toDeadJobItem);
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
  | "AUDIT_WRITE_FAILED"
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
  /** Whether the best-effort re-publish to QStash succeeded. `false` does NOT
   * mean the replay failed - see the module header. */
  republished: boolean;
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

const ENTITY_JOB = "job";
const ACTION_JOB_REPLAYED = "job.replayed";

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

/**
 * Replay a dead job: doc 39's "Replay procedure", run as one guarded write
 * plus an audited record of it. See the module header for why every design
 * choice below is what it is; this function is the shape those choices add
 * up to.
 *
 * GUARD ORDER (the same normative order `consequences.ts` documents and uses):
 *   1. A non-blank reason                    -> REASON_REQUIRED
 *   2. The actor may act (table truth)        -> FORBIDDEN
 *   3. The job exists                         -> NOT_FOUND
 *   4. The job is actually dead                -> INVALID_STATE
 *   5. Write the reset, guarded on `status='dead'` so a race loses cleanly
 *   6. Write exactly one audit row; on failure, UNDO step 5
 *   7. Best-effort re-publish to QStash (never affects the result above)
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
  const before = {
    status: job.status,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    last_error: job.last_error,
  };
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
  const after = { status: patch.status, attempts: patch.attempts, last_error: patch.last_error };

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
    console.error("[admin/jobs] job replay write failed", writeError);
    return fail("WRITE_FAILED", "The job could not be replayed. Try again.");
  }
  if (updated === null) {
    return fail(
      "INVALID_STATE",
      "This job changed while you were working. Refresh and check its current status.",
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
    before: before as unknown as Json,
    after: after as unknown as Json,
    reason: reason.reason,
    request_id: input.requestId,
  });

  if (auditError !== null) {
    console.error("[admin/jobs] audit write failed for job replay", auditError);
    await revertReplay(deps, input.jobId, job);
    return fail("AUDIT_WRITE_FAILED", "The job was not replayed because it could not be recorded.");
  }

  let republished = false;
  if (isQueueName(job.queue)) {
    republished = await deps.republish(job.queue, input.jobId, job.payload, job.business_id);
  } else {
    // Defensive only: every queue this build enqueues into is registered
    // (`src/lib/queue/queues.ts`), so a dead row naming anything else is data
    // from outside that registry. The row is still reset and audited above;
    // only the delivery attempt is skipped, loudly.
    console.warn(
      `[admin/jobs] job ${input.jobId} was replayed but its queue "${job.queue}" is not in this build's registry; nothing was published`,
    );
  }

  return { ok: true, detail: { status: "queued", attempts: 0, republished } };
}

/**
 * Put the row back after the audit row that was supposed to justify the
 * replay failed to write - the same UNDO `consequences.ts#revert` performs,
 * best effort, loud on failure. See that module's header for why neither
 * write-order avoids this case and why best effort is still the correct
 * response to an undo that itself fails.
 */
async function revertReplay(deps: AdminJobsDeps, jobId: string, original: JobRow): Promise<void> {
  const { error } = await deps.supabase
    .from("jobs")
    .update({
      status: original.status,
      attempts: original.attempts,
      last_error: original.last_error,
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
  console.warn(`[admin/jobs] the replay of job ${jobId} was reverted because its audit row could not be written`);
}

// ---------------------------------------------------------------------------
// Re-publishing to QStash - see the module header for why this exists here.
// ---------------------------------------------------------------------------

const REPUBLISH_TIMEOUT_MS = 5_000;

/**
 * Best-effort re-delivery of an already-reset job row to QStash. Never
 * throws and never returns anything the caller must react to beyond the
 * boolean: `replayJob` above has already committed the row and the audit row
 * by the time this runs, and doc 39's own principle - "Postgres is the truth"
 * - applies to a replay exactly as it applies to a fresh enqueue.
 *
 * Exported (unlike a purely internal helper) so it can be tested directly
 * against a fake `fetchImpl`, the same seam `src/lib/queue/publish.ts`'s own
 * `publish()` uses - not because anything outside this module is meant to
 * call it; `defaultAdminJobsDeps()` is the one production call site.
 */
export async function republishDeadJob(
  queue: QueueName,
  jobId: string,
  payload: unknown,
  businessId: string | null,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    console.warn(`[admin/jobs] server env is unreadable; job ${jobId} stays queued for a manual worker run`, error);
    return false;
  }

  const { QSTASH_URL, QSTASH_TOKEN, QSTASH_CALLBACK_ORIGIN } = env;
  if (QSTASH_URL === undefined || QSTASH_TOKEN === undefined || QSTASH_CALLBACK_ORIGIN === undefined) {
    console.warn(`[admin/jobs] QStash is not configured; job ${jobId} stays queued for a manual worker run`);
    return false;
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
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[admin/jobs] could not reach QStash to replay job ${jobId}`, error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
