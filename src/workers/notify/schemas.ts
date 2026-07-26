import { z } from "zod";

// Doc 39: "Zod-parse payload (each queue's schema in
// src/workers/{area}/schemas.ts). Malformed -> terminal failure."
//
// Terminal, not retryable, and that is the whole reason the schema is a
// separate, pure module rather than an inline parse: a payload that does not
// parse will not parse on the fifth delivery either, so the worker marks the
// job `dead` and returns 200 instead of asking QStash to bring it back four
// more times.
//
// This body is ALREADY AUTHENTICATED by the time it is parsed - the signature
// covers a hash of these exact bytes (src/lib/queue/verify.ts) - so the schema
// is not a security boundary. It is a compatibility boundary: it is what stops
// a deploy that changed a payload shape from feeding the new worker the old
// message.

/** Doc 39's `notify.email` payload: `{job_id, notification_ids: uuid[] (<=500)}`. */
export const notifyEmailPayloadSchema = z.object({
  job_id: z.string().uuid(),
  // The cap is doc 39's fan-out batch size (F4: 500 notifications per job), and
  // it is enforced here rather than only at the publisher because the worker is
  // where the cost lands: 500 sends is already the most that fits in the
  // queue's 60s budget, and a batch of 5,000 would time out halfway and be
  // re-delivered to time out halfway again.
  //
  // The floor is 1. An empty batch is not a harmless no-op, it is a publisher
  // bug, and treating it as success would hide the fan-out that produced
  // nothing.
  notification_ids: z.array(z.string().uuid()).min(1).max(500),
});

export type NotifyEmailPayload = z.infer<typeof notifyEmailPayloadSchema>;
