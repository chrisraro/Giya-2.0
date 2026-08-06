import { NextResponse, type NextRequest } from "next/server";

import { claimJob, finishJob } from "@/lib/queue/claim";
import { queuePath } from "@/lib/queue/queues";
import { verifyQStashRequest } from "@/lib/queue/verify";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runNotifyEmail } from "@/workers/notify/email";
import { notifyEmailPayloadSchema } from "@/workers/notify/schemas";

// =============================================================================
// POST /api/jobs/notify.email - the `notify.email` worker route.
// =============================================================================
//
// docs/30-modules/39-background-jobs.md, "Worker invocation contract". The five
// steps are in the order the document gives, and the order is the security
// property: nothing at all happens before the signature is verified.
//
//   1. verify the signature      -> 401, no processing, no log of the payload
//   2. Zod-parse the payload     -> terminal (the job is marked dead), 200
//   3. claim the job row         -> 200 on every duplicate/terminal branch
//   4. do the work
//   5. record the outcome, then answer 200 (done) or 5xx (retry)
//
// -----------------------------------------------------------------------------
// WHY THIS ROUTE DOES NOT USE defineHandler
// -----------------------------------------------------------------------------
// src/lib/api/handler.ts is the shared composition for /api/v1, and every route
// under it should use it. This one must not, for three reasons that are all the
// same reason:
//
//   * It runs work before we would get control. Its step 2 constructs a
//     Supabase client and calls `auth.getUser()` on every request, which is a
//     network round trip to the auth server. Doc 39's step 1 is "verify the
//     signature; failure -> 401, NO PROCESSING", and an unauthenticated round
//     trip on behalf of whoever knocked is processing. It is also a free
//     amplification primitive pointed at our own auth server.
//   * Its contract is the wrong one. It answers doc 13's envelope
//     (`{data, meta}` / `{error: {code, message, request_id}}`) to a caller
//     that is not a client and reads only the status code - and the error half
//     of that envelope is a NAMED REASON, which is precisely what
//     verify.ts's rule 4 says must never reach this caller.
//   * Its session/rate-limit/idempotency machinery has nothing to apply to. A
//     worker request has no session, its rate limiting is QStash's flow control
//     (doc 39's per-tenant keys), and its idempotency is the job claim - a
//     stronger guarantee than an Idempotency-Key header, because it survives the
//     client not sending one.
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
// that are plainly bad news (a payload that will never parse, a job row that
// does not exist). Answering 500 to those would spend four more deliveries to
// learn the same thing and then fill the DLQ with noise.
//
// 401 is the one exception and it is not a retry decision at all: an unsigned
// request is not a job.

/**
 * Doc 39's timeout budget table: `notify.push`, `notify.email` and
 * `images.process` get 60s.
 *
 * A literal, not `QUEUE_REGISTRY[QUEUE].maxDurationSeconds`, because Next reads
 * this export statically at build time and a computed value is silently
 * ignored - which would leave the route on the platform default while the code
 * looked like it had set it. The registry carries the same number and
 * the route.test.ts beside this file asserts the two agree, which is the only way to
 * keep a literal honest without a build step.
 *
 * A route file may only export names Next recognises, so nothing else here is
 * exported: the test reaches the registry directly.
 */
export const maxDuration = 60;

/** The queue this route serves. One route, one queue - doc 39's registry is a
 * list of endpoints, not a dispatcher. */
const QUEUE = "notify.email" as const;

const LOG_PREFIX = "[api/jobs/notify.email]";

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
    // No service-role key, so the job row cannot be claimed or finished.
    // RETRYABLE, unlike most missing-credential paths in this codebase: the
    // work has not been done and the row is untouched, so a later delivery
    // against a configured deployment does exactly the right thing.
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

  const payload = notifyEmailPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    // Doc 39's taxonomy: a Zod failure is TERMINAL. The fifth delivery carries
    // the same bytes. If the id is readable the row is marked dead so the
    // operator sees it in the DLQ view rather than losing it entirely.
    const jobId = readJobId(parsedBody);
    console.error(
      `${LOG_PREFIX} payload does not match the schema for job ${jobId ?? "(unreadable)"}`,
    );
    if (jobId !== null) {
      // No claim was made - this invocation never reached step 3 - so there
      // is no lease to guard on. `attempts: null` is finishJob's explicit
      // escape hatch for exactly that; see its doc comment.
      await finishJob(supabase, jobId, null, { kind: "dead", error: "payload failed schema validation" });
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
  try {
    const result = await runNotifyEmail(payload.data, { supabase });

    if (result.failedRetryable > 0) {
      // Some rows are still pending. `failed` rather than `dead` so the claim
      // predicate (`status in ('queued','failed')`) lets the next delivery pick
      // the job up, and the rows that already sent stay 'sent' so it will not
      // re-send them.
      await finishJob(supabase, jobId, claim.job.attempts, {
        kind: "failed",
        error: `${result.failedRetryable} of ${payload.data.notification_ids.length} sends failed and can be retried`,
      });
      return new NextResponse(null, { status: 503 });
    }

    await finishJob(supabase, jobId, claim.job.attempts, { kind: "succeeded" });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    // runNotifyEmail is written not to throw, so this is a genuine fault.
    // Retryable, because nothing here proves another attempt would fail: the
    // per-row `status='pending'` gate makes a retry safe even if some of the
    // batch already went out.
    console.error(`${LOG_PREFIX} unexpected failure running job ${jobId}`, error);
    await finishJob(supabase, jobId, claim.job.attempts, { kind: "failed", error: "unexpected worker failure" });
    return new NextResponse(null, { status: 503 });
  }
}

/** The job id out of an unvalidated body, so a malformed payload can still be
 * recorded against its own row. Returns null rather than guessing. */
function readJobId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).job_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
