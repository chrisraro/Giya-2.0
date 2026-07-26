import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import { QUEUE_REGISTRY, flowControlKey, queuePath } from "./queues";
import type { QueueName } from "./queues";

// =============================================================================
// enqueue(): the ONE way work is scheduled.
// =============================================================================
//
// docs/30-modules/39-background-jobs.md: "Enqueue path (only via
// src/lib/queue/enqueue.ts, never raw QStash SDK calls from features)". That is
// this module, under the name the task named. No feature imports a QStash SDK,
// and there is no SDK to import: like src/lib/ai/llm.ts, the provider is reached
// with plain `fetch` against its REST API.
//
// -----------------------------------------------------------------------------
// THE ORDER IS THE DESIGN: ROW FIRST, PUBLISH SECOND
// -----------------------------------------------------------------------------
// Doc 39's first principle is that Postgres is the truth and QStash is only
// delivery. That is not a slogan about where data lives, it is an instruction
// about the order of two writes:
//
//   1. INSERT jobs (status='queued')   <- the work now EXISTS
//   2. publish to QStash               <- the work now has a DELIVERY
//
// Reverse them and a crash between the two leaves a message in flight for a job
// row that does not exist, and the worker's first act (claim the row) fails on
// a job nobody can ever explain. In this order, the same crash leaves a `queued`
// row with `qstash_message_id is null`, which is precisely the predicate doc
// 39's hourly reconciler scans for. A lost publish is recoverable; a lost row is
// not.
//
// The corollary is that step 2 failing is NOT an enqueue failure. The row is
// there, it is queued, and it is exactly what a retry expects to find. This
// module says so in its return value (`published: false`) rather than throwing.
//
// -----------------------------------------------------------------------------
// THE CONTRACT: THIS FUNCTION NEVER THROWS
// -----------------------------------------------------------------------------
// Same contract, and the same reasoning, as
// src/features/notifications/server/raise.ts: every caller has just finished
// doing the thing worth scheduling work about - a receipt submitted, a
// notification raised - and every one of those is already committed by the time
// this is reached. So the failure mode is a return value and a log line, never
// an exception. Concretely: enqueuing a delivery email must not be able to
// un-approve a receipt.
//
// That makes fail-soft the DEFAULT rather than something each call site has to
// remember, which is the only shape where it cannot regress. The first call site
// written without a try/catch would otherwise turn a QStash outage into a failed
// receipt.
//
// -----------------------------------------------------------------------------
// DEDUPE: WHY IT IS A CAUGHT 23505 AND NOT AN UPSERT
// -----------------------------------------------------------------------------
// Doc 39 writes step 1 as `ON CONFLICT on (queue, dedupe_key) where
// queued/running -> return existing job`. `jobs_dedupe_idx` is a PARTIAL unique
// index, and Postgres can only infer a partial index for ON CONFLICT when the
// statement itself carries a matching WHERE clause - which PostgREST's upsert
// cannot express. Rather than widen the index to make the client library happy
// (which would let a dead job hold its key forever, see 0029), the insert is
// issued plainly and the 23505 is caught. The database still arbitrates; only
// the reporting of the conflict moved.

const LOG_PREFIX = "[queue/publish]";

/** Postgres unique violation, the dedupe index firing. */
const UNIQUE_VIOLATION = "23505";

/** Doc 39: the enqueue is not on any user-visible latency path, but it is on the
 * receipt submission path, so it may not hang there either. */
const PUBLISH_TIMEOUT_MS = 5_000;

/** QStash answers a publish with the message id it assigned. Validated rather
 * than trusted, for the reason src/lib/ai/llm.ts states: this is a third-party
 * service we do not deploy in lockstep with, and an HTML error page served with
 * a 200 must not become `undefined` three frames deeper. */
const publishResponseSchema = z.union([
  z.object({ messageId: z.string().min(1) }),
  // Publishing to a URL group answers with an array of per-destination results.
  // Not used today, accepted so it is not a surprise the day it is.
  z.array(z.object({ messageId: z.string().min(1) })).min(1),
]);

