import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import { reasonProblem } from "./presenter";
import type { FeatureFlagItem } from "./types";

// ===========================================================================
// `/admin/flags` (doc 31 section 7): list every `feature_flags` row and
// toggle `is_enabled`, super_admin only, every change audited.
//
// SAME FENCE AS EVERY SIBLING ADMIN MODULE. Migration 0062 gives
// `feature_flags` RLS enabled with ZERO policies (same shape as `jobs`,
// 0029), so a service-role client is the only way to read or write it - see
// that migration's header for why a client-side flag reader has no argument
// today. `resolveAdminContext()` (the page) and the table-truth actor check
// below (the write) are the fences; nothing about `feature_flags` grants one
// of its own.
//
// SUPER_ADMIN ONLY, narrower than `jobs.ts`'s `canActOnLadder` (admin +
// super_admin). Doc 31 section 1's route table is explicit: "`/admin/flags` |
// Feature flags | [V1 UI; flags exist MVP] | super_admin only". A kill switch
// is the platform's own emergency brake - the control "you want on the worst
// day", per this task's brief - and doc 01's persona matrix reserves that
// tier of platform-wide, irreversible-by-anyone-else control to the single
// role account holders are directly accountable for. `admin` can still SEE
// this screen (read-only, same "canAct" pattern as `QueueStatusScreen`); only
// `super_admin` may flip a switch.
//
// WRITE-THEN-AUDIT-ELSE-REVERT, same pattern `jobs.ts#replayJob` documents at
// length and `admin/consequences.ts` originates: writing the audit row first
// risks a false record of a toggle that never took effect, and writing the
// state change with no audit row behind it is the exact unaudited-admin-
// action doc 15 forbids. So the order here is (1) CAS the row to the target
// state, guarded on its PRIOR value so a race between two admins loses
// cleanly, (2) write ONE audit row, (3) on audit failure, UNDO step 1.
// ===========================================================================

const ENTITY_FLAG = "feature_flag";
/** doc 22's `action` shape (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`) and doc
 * 25's own example vocabulary for this table ("feature-flag flips"). */
const ACTION_FLAG_UPDATED = "flag.updated";

export interface AdminFlagsDeps {
  /** MUST be the service-role client. See the header. */
  supabase: SupabaseClient<Database>;
}

export function defaultAdminFlagsDeps(): AdminFlagsDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[admin/flags] SUPABASE_SERVICE_ROLE_KEY is not configured; the flags screen cannot read anything",
    );
    return null;
  }
  return { supabase };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

interface FlagRow {
  key: string;
  description: string;
  is_enabled: boolean;
  rollout: unknown;
  updated_at: string;
  /** Read so a failed-audit revert (review finding #7) can restore the
   * PRIOR actor, not leave the row attributed to the actor whose toggle
   * was rolled back. Not part of `FeatureFlagItem` - the screen has no use
   * for it, this is bookkeeping for the revert path alone. */
  updated_by: string | null;
}

const FLAG_COLUMNS = "key, description, is_enabled, rollout, updated_at, updated_by";

function toFlagItem(row: FlagRow): FeatureFlagItem {
  return {
    key: row.key,
    description: row.description,
    isEnabled: row.is_enabled,
    updatedAt: row.updated_at,
  };
}

/**
 * Every `feature_flags` row, key-ordered. `null` on a read failure - NOT `[]`
 * for a genuinely empty table, the same "unreadable is never a guessed zero"
 * rule `loadDeadJobs`/`loadMetrics` follow: a failed read of the platform's
 * own kill switches must not render as "nothing to show", which reads as
 * "there is nothing to turn off".
 */
