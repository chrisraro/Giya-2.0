"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveAdminContext } from "./access";
import { replayJob } from "./jobs";
import type { ReplayErrorCode } from "./jobs";
import { MAX_REASON_LENGTH } from "./presenter";

// ===========================================================================
// The `/admin/monitoring/queues` server action.
//
// THIN, same shape and same reasoning as `./actions.ts`: every guard that
// matters - the reason, the actor's live admin status, the job's existence
// and state, the write and the audit row - lives in `./jobs.ts#replayJob` and
// is tested there. This layer owns exactly three things: the session,
// resolved to an actor id the client cannot supply; a `request_id`; and
// revalidating the one path this action changes.
//
// `resolveAdminContext()` is the FIRST fence a non-admin or unauthenticated
// caller meets - it runs before `replayJob` is ever called, so a caller with
// no session or no `platform_admins` row never reaches the table-truth check
// `replayJob` performs a second time for the caller who DOES have a session
// (see that function's own header for why the second check is not redundant).
// ===========================================================================

const QUEUES_PATH = "/admin/monitoring/queues";

export type ReplayActionErrorCode = ReplayErrorCode | "NOT_ALLOWED" | "INVALID_INPUT";

export type ReplayActionResult =
  | { ok: true; message: string }
  | { ok: false; code: ReplayActionErrorCode; message: string };

const NOT_ALLOWED = "You do not have permission to take this action.";
const BAD_INPUT = "That request could not be read. Refresh and try again.";

const replaySchema = z.object({
  jobId: z.string().uuid(),
  reason: z.string().min(1).max(MAX_REASON_LENGTH),
});

export async function replayJobAction(input: unknown): Promise<ReplayActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return { ok: false, code: "NOT_ALLOWED", message: NOT_ALLOWED };

  const parsed = replaySchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT", message: BAD_INPUT };

  const outcome = await replayJob({
    jobId: parsed.data.jobId,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

  // `outcome.ok` now MEANS delivered - `replayJob` reports `REPUBLISH_FAILED`
  // rather than `ok: true` when it could not confirm delivery (this build has
  // no reconciler to pick up an undelivered `queued` row later; see
  // `jobs.ts`'s module header, review finding I3). So there is exactly one
  // success sentence, and it is never a promise this build cannot keep.
  revalidatePath(QUEUES_PATH);
  return { ok: true, message: "The job is queued and was redelivered to its worker." };
}