export interface EnqueueInput {
  readonly queue: QueueName;
  /**
   * IDENTIFIERS ONLY. Doc 39: "payloads carry identifiers, never denormalized
   * state that can go stale." The worker re-reads everything else. A payload
   * carrying a receipt's total would be a second copy of the money, and the
   * retry three hours later would use the stale one.
   *
   * `job_id` is added by this module, not by the caller.
   */
  readonly payload: Record<string, Json>;
  readonly businessId?: string | null;
  /**
   * The in-flight uniqueness key for this queue; see each queue's
   * `dedupeKeyDescription`. Omit for genuinely fire-and-forget work.
   */
  readonly dedupeKey?: string | null;
  /** Seconds to hold the message before first delivery. Doc 39's fan-out jitter. */
  readonly delaySeconds?: number;
  /** Injected in tests. Defaults to the service-role client. */
  readonly supabase?: SupabaseClient<Database> | null;
  /** Injected in tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export type EnqueueResult =
  | {
      readonly status: "enqueued";
      readonly jobId: string;
      /**
       * False when the row landed but QStash did not take the message. NOT an
       * error: the reconciler re-publishes `queued` rows with no message id.
       */
      readonly published: boolean;
      readonly messageId: string | null;
    }
  | {
      /** An in-flight job already owns this dedupe key. Doc 39's "no double-publish". */
      readonly status: "deduplicated";
      readonly jobId: string | null;
    }
  | {
      /** The ROW could not be written. The only genuine failure this has. */
      readonly status: "failed";
      readonly reason: string;
    };

interface QStashConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly callbackOrigin: string;
}

/**
 * The QStash configuration, or null when this deployment has none.
 *
 * Null is a first-class state, not an error: doc 39's local-development section
 * has schedules unsynced and workers invoked directly, and this repo's
 * credentials landed at the end of the build like every other one. With no
 * config the row is still written and still queued, which is the whole point of
 * writing it first.
 *
 * `QSTASH_CALLBACK_ORIGIN` is required alongside the token because a publish
 * needs a destination URL that the internet can reach, and there is no honest
 * default: on a developer machine the app is on localhost, which QStash cannot
 * call, and inventing `http://localhost:3000` would produce messages that fail
 * forever in the QStash console rather than jobs that wait quietly in Postgres.
 */
function readConfig(): QStashConfig | null {
  let env;
  try {
    env = getServerEnv();
  } catch (error) {
    console.warn(`${LOG_PREFIX} server env is unreadable; the job row will not be published`, error);
    return null;
  }

  const { QSTASH_URL, QSTASH_TOKEN, QSTASH_CALLBACK_ORIGIN } = env;
  if (
    QSTASH_URL === undefined ||
    QSTASH_TOKEN === undefined ||
    QSTASH_CALLBACK_ORIGIN === undefined
  ) {
    return null;
  }

  return {
    // Trailing slashes are stripped so `${base}/v2/publish/...` cannot become a
    // double slash, which QStash answers with a 404 that looks like a routing
    // bug rather than a configuration one.
    baseUrl: QSTASH_URL.replace(/\/+$/, ""),
    token: QSTASH_TOKEN,
    callbackOrigin: QSTASH_CALLBACK_ORIGIN.replace(/\/+$/, ""),
  };
}