export async function loadFeatureFlags(
  deps: AdminFlagsDeps | null = defaultAdminFlagsDeps(),
): Promise<FeatureFlagItem[] | null> {
  if (deps === null) return null;

  const { data, error } = await deps.supabase
    .from("feature_flags")
    .select(FLAG_COLUMNS)
    .order("key", { ascending: true });

  if (error !== null) {
    console.error("[admin/flags] flag list read failed", error);
    return null;
  }

  return ((data ?? []) as FlagRow[]).map(toFlagItem);
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export type ToggleFlagErrorCode =
  | "REASON_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NO_CHANGE"
  | "WRITE_FAILED"
  | "AUDIT_WRITE_FAILED"
  | "DEPENDENCY_UNAVAILABLE";

export interface ToggleFlagInput {
  key: string;
  /** The target state, explicit rather than "flip whatever it currently is" -
   * an admin UI renders a switch showing the CURRENT value, and the request
   * it sends is "set it to what I clicked", not "invert it", which is the
   * only shape that stays correct if two admins load the screen at once. */
  isEnabled: boolean;
  actorId: string;
  reason: string;
  requestId: string;
}

export interface ToggleFlagFailure {
  ok: false;
  code: ToggleFlagErrorCode;
  message: string;
}

export type ToggleFlagResult = { ok: true; item: FeatureFlagItem } | ToggleFlagFailure;

function fail(code: ToggleFlagErrorCode, message: string): ToggleFlagFailure {
  return { ok: false, code, message };
}

function checkReason(reason: string): { ok: true; reason: string } | { ok: false; message: string } {
  const problem = reasonProblem(reason);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, reason: reason.trim() };
}

/**
 * Guard 2, by TABLE TRUTH - identical reasoning to `jobs.ts#assertCanReplay`:
 * the layout's `resolveAdminContext()` gated the PAGE render, and however
 * long an admin spends looking at the switch before clicking it sits between
 * that and this write, so the live row is re-read rather than trusted from a
 * stale session claim.
 */
async function assertCanToggle(
  deps: AdminFlagsDeps,
  actorId: string,
): Promise<{ ok: true } | ToggleFlagFailure> {
  const { data, error } = await deps.supabase
    .from("platform_admins")
    .select("role, is_active")
    .eq("user_id", actorId)
    .eq("is_active", true)
    .maybeSingle<{ role: string; is_active: boolean }>();

  if (error !== null) {
    console.error("[admin/flags] actor verification failed", error);
    return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
  }
  if (data === null) {
    return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
  }
  if (data.role !== "super_admin") {
    return fail("FORBIDDEN", "Only a super admin can change a feature flag.");
  }
  return { ok: true };
}

/**
 * Toggle one flag's `is_enabled`, audited. See the module header for the
 * guard order and the write-then-audit-else-revert shape.
 */
export async function toggleFeatureFlag(
  input: ToggleFlagInput,
  deps: AdminFlagsDeps | null = defaultAdminFlagsDeps(),
): Promise<ToggleFlagResult> {
  if (deps === null) {
    return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");
  }

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  const actor = await assertCanToggle(deps, input.actorId);
  if (!actor.ok) return actor;

  const { data: current, error: readError } = await deps.supabase
    .from("feature_flags")
    .select(FLAG_COLUMNS)
    .eq("key", input.key)
    .maybeSingle<FlagRow>();

  if (readError !== null) {
    console.error("[admin/flags] flag read failed", readError);
    return fail("WRITE_FAILED", "That flag could not be read. Try again.");
  }
  if (current === null) return fail("NOT_FOUND", "That flag no longer exists.");

  if (current.is_enabled === input.isEnabled) {
    // Not an error - the admin's click matches the row's live state (e.g. a
    // stale render, or two tabs). Nothing to write and nothing to audit: an
    // audit row that says "flipped from X to X" would record a change that
    // never happened.
    return fail("NO_CHANGE", `This flag is already ${input.isEnabled ? "on" : "off"}.`);
  }

  // The CAS: guarded on the PRIOR value read above, so a concurrent toggle
  // between the read and this write loses cleanly rather than silently
  // clobbering whichever admin's click landed second.
  const { data: updated, error: writeError } = await deps.supabase
    .from("feature_flags")
    .update({ is_enabled: input.isEnabled, updated_by: input.actorId })
    .eq("key", input.key)
    .eq("is_enabled", current.is_enabled)
    .select(FLAG_COLUMNS)
    .maybeSingle<FlagRow>();

  if (writeError !== null) {
    console.error("[admin/flags] flag toggle write failed", writeError);
    return fail("WRITE_FAILED", "The flag could not be changed. Try again.");
  }
  if (updated === null) {
    return fail(
      "WRITE_FAILED",
      "This flag changed while you were working. Refresh and check its current state.",
    );
  }

  const { error: auditError } = await deps.supabase.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_kind: "admin",
    actor_role: "super_admin",
    business_id: null,
    action: ACTION_FLAG_UPDATED,
    entity_type: ENTITY_FLAG,
    entity_id: null, // `feature_flags.key` is text, not the uuid this column expects
    before: { key: current.key, is_enabled: current.is_enabled } as unknown as Json,
    after: { key: updated.key, is_enabled: updated.is_enabled } as unknown as Json,
    reason: reason.reason,
    request_id: input.requestId,
  });

  if (auditError !== null) {
    console.error("[admin/flags] audit write failed for flag toggle", auditError);
    await revertToggle(deps, {
      key: input.key,
      writtenIsEnabled: input.isEnabled,
      priorIsEnabled: current.is_enabled,
      priorUpdatedBy: current.updated_by,
    });
    return fail("AUDIT_WRITE_FAILED", "The flag was not changed because it could not be recorded.");
  }

  return { ok: true, item: toFlagItem(updated) };
}

