import { NextResponse, type NextRequest } from "next/server";

import { processReceipt } from "@/features/receipts/server/process";
import { claimJob, finishJob } from "@/lib/queue/claim";
import { startHeartbeat } from "@/lib/queue/heartbeat";
import { queuePath } from "@/lib/queue/queues";
import { verifyQStashRequest } from "@/lib/queue/verify";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runOcrProcess } from "@/workers/receipts/ocr";
import { ocrProcessPayloadSchema } from "@/workers/receipts/schemas";

// =============================================================================
// POST /api/jobs/ocr.process - the `ocr.process` worker route. THE MONEY PATH.
// =============================================================================
//
// docs/30-modules/39-background-jobs.md, "Worker invocation contract", and doc
// 36 Stage 2. The five steps are in the order the document gives, and the order
// is the security property: nothing at all happens before the signature is
// verified.
//
//   1. verify the signature      -> 401, no processing, no log of the payload
//   2. Zod-parse the payload     -> terminal (the job is marked dead), 200
//   3. claim the job row         -> 200 on every duplicate/terminal branch
//   4. do the work               -> processReceipt, via src/workers/receipts/ocr.ts
//   5. record the outcome, then answer 200 (done) or 5xx (retry)
//
// This route is deliberately the same shape as
// src/app/api/jobs/notify.email/route.ts, down to the branches. That is not
// duplication for its own sake: doc 39's contract is per-worker, the two
// workers differ only in step 4, and the alternative - a shared dispatcher -
// would be the "one route, many queues" design the registry's own comment
// rejects. What differs here is documented where it differs.
//
// -----------------------------------------------------------------------------
// WHY THIS ROUTE DOES NOT USE defineHandler
// -----------------------------------------------------------------------------
// The same three reasons notify.email gives, unchanged and worth repeating
// because this is the route an attacker would rather reach:
//
//   * defineHandler runs work before we would get control - it constructs a
//     Supabase client and calls `auth.getUser()` on every request, a network
//     round trip to the auth server. Doc 39's step 1 is "verify the signature;
//     failure -> 401, NO PROCESSING", and an unauthenticated round trip on
//     behalf of whoever knocked is processing. It is also a free amplification
//     primitive pointed at our own auth server.
//   * Its contract is the wrong one. It answers doc 13's envelope to a caller
//     that is not a client and reads only the status code - and the error half
//     of that envelope is a NAMED REASON, which is exactly what verify.ts's
//     rule 4 says must never reach this caller.
//   * Its session/rate-limit/idempotency machinery has nothing to apply to. A
//     worker request has no session, its rate limiting is QStash's flow control
//     (`ocr`, parallelism 10), and its idempotency is the job claim.
//
// What is NOT skipped is the discipline: the raw body is read exactly once, the
// payload is Zod-parsed before use, errors are caught, and nothing about the
// failure reaches the response body.
//
// -----------------------------------------------------------------------------
// WHAT THE STATUS CODES MEAN TO QSTASH
// -----------------------------------------------------------------------------
// QStash retries on 5xx and stops on 2xx. So a 5xx is a REQUEST, not a report:
// it asks for the message to be delivered again. Every branch below that cannot
// be improved by another delivery therefore answers 200, including the ones
// that are plainly bad news.
//
// The interesting half of that decision is not here, it is in
// src/workers/receipts/ocr.ts, which explains at length why a REJECTED receipt
// is a 200 and a receipt still at 'processing' is a 5xx. The short version:
// `processReceipt` never throws and owns its own terminal/retryable states, so
// "did it throw" says nothing and `receipts.status` says everything. Answering
// 5xx to a rejected receipt would retry a decision the platform correctly made
// until the attempt budget was gone; answering 200 to a parked one would
// abandon a receipt a consumer is watching.
//
// 401 is the one exception and it is not a retry decision at all: an unsigned
// request is not a job.