/**
 * Can this deployment actually DELIVER a job, as opposed to merely record one?
 *
 * The distinction matters to exactly one kind of caller: one that has a working
 * synchronous fallback and needs to choose between the two BEFORE it writes
 * anything. `enqueue()` deliberately does not expose the choice - it writes the
 * row either way, because for a fire-and-forget caller a durable row plus doc
 * 39's reconciler is strictly better than nothing. But for a caller that would
 * otherwise do the work inline, an unconfigured deployment should not
 * accumulate `jobs` rows that nothing will ever deliver: that is a queue whose
 * depth only grows, which is precisely what doc 39's metrics section says a
 * registry entry without a worker looks like.
 *
 * So this is the same env selection `getOcrProvider()` makes, exported for the
 * same reason: the caller picks a path, once, and says in the log which one it
 * picked. See src/features/receipts/server/submit.ts.
 *
 * Reads the SAME `readConfig()` the publish uses, so the two can never disagree
 * about what "configured" means - a predicate that tested only `QSTASH_TOKEN`
 * would answer true for a deployment with no callback origin, whose every
 * publish then fails.
 */
export function isQueueConfigured(): boolean {
  return readConfig() !== null;
}

/**
 * Schedule one unit of work.
 *
 * NEVER THROWS. See the module header. The caller may ignore the result
 * entirely; logging it is enough, and nothing about the caller's own outcome
 * may depend on it.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  try {
    const supabase =
      input.supabase === undefined ? createServiceRoleClient() : input.supabase;

    if (supabase === null) {
      // The documented degraded path of createServiceRoleClient. Without the
      // service-role key there is no way to write the row at all, and doc 39's
      // whole recovery story depends on the row existing, so publishing anyway
      // would create a message for a job that does not exist - the exact
      // ordering failure this module is built to avoid.
      return { status: "failed", reason: "no service-role client" };
    }

    const entry = QUEUE_REGISTRY[input.queue];
    const businessId = input.businessId ?? null;
    const dedupeKey = input.dedupeKey ?? null;
    const delaySeconds = Math.max(0, Math.floor(input.delaySeconds ?? 0));

    // ---- 1. the row --------------------------------------------------------
    const scheduledAt = new Date(Date.now() + delaySeconds * 1_000).toISOString();

    const { data: inserted, error: insertError } = await supabase
      .from("jobs")
      .insert({
        queue: input.queue,
        status: "queued",
        // `job_id` is deliberately NOT in the stored payload: the row's own id
        // is the job id, and storing it twice would let the two disagree. It is
        // added to the PUBLISHED body below, where the worker needs it.
        payload: input.payload as Json,
        business_id: businessId,
        dedupe_key: dedupeKey,
        max_attempts: entry.maxAttempts,
        scheduled_at: scheduledAt,
      })
      .select("id")
      .single();

    if (insertError !== null) {
      if (insertError.code === UNIQUE_VIOLATION) {
        // Doc 39 step 1: an in-flight job already owns this key, so return it
        // rather than publishing a second message for the same work.
        const existingId = await findInFlightJob(supabase, input.queue, dedupeKey);
        console.info(
          `${LOG_PREFIX} ${input.queue} already has an in-flight job for dedupe key ${dedupeKey ?? "(none)"}`,
        );
        return { status: "deduplicated", jobId: existingId };
      }
      console.error(`${LOG_PREFIX} could not write the ${input.queue} job row`, insertError);
      return { status: "failed", reason: insertError.message };
    }

    const jobId = inserted.id;

    // ---- 2. the delivery ---------------------------------------------------
    const messageId = await publish({
      queue: input.queue,
      jobId,
      payload: input.payload,
      businessId,
      delaySeconds,
      // Spread rather than assigned: `exactOptionalPropertyTypes` makes an
      // explicit `undefined` a different thing from an absent property, and the
      // seam is "absent means use the global fetch".
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    });

    if (messageId !== null) {
      // Best effort: the message is already in flight, so failing to record its
      // id costs DLQ correlation and nothing else. Certainly not worth
      // reporting the enqueue as failed and inviting a duplicate.
      const { error: updateError } = await supabase
        .from("jobs")
        .update({ qstash_message_id: messageId })
        .eq("id", jobId);
      if (updateError !== null) {
        console.error(
          `${LOG_PREFIX} job ${jobId} was published as ${messageId} but the id could not be recorded`,
          updateError,
        );
      }
    }

    return { status: "enqueued", jobId, published: messageId !== null, messageId };
  } catch (error) {
    // The last-resort swallow, and the whole point of the module. Anything
    // reaching here is unexpected, and none of it may reach the caller: the
    // receipt is already saved, the notification is already raised.
    console.error(`${LOG_PREFIX} unexpected failure enqueuing ${input.queue}`, error);
    return { status: "failed", reason: "unexpected failure" };
  }
}

/**
 * The job that owns a dedupe key right now, if it is still readable.
 *
 * Returns null rather than throwing on any problem, including the genuinely
 * common one: the conflicting job finished between the failed insert and this
 * read, so nothing is in flight any more. The caller already knows the enqueue
 * was a no-op; the id is a convenience for the log and for a caller that wants
 * to watch the existing job.
 */
