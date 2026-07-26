import { NextResponse, type NextRequest } from "next/server";

import { markDeauthorized } from "@/features/integrations/meta/server/service";
import {
  SIGNATURE_HEADER,
  claimDelivery,
  extractDeauthorizedAccounts,
  verifyHandshake,
  verifyWebhookSignature,
} from "@/features/integrations/meta/server/webhook";

// =============================================================================
// /api/webhooks/meta - Meta's deauthorize callback.
// =============================================================================
//
// docs/30-modules/42-integrations.md: "Meta's deauthorize callback webhook
// marks the connection `revoked`; UI prompts reconnect", and resilience
// standard #7: "outside /api/v1 (not part of the public contract),
// signature-verified before any parsing, idempotent by provider event id
// (Redis SET NX 24h), and answer 200 fast".
//
// OUTSIDE /api/v1 DELIBERATELY. /api/v1 is a contract we offer to clients, with
// an envelope, a request id, rate limits and an idempotency header. This is an
// endpoint a third party calls with a shape they chose; putting it under the
// versioned prefix would imply we version it, which we cannot.
//
// -----------------------------------------------------------------------------
// THE ORDER, WHICH IS THE WHOLE SECURITY MODEL
// -----------------------------------------------------------------------------
//
//   1. read the RAW body, once. `request.text()`, before anything else looks
//      at it. The signature covers bytes; a parse-then-reserialize would
//      verify a different string than the one that was signed. See webhook.ts.
//   2. verify the signature. Failure -> 401, no parsing, no logging of the
//      payload, no reason in the response.
//   3. claim the delivery (SET NX 24h). Already claimed -> 200 immediately.
//   4. NOW parse the JSON. Not before: everything up to here has treated the
//      body as untrusted bytes, which is what it is.
//   5. mark the affected connections revoked, then 200.
//
// -----------------------------------------------------------------------------
// WHY THE WORK IS DONE INLINE AND NOT QUEUED
// -----------------------------------------------------------------------------
//
// Doc 42 says webhooks "answer 200 fast with work queued, never processed
// inline", and this route deliberately does the work inline. The rule exists
// so a slow handler does not cause provider retries and duplicate processing;
// the work here is a status UPDATE on at most a handful of rows, keyed by an
// indexed column, with no external call - a few milliseconds, well inside any
// webhook budget. Queueing it would add a `jobs` row, a QStash publish, a
// worker route and a failure path, and would make the revoke arrive LATER than
// the merchant's own portal refresh, which is the one thing this event is for.
//
// If this ever grows a side effect that is not a single indexed update - an
// email to the merchant, a fan-out across tenants - it moves to the queue and
// this comment becomes wrong. Doc 39's `notify.email` queue is where it goes.
//
// -----------------------------------------------------------------------------
// 200 ON EVERY PROCESSED OUTCOME
// -----------------------------------------------------------------------------
//
// Meta retries on non-2xx. A 500 is therefore a REQUEST for redelivery, not a
// report, so every branch that another delivery cannot improve answers 200 -
// including "we could not find a connection for that account", which is the
// normal case for a user-level deauthorization (see webhook.ts's recorded
// limitation). 401 is the one exception, and it is not a retry decision: an
// unsigned request is not an event.

/** Meta expects a fast answer; nothing here needs a long budget. */
export const maxDuration = 15;

/**
 * The registration handshake. Meta calls this once, when the webhook URL is
 * first saved in the app dashboard.
 *
 * `verifyHandshake` returns null unless the mode is `subscribe` AND the
 * presented token matches the configured one in constant time, so an endpoint
 * with no verify token configured echoes nothing. Echoing any challenge would
 * let anyone register OUR URL against THEIR app.
 */
export function GET(request: NextRequest): NextResponse {
  const query = request.nextUrl.searchParams;

  const challenge = verifyHandshake({
    mode: query.get("hub.mode"),
    token: query.get("hub.verify_token"),
    challenge: query.get("hub.challenge"),
  });

  if (challenge === null) {
    console.warn("[integrations/meta/webhook] handshake refused");
    return new NextResponse(null, { status: 403 });
  }

  // Echoed verbatim as plain text, which is what Meta's subscriber check reads.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- 1. the raw bytes, exactly once -------------------------------------
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  // --- 2. signature, BEFORE any parsing -----------------------------------
  const verified = verifyWebhookSignature({
    signature: request.headers.get(SIGNATURE_HEADER),
    rawBody,
  });
  if (!verified.ok) {
    // The reason stays on the server. A named rejection tells whoever is
    // probing whether the endpoint is even wired up, and tells them when their
    // forgery is failing for a reason other than the signature.
    console.warn(`[integrations/meta/webhook] rejected: ${verified.reason}`);
    return new NextResponse(null, { status: 401 });
  }

  // --- 3. idempotency ------------------------------------------------------
  const claimed = await claimDelivery(rawBody);
  if (!claimed) {
    // Either a redelivery of something already handled, or Redis is
    // unreachable and we are failing closed. Both answer 200: a redelivery is
    // done, and asking Meta to send it again would not help while the dedupe
    // store is down.
    return NextResponse.json({ received: true }, { status: 200 });
  }

  // --- 4. only now is it JSON ---------------------------------------------
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed, so it came from Meta, and yet unparseable. Redelivery will not
    // fix that, so 200 and a log line.
    console.error("[integrations/meta/webhook] a signed delivery was not JSON");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  // --- 5. the effect -------------------------------------------------------
  const accounts = extractDeauthorizedAccounts(payload);
  if (accounts.length === 0) {
    return NextResponse.json({ received: true }, { status: 200 });
  }

  try {
    const marked = await markDeauthorized(accounts);
    if (marked > 0) {
      console.info(`[integrations/meta/webhook] marked ${marked} connection(s) revoked`);
    }
  } catch (error) {
    // Never a 500: the delivery has already been claimed, so a retry would be
    // deduped anyway and the merchant is better served by refresh-on-read
    // catching the dead token than by Meta hammering this endpoint.
    console.error("[integrations/meta/webhook] could not apply a deauthorization", error);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