/**
 * Put the row back after the audit row that was supposed to justify the
 * toggle failed to write. Best effort, loud on failure - the same UNDO
 * `jobs.ts#revertReplay` and `admin/consequences.ts#revert` perform, and for
 * the identical reason: a state change with no audit trail behind it is the
 * one outcome doc 15 forbids outright.
 *
 * Review finding #7, two fixes over the first version:
 *
 *   1. GUARDED, not unconditional. The forward write (above) carries a CAS
 *      predicate on the row's PRIOR value for exactly this reason - "a race
 *      between two admins loses cleanly" - and an unguarded revert threw
 *      that property away the moment it fired: it could clobber a THIRD
 *      admin's change made in the (however brief) window between this
 *      toggle's write and its own failed audit insert. Guarded here on
 *      `writtenIsEnabled` - the value THIS toggle wrote - so the revert
 *      only proceeds if the row still holds it. If it does not, a newer
 *      change already landed and is preserved; this function logs that
 *      distinctly rather than silently doing nothing.
 *   2. RESTORES `updated_by`, not only `is_enabled`. Without this, a row
 *      whose toggle was rolled back stayed attributed to the actor who
 *      attempted it, which is a false record in the opposite direction
 *      from the one the revert exists to prevent: the CURRENT state is
 *      correct, but who last legitimately touched it is not.
 */
async function revertToggle(
  deps: AdminFlagsDeps,
  input: {
    key: string;
    /** The value this toggle wrote - the revert's CAS guard. */
    writtenIsEnabled: boolean;
    priorIsEnabled: boolean;
    priorUpdatedBy: string | null;
  },
): Promise<void> {
  const { data: reverted, error } = await deps.supabase
    .from("feature_flags")
    .update({ is_enabled: input.priorIsEnabled, updated_by: input.priorUpdatedBy })
    .eq("key", input.key)
    .eq("is_enabled", input.writtenIsEnabled)
    .select("key")
    .maybeSingle<{ key: string }>();

  if (error !== null) {
    console.error(
      `[admin/flags] UNAUDITED CHANGE: the toggle of flag "${input.key}" could not be recorded and could not be reverted`,
      error,
    );
    return;
  }

  if (reverted === null) {
    // The CAS guard did not match: someone else already changed this row
    // again since our own (unaudited) write. Their change is newer and is
    // left standing - reverting it would destroy a DIFFERENT, unrelated
    // toggle that has nothing to do with this one's failed audit write.
    console.warn(
      `[admin/flags] the toggle of flag "${input.key}" could not be reverted: a newer change already ` +
        `landed on it. The unaudited write from this attempt is gone; the newer state is preserved.`,
    );
    return;
  }

  console.warn(`[admin/flags] the toggle of flag "${input.key}" was reverted (audit write failed)`);
}