async function findInFlightJob(
  supabase: SupabaseClient<Database>,
  queue: QueueName,
  dedupeKey: string | null,
): Promise<string | null> {
  if (dedupeKey === null) return null;
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("id")
      .eq("queue", queue)
      .eq("dedupe_key", dedupeKey)
      .in("status", ["queued", "running"])
      .maybeSingle<{ id: string }>();
    if (error !== null || data === null) return null;
    return data.id;
  } catch {
    return null;
  }
}

interface PublishInput {
  readonly queue: QueueName;
  readonly jobId: string;
  readonly payload: Record<string, Json>;
  readonly businessId: string | null;
  readonly delaySeconds: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Hand the message to QStash. Returns its id, or null for every failure: no
 * configuration, network refused, timeout, 4xx, 5xx, an unreadable body.
 *
 * Null is never an error the caller must handle, because the row is already
 * durable. It is the state doc 39's reconciler exists to notice.
 */
async function publish(input: PublishInput): Promise<string | null> {
  const config = readConfig();
  if (config === null) {
    console.warn(
      `${LOG_PREFIX} QStash is not configured; job ${input.jobId} stays queued for the reconciler`,
    );
    return null;
  }

  const entry = QUEUE_REGISTRY[input.queue];
  const destination = `${config.callbackOrigin}${queuePath(input.queue)}`;
  const doFetch = input.fetchImpl ?? globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PUBLISH_TIMEOUT_MS);

  try {
    const response = await doFetch(`${config.baseUrl}/v2/publish/${destination}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        // Doc 39: `retries` on publish = max_attempts - 1, so the number of
        // DELIVERIES QStash makes equals the number of attempts the row budgets.
        // Off by one in either direction and `jobs.max_attempts` stops meaning
        // what the DLQ view says it means.
        "Upstash-Retries": String(Math.max(0, entry.maxAttempts - 1)),
        "Upstash-Flow-Control-Key": flowControlKey(input.queue, input.businessId),
        "Upstash-Flow-Control-Value": entry.flowControlValue,
        ...(input.delaySeconds > 0 ? { "Upstash-Delay": `${input.delaySeconds}s` } : {}),
      },
      // `job_id` is added HERE and nowhere else: the worker needs it to claim
      // the row, and the row does not need a copy of its own primary key.
      body: JSON.stringify({ job_id: input.jobId, ...input.payload }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(
        `${LOG_PREFIX} QStash refused job ${input.jobId} with status ${response.status}; it stays queued`,
      );
      return null;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      console.error(`${LOG_PREFIX} QStash returned a non-JSON body for job ${input.jobId}`, error);
      return null;
    }

    const parsed = publishResponseSchema.safeParse(body);
    if (!parsed.success) {
      console.error(`${LOG_PREFIX} QStash returned an unexpected body for job ${input.jobId}`);
      return null;
    }

    return Array.isArray(parsed.data) ? (parsed.data[0]?.messageId ?? null) : parsed.data.messageId;
  } catch (error) {
    console.error(`${LOG_PREFIX} could not reach QStash for job ${input.jobId}; it stays queued`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
