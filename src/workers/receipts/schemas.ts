import { z } from "zod";

// Doc 39: "Zod-parse payload (each queue's schema in
// src/workers/{area}/schemas.ts). Malformed -> terminal failure." Same shape
// and the same reasoning as ../notify/schemas.ts: a payload that does not parse
// will not parse on the third delivery either, so the worker marks the job
// `dead` and returns 200 rather than spending the rest of the attempt budget
// learning nothing.
//
// WHY THE PAYLOAD IS ONLY AN ID. Doc 36 Stage 1 step 5 specifies
// `payload={receipt_id}` and doc 39 states the principle behind it: "payloads
// carry identifiers, never denormalized state that can go stale". This is the
// money path, so the concrete version of that rule is worth stating: a payload
// carrying `total_centavos` would be a second copy of the amount, and a retry
// three hours after a template edit would award against the stale one.
// `processReceipt` re-reads every fact it needs from `receipts` under the
// service role, which is exactly why it takes an id and nothing else.
//
// Doc 39's own registry line for this queue writes the payload as
// `{job_id, receipt_id, user_id}`. `user_id` is NOT required here: it is
// readable from the receipt row the worker loads anyway, so requiring it would
// let a publisher and a row disagree about who submitted a receipt. Zod strips
// unknown keys rather than refusing them, so a publisher that sends it anyway
// is accepted and the extra field is ignored.

/** Doc 36 Stage 1 step 5's `ocr.process` payload, plus the job id every worker
 * message carries (added by `enqueue`, not by the caller). */
export const ocrProcessPayloadSchema = z.object({
  job_id: z.string().uuid(),
  receipt_id: z.string().uuid(),
});

export type OcrProcessPayload = z.infer<typeof ocrProcessPayloadSchema>;