/**
 * Doc 39's timeout budget table: `ocr.process` gets 120s ("OCR service call
 * capped at 90s client-side").
 *
 * A literal, not `QUEUE_REGISTRY[QUEUE].maxDurationSeconds`, because Next reads
 * this export statically at build time and a computed value is silently
 * ignored - which would leave the route on the platform default while the code
 * looked like it had set it. The registry carries the same number and the
 * route.test.ts beside this file asserts the two agree, which is the only way
 * to keep a literal honest without a build step.
 */
export const maxDuration = 120;

/** The queue this route serves. One route, one queue. */
const QUEUE = "ocr.process" as const;

const LOG_PREFIX = "[api/jobs/ocr.process]";

/** A bare 401. No body, no code, no reason - see verify.ts rule 4: four
 * different rejection reasons are four facts about our configuration, and
 * handing them to whoever is probing turns a closed door into an oracle. */
function unauthorized(): NextResponse {
  return new NextResponse(null, { status: 401 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The raw bytes, read once and before anything else: a Request body is a
  // single-use stream, and the signature covers a hash of these exact bytes.
  // Re-serializing a parsed body would reorder keys and break the hash, which
  // is why the parse below happens on this string and not the other way round.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return unauthorized();
  }

  // ---- 1. signature ------------------------------------------------------
  const verified = verifyQStashRequest({
    signature: request.headers.get("upstash-signature"),
    rawBody,
    path: queuePath(QUEUE),
  });

  if (!verified.ok) {
    // The reason is logged and never returned. The raw body is NOT logged:
    // anyone can post anything here, and writing unverified input into the log
    // is how a rejected request still gets to say something.
    console.warn(`${LOG_PREFIX} rejected an unverified request: ${verified.reason}`);
    return unauthorized();
  }

  // ---- from here the request is authentic ---------------------------------

  const supabase = createServiceRoleClient();
  if (supabase === null) {
    // No service-role key, so the job row cannot be claimed or finished and the
    // receipt cannot be read. RETRYABLE: the work has not been done and nothing
    // is touched, so a later delivery against a configured deployment does
    // exactly the right thing.
    console.error(`${LOG_PREFIX} no service-role client; asking QStash to retry`);
    return new NextResponse(null, { status: 503 });
  }

  // ---- 2. payload --------------------------------------------------------
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    console.error(`${LOG_PREFIX} authentic request carried a body that is not JSON`);
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  const payload = ocrProcessPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    // Doc 39's taxonomy: a Zod failure is TERMINAL. The third delivery carries
    // the same bytes. If the id is readable the row is marked dead so the
    // operator sees it in the DLQ view rather than losing it entirely - and for
    // this queue that row is a consumer's receipt, so losing it silently is the
    // outcome most worth avoiding.
    const jobId = readJobId(parsedBody);
    console.error(
      `${LOG_PREFIX} payload does not match the schema for job ${jobId ?? "(unreadable)"}`,
    );
    if (jobId !== null) {
      await finishJob(supabase, jobId, { kind: "dead", error: "payload failed schema validation" });
    }
    return NextResponse.json({ ok: false }, { status: 200 });
  }

  const jobId = payload.data.job_id;

  // ---- 3. claim ----------------------------------------------------------
  const claim = await claimJob({ supabase, jobId, queue: QUEUE });

  switch (claim.status) {
    case "done":
      console.info(`${LOG_PREFIX} job ${jobId} is already ${claim.jobStatus}; duplicate delivery`);
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    case "held":
      console.info(`${LOG_PREFIX} job ${jobId} is owned by another invocation`);
      return NextResponse.json({ ok: true, held: true }, { status: 200 });
    case "exhausted":
      // The job is dead. The RECEIPT is not necessarily terminal - it may still
      // be at 'processing' - and that is deliberately not fixed up here: doc 36
      // gives that job to `sweep_stuck_receipts` (0028), which applies the same
      // dead-letter state (rejected / manual / 'processing_failed') once it is
      // certain the attempt budget is spent. Two writers racing to declare the
      // same receipt dead is how a receipt gets rejected while an attempt is
      // still in flight.
      console.error(`${LOG_PREFIX} job ${jobId} exhausted its attempts and is now dead`);
      return NextResponse.json({ ok: false, dead: true }, { status: 200 });
    case "missing":
      console.error(`${LOG_PREFIX} job ${jobId} does not exist on this queue`);
      return NextResponse.json({ ok: false }, { status: 200 });
    case "error":
      // The claim did not conclude, so nothing is known and nothing was done.
      // The one genuinely retryable branch before the work starts.
      return new NextResponse(null, { status: 503 });
    case "claimed":
      break;
  }

  // ---- 4. work + 5. outcome ----------------------------------------------
  //
  // `ocr.process`'s maxDuration (120s) is doc 39's own trigger for a heartbeat
  // ("required for any worker with maxDuration > 60"): a healthy 90-second OCR
  // call is otherwise indistinguishable from a worker that died at second 3
  // until claim.ts's full 2x-maxDuration reclaim window has passed. Started
  // only now, after the claim, so its ownership predicate has the `attempts`
  // value THIS invocation actually won; stopped from `finally` so it never
  // outlives the handler - a heartbeat written after the job settles would
  // re-establish liveness for a job nobody is running, which doc 39 and the
  // brief for this task both call worse than no heartbeat at all.
  const heartbeat = startHeartbeat({ supabase, jobId, attempts: claim.job.attempts });
  try {
    const result = await runOcrProcess(payload.data, { supabase, processReceipt });

    switch (result.kind) {
      case "terminal":
        // approved | review | rejected. The pipeline decided; the job did its
        // job. A rejection is a SUCCESSFUL job with a negative domain outcome
        // (doc 39's `ocr.process` failure notes), not a failed one.
        await finishJob(supabase, jobId, { kind: "succeeded" });
        return NextResponse.json({ ok: true, status: result.status }, { status: 200 });

      case "gone":
        // A signed message for a receipt that is not there. Re-delivery cannot
        // make it exist, so 200 - but `dead`, not `succeeded`: nothing was
        // processed, and the operator should see it in the DLQ view.
        await finishJob(supabase, jobId, { kind: "dead", error: "receipt does not exist" });
        return NextResponse.json({ ok: false, dead: true }, { status: 200 });

      case "retryable":
        // queued | processing. `failed` rather than `dead` so the claim
        // predicate (`status in ('queued','failed')`) lets the next delivery
        // pick the job up; the receipt's own status is left exactly as the
        // pipeline left it, which is the state the next attempt expects.
        await finishJob(supabase, jobId, {
          kind: "failed",
          error: `receipt still '${result.status}' after the attempt`,
        });
        return new NextResponse(null, { status: 503 });

      case "unreadable":
        await finishJob(supabase, jobId, {
          kind: "failed",
          error: `could not read the receipt outcome: ${result.reason}`,
        });
        return new NextResponse(null, { status: 503 });
    }
  } catch (error) {
    // runOcrProcess is written not to throw, so this is a genuine fault.
    // Retryable, because nothing here proves another attempt would fail and
    // `processReceipt` is safe to run again by construction.
    console.error(`${LOG_PREFIX} unexpected failure running job ${jobId}`, error);
    await finishJob(supabase, jobId, { kind: "failed", error: "unexpected worker failure" });
    return new NextResponse(null, { status: 503 });
  } finally {
    // Every exit above - each `return` in the switch, and the catch above -
    // runs this first. `stop()` is idempotent and safe even if the heartbeat
    // already stopped itself after losing its lease.
    heartbeat.stop();
  }
}

/** The job id out of an unvalidated body, so a malformed payload can still be
 * recorded against its own row. Returns null rather than guessing. */
function readJobId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).job_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
