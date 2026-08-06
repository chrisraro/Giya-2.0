"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveAdminContext } from "./access";
import { toggleFeatureFlag } from "./flags";
import type { ToggleFlagErrorCode } from "./flags";
import { MAX_REASON_LENGTH } from "./presenter";

// ===========================================================================
// The `/admin/flags` server action.
//
// THIN, same shape and same reasoning as `./queue-status-actions.ts`: every
// guard that matters - the reason, the actor's live super_admin status, the
// flag's existence and its current state, the write and the audit row -
// lives in `./flags.ts#toggleFeatureFlag` and is tested there. This layer
// owns exactly three things: the session, resolved to an actor id the client
// cannot supply; a `request_id`; and revalidating the one path this action
// changes.
//
// `resolveAdminContext()` is the FIRST fence a non-admin or unauthenticated
// caller meets - it runs before `toggleFeatureFlag` is ever called, so a
// caller with no session or no `platform_admins` row never reaches the
// table-truth check `toggleFeatureFlag` performs a second time (see that
// function's own header for why the second check is not redundant).
// ===========================================================================

const FLAGS_PATH = "/admin/flags";

export type ToggleFlagActionErrorCode = ToggleFlagErrorCode | "NOT_ALLOWED" | "INVALID_INPUT";

export type ToggleFlagActionResult =
  | { ok: true; message: string }
  | { ok: false; code: ToggleFlagActionErrorCode; message: string };

const NOT_ALLOWED = "You do not have permission to take this action.";
const BAD_INPUT = "That request could not be read. Refresh and try again.";

const toggleSchema = z.object({
  key: z.string().min(1),
  isEnabled: z.boolean(),
  reason: z.string().min(1).max(MAX_REASON_LENGTH),
});

export async function toggleFeatureFlagAction(input: unknown): Promise<ToggleFlagActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return { ok: false, code: "NOT_ALLOWED", message: NOT_ALLOWED };

  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT", message: BAD_INPUT };

  const outcome = await toggleFeatureFlag({
    key: parsed.data.key,
    isEnabled: parsed.data.isEnabled,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

  revalidatePath(FLAGS_PATH);
  return {
    ok: true,
    message: `${parsed.data.key} is now ${parsed.data.isEnabled ? "on" : "off"}.`,
  };
}
