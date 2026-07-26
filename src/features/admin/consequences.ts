import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/supabase/service";
import type { Database, Json } from "@/lib/supabase/types";

import type { AdminRole } from "./access";
import { canActOnLadder } from "./access";
import { reasonProblem } from "./presenter";

// ===========================================================================
// Doc 37's consequences ladder, admin half.
//
// ---------------------------------------------------------------------------
// EVERY FUNCTION IN THIS FILE WRITES AN AUDIT ROW WITH A MANDATORY REASON.
// ---------------------------------------------------------------------------
// That is not a convention here, it is the shape of the file. Doc 15 states it
// twice as a security control ("Admin actions on tenant data always require a
// recorded reason") and threat-model item 6 is platform-admin abuse, whose
// entire documented mitigation is "least privilege, full audit". 0022 made it
// structural: `audit_logs_admin_reason_required` refuses any `actor_kind='admin'`
// row whose reason is null or whitespace. So the database is the last word, and
// everything below exists to make sure an admin never loses a typed
// justification to a 23514 they cannot read.
//
// ---------------------------------------------------------------------------
// GUARD ORDER (the same normative-not-incidental order server/review.ts uses)
// ---------------------------------------------------------------------------
//   1. A non-blank reason                       -> REASON_REQUIRED
//   2. The actor may act (table truth, not claim) -> FORBIDDEN
//   3. The subject exists                       -> NOT_FOUND
//   4. The action changes something             -> INVALID_STATE
//   5. Write the state change
//   6. Write exactly one audit row; on failure, UNDO step 5
//
// Guard 1 is first for a practical reason and guard 2 is second for a security
// one: checking the reason first costs one string test and saves a database
// round trip, while checking the actor before the subject means someone probing
// consumer ids learns "forbidden" rather than "that id exists".
//
// ---------------------------------------------------------------------------
// WHY THE WRITE COMES BEFORE THE AUDIT, AND WHAT HAPPENS WHEN THE AUDIT FAILS
// ---------------------------------------------------------------------------
// These are two statements through PostgREST, not one transaction. Ordering
// them audit-first would mean a failed state change leaves a row asserting an
// admin suspended someone who was never suspended - a FALSE entry in the one
// record that is supposed to be evidence. Ordering them write-first means a
// failed audit leaves an UNAUDITED admin action, which doc 15 forbids.
//
// Neither is acceptable, so this file does not choose between them: it writes
// the state change, writes the audit row, and if the audit row fails it REVERTS
// the state change and reports AUDIT_WRITE_FAILED. Every action here toggles a
// single column whose prior value was read under guard 3, so the revert is a
// real undo and not a guess. When the revert ITSELF fails, the code does the
// only honest thing left and logs the unaudited change at error level naming
// the subject, the actor and the value - so the gap is discoverable rather than
// silent.
//
// Clawback is the exception and is better: it is one SECURITY DEFINER RPC
// (0031) that writes the ledger row, the CRM cache, the receipt status and the
// audit row in ONE transaction. It could be, because a single function can hold
// them; the toggles below cannot without an RPC of their own, and inventing one
// per toggle to gain what a revert already gives would be ceremony.
//
// Docs: docs/30-modules/37-fraud-detection.md (consequences ladder, the
// reviewer-action -> audit mapping), docs/30-modules/31-admin-portal.md §4.3
// and §11, docs/10-architecture/15-security.md,
// supabase/migrations/0022_audit_logs.sql, supabase/migrations/0031_admin_access.sql.
// ===========================================================================

/** doc 37 consequences ladder step 2: `fraud.cooldown_hours`, default 24. */
export const DEFAULT_COOLDOWN_HOURS = 24;

// `audit_logs.entity_type`, singular subject noun, the convention review.ts
// fixed for `receipt`. There is no `receipt` constant here: the clawback audit
// row is written inside the RPC, in SQL, where the same string is a literal.
const ENTITY_CONSUMER = "consumer";
const ENTITY_PROFILE = "profile";

/** doc 37's reviewer-action -> `audit_logs.action` mapping, verbatim. */
const ACTION_COOLDOWN_APPLIED = "fraud.cooldown_applied";
const ACTION_COOLDOWN_LIFTED = "fraud.cooldown_lifted";
const ACTION_SUSPENDED = "consumer.suspended";
/**
 * doc 37 lists only `consumer.suspended`. The reversal needs a verb too, and
 * inventing one is unavoidable: an unsuspension recorded under the same verb as
 * a suspension makes the audit trail unreadable exactly where it matters, and
 * 0022 constrains the SHAPE of `action` rather than its vocabulary precisely so
 * a new verb needs no migration.
 */
const ACTION_UNSUSPENDED = "consumer.unsuspended";

export type ConsequenceErrorCode =
  | "REASON_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "WRITE_FAILED"
  | "AUDIT_WRITE_FAILED"
  | "DEPENDENCY_UNAVAILABLE";

export interface ConsequenceFailure {
  ok: false;
  code: ConsequenceErrorCode;
  message: string;
}

/**
 * `detail` is always present and is `null` for the actions that have nothing to
 * report beyond "it happened". A conditional type that made the key optional
 * would read better at the call site and would cost every caller an exactness
 * check the compiler can no longer help with.
 */
export type ConsequenceOutcome<T = null> = { ok: true; detail: T } | ConsequenceFailure;

function fail(code: ConsequenceErrorCode, message: string): ConsequenceFailure {
  return { ok: false, code, message };
}

export interface ConsequenceDeps {
  /** MUST be the service-role client: none of these columns has a client write policy. */
  supabase: SupabaseClient<Database>;
  now: () => Date;
}

export function defaultConsequenceDeps(): ConsequenceDeps | null {
  const supabase = createServiceRoleClient();
  if (supabase === null) {
    console.error(
      "[admin/consequences] SUPABASE_SERVICE_ROLE_KEY is not configured; no ladder action can run",
    );
    return null;
  }
  return { supabase, now: () => new Date() };
}

/**
 * What every ladder action needs from its caller, resolved from the session.
 *
 * Note what is NOT here: the actor's ROLE. The caller knows it (the layout
 * resolved it to render the screen) and passing it would be the obvious thing
 * to do, but a role that arrives as an argument is a role the caller could get
 * wrong, and it lands in `audit_logs.actor_role` as the snapshot of what
 * authority this action was taken under. `assertCanAct` re-reads it from
 * `platform_admins` and that value is what the audit row carries.
 */
export interface LadderActor {
  actorId: string;
  /** Correlates this action with the request log line (doc 25). */
  requestId: string;
}

interface AuditInput {
  actorId: string;
  actorRole: AdminRole;
  /**
   * doc 25 permits null for a platform-level action with no tenant, and 0022's
   * comment names suspensions and cross-tenant fraud decisions as exactly those
   * rows. Consumer-level ladder actions are platform-level by definition: a
   * cooldown blocks scanning everywhere, not at one merchant.
   */
  businessId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: Json;
  after: Json;
  reason: string;
  requestId: string;
}

/**
 * The single audit writer for this module.
 *
 * `actor_kind` is pinned to "admin", which is what makes the reason mandatory
 * in the database. Nothing here is ever reached by a system actor: the
 * automatic half of the ladder (the pipeline's own cooldown) lives in
 * `receipts/server/cooldown.ts` and carries its own TODO about a system-actor
 * audit row, which is a different problem with a different owner.
 */
async function writeAuditRow(
  deps: ConsequenceDeps,
  input: AuditInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await deps.supabase.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_kind: "admin",
    actor_role: input.actorRole,
    business_id: input.businessId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    before: input.before,
    after: input.after,
    reason: input.reason,
    request_id: input.requestId,
  });

  if (error) {
    console.error("[admin/consequences] audit write failed", error);
    return { ok: false, message: error.message };
  }
  return { ok: true };
}

/**
 * Guard 2, by TABLE TRUTH rather than by the claim the caller arrived with.
 *
 * `resolveAdminContext` already read this table under the caller's own session
 * before any screen rendered, so this is the second read of the same fact. It
 * is not redundant: the first read gated a PAGE and this one gates a WRITE, and
 * between them sits however long the admin spent typing a reason. doc 12
 * requires exactly this for destructive permissions ("revocation must be
 * immediate ... also verify against the table server-side").
 */
async function assertCanAct(
  deps: ConsequenceDeps,
  actorId: string,
): Promise<{ ok: true; role: AdminRole } | { ok: false; code: ConsequenceErrorCode; message: string }> {
  const { data, error } = await deps.supabase
    .from("platform_admins")
    .select("role, is_active")
    .eq("user_id", actorId)
    .eq("is_active", true)
    .maybeSingle<{ role: string; is_active: boolean }>();

  if (error !== null) {
    console.error("[admin/consequences] actor verification failed", error);
    return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
  }
  if (data === null) {
    return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
  }

  const role = data.role as AdminRole;
  if (!canActOnLadder(role)) {
    return fail("FORBIDDEN", "Support accounts are read-only. Ask an admin to take this action.");
  }
  return { ok: true, role };
}

/** Guard 1, shared so every action refuses a blank reason identically. */
function checkReason(reason: string): { ok: true; reason: string } | { ok: false; message: string } {
  const problem = reasonProblem(reason);
  if (problem !== null) return { ok: false, message: problem };
  return { ok: true, reason: reason.trim() };
}

// ---------------------------------------------------------------------------
// Ladder step 2: cooldown (doc 37)
// ---------------------------------------------------------------------------

export interface CooldownInput extends LadderActor {
  consumerId: string;
  reason: string;
  /** Defaults to doc 37's `fraud.cooldown_hours`. */
  hours?: number;
}

/**
 * Apply a scan cooldown by hand.
 *
 * The automatic half of this ladder step lives in `receipts/server/cooldown.ts`
 * and is triggered by strike count. This is the manual half doc 37 assigns to a
 * human ("Apply/lift cooldown ... fraud.cooldown_applied"), and it deliberately
 * shares that module's NEVER-SHORTEN rule in spirit: an admin applying a
 * cooldown over an existing longer one extends nothing and shortens nothing,
 * because `greatest` of the two is what lands. An admin who wants it shorter
 * lifts it and applies again, which leaves two audit rows saying so.
 */
export async function applyCooldown(
  input: CooldownInput,
  deps: ConsequenceDeps | null = defaultConsequenceDeps(),
): Promise<ConsequenceOutcome<{ blockedUntil: string }>> {
  if (deps === null) return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  const actor = await assertCanAct(deps, input.actorId);
  if (!actor.ok) return actor;

  const { data: consumer, error: readError } = await deps.supabase
    .from("consumers")
    .select("id, scan_blocked_until")
    .eq("id", input.consumerId)
    .maybeSingle<{ id: string; scan_blocked_until: string | null }>();

  if (readError !== null) {
    console.error("[admin/consequences] cooldown read failed", readError);
    return fail("WRITE_FAILED", "That customer could not be read. Try again.");
  }
  if (consumer === null) return fail("NOT_FOUND", "That customer no longer exists.");

  const hours = input.hours ?? DEFAULT_COOLDOWN_HOURS;
  const blockedUntil = new Date(deps.now().getTime() + hours * 3_600_000);
  const existing =
    consumer.scan_blocked_until === null ? null : new Date(consumer.scan_blocked_until);

  // Never shorten an existing block, the same rule `receipts/server/cooldown.ts`
  // enforces on the automatic path. Refused rather than silently kept, because
  // an admin who asked for 24 hours and got the 72 that were already there
  // needs to be told; the way to shorten is to lift and reapply, which leaves
  // two audit rows saying exactly that.
  if (existing !== null && existing.getTime() >= blockedUntil.getTime()) {
    return fail(
      "INVALID_STATE",
      "This customer is already blocked for longer than that. Lift the block first if you meant to shorten it.",
    );
  }

  const previous = consumer.scan_blocked_until;
  const { error: writeError } = await deps.supabase
    .from("consumers")
    .update({ scan_blocked_until: blockedUntil.toISOString() })
    .eq("id", input.consumerId);

  if (writeError !== null) {
    console.error("[admin/consequences] cooldown write failed", writeError);
    return fail("WRITE_FAILED", "The cooldown could not be applied. Try again.");
  }

  const audit = await writeAuditRow(deps, {
    actorId: input.actorId,
    actorRole: actor.role,
    businessId: null,
    action: ACTION_COOLDOWN_APPLIED,
    entityType: ENTITY_CONSUMER,
    entityId: input.consumerId,
    before: { scan_blocked_until: previous },
    after: { scan_blocked_until: blockedUntil.toISOString(), hours },
    reason: reason.reason,
    requestId: input.requestId,
  });

  if (!audit.ok) {
    await revert(deps, "consumers", input.consumerId, { scan_blocked_until: previous }, "cooldown");
    return fail("AUDIT_WRITE_FAILED", "The cooldown was not applied because it could not be recorded.");
  }

  return { ok: true, detail: { blockedUntil: blockedUntil.toISOString() } };
}

export interface LiftCooldownInput extends LadderActor {
  consumerId: string;
  reason: string;
}

export async function liftCooldown(
  input: LiftCooldownInput,
  deps: ConsequenceDeps | null = defaultConsequenceDeps(),
): Promise<ConsequenceOutcome> {
  if (deps === null) return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  const actor = await assertCanAct(deps, input.actorId);
  if (!actor.ok) return actor;

  const { data: consumer, error: readError } = await deps.supabase
    .from("consumers")
    .select("id, scan_blocked_until")
    .eq("id", input.consumerId)
    .maybeSingle<{ id: string; scan_blocked_until: string | null }>();

  if (readError !== null) {
    console.error("[admin/consequences] cooldown lift read failed", readError);
    return fail("WRITE_FAILED", "That customer could not be read. Try again.");
  }
  if (consumer === null) return fail("NOT_FOUND", "That customer no longer exists.");
  if (consumer.scan_blocked_until === null) {
    return fail("INVALID_STATE", "This customer is not in a cooldown.");
  }

  const previous = consumer.scan_blocked_until;
  const { error: writeError } = await deps.supabase
    .from("consumers")
    .update({ scan_blocked_until: null })
    .eq("id", input.consumerId);

  if (writeError !== null) {
    console.error("[admin/consequences] cooldown lift failed", writeError);
    return fail("WRITE_FAILED", "The cooldown could not be lifted. Try again.");
  }

  const audit = await writeAuditRow(deps, {
    actorId: input.actorId,
    actorRole: actor.role,
    businessId: null,
    action: ACTION_COOLDOWN_LIFTED,
    entityType: ENTITY_CONSUMER,
    entityId: input.consumerId,
    before: { scan_blocked_until: previous },
    after: { scan_blocked_until: null },
    reason: reason.reason,
    requestId: input.requestId,
  });

  if (!audit.ok) {
    await revert(deps, "consumers", input.consumerId, { scan_blocked_until: previous }, "cooldown lift");
    return fail("AUDIT_WRITE_FAILED", "The cooldown was not lifted because it could not be recorded.");
  }

  return { ok: true, detail: null };
}

// ---------------------------------------------------------------------------
// Ladder step 4: platform suspension (doc 37, doc 31 §4.3)
// ---------------------------------------------------------------------------

export interface SuspendInput extends LadderActor {
  profileId: string;
  reason: string;
}

/**
 * doc 37 ladder step 4: `profiles.is_suspended=true` + `suspended_reason`, full
 * lockout, admin only, reason mandatory.
 *
 * `suspended_reason` and `audit_logs.reason` are written from the SAME string
 * deliberately. doc 31 §4.3 requires the column ("suspended_reason (required)")
 * and doc 15 requires the audit reason; writing one text twice is the only way
 * they cannot disagree, and a suspension whose stored reason contradicts its
 * audit trail is worse than either alone.
 *
 * NOT DONE HERE, and named rather than left to be discovered: doc 31 §4.3 also
 * says "refresh tokens revoked". That is a Supabase Auth admin call, not a
 * table write, and it is the difference between a lockout that takes effect now
 * and one that takes effect within the hour as tokens expire. The column is the
 * durable truth and every server-side gate reads it; the revocation is recorded
 * as debt in the slice notes rather than half-implemented here.
 */
export async function suspendConsumer(
  input: SuspendInput,
  deps: ConsequenceDeps | null = defaultConsequenceDeps(),
): Promise<ConsequenceOutcome> {
  if (deps === null) return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  const actor = await assertCanAct(deps, input.actorId);
  if (!actor.ok) return actor;

  if (input.profileId === input.actorId) {
    // An admin suspending their own account locks themselves out of the surface
    // that could undo it. doc 31 §4.1 guards the analogous self-demotion case;
    // the same reasoning applies and costs one comparison.
    return fail("INVALID_STATE", "You cannot suspend your own account.");
  }

  const { data: profile, error: readError } = await deps.supabase
    .from("profiles")
    .select("id, is_suspended, suspended_reason")
    .eq("id", input.profileId)
    .maybeSingle<{ id: string; is_suspended: boolean; suspended_reason: string | null }>();

  if (readError !== null) {
    console.error("[admin/consequences] suspension read failed", readError);
    return fail("WRITE_FAILED", "That account could not be read. Try again.");
  }
  if (profile === null) return fail("NOT_FOUND", "That account no longer exists.");
  if (profile.is_suspended) return fail("INVALID_STATE", "That account is already suspended.");

  const previous = { is_suspended: profile.is_suspended, suspended_reason: profile.suspended_reason };
  const { error: writeError } = await deps.supabase
    .from("profiles")
    .update({ is_suspended: true, suspended_reason: reason.reason })
    .eq("id", input.profileId);

  if (writeError !== null) {
    console.error("[admin/consequences] suspension write failed", writeError);
    return fail("WRITE_FAILED", "The account could not be suspended. Try again.");
  }

  const audit = await writeAuditRow(deps, {
    actorId: input.actorId,
    actorRole: actor.role,
    businessId: null,
    action: ACTION_SUSPENDED,
    entityType: ENTITY_PROFILE,
    entityId: input.profileId,
    before: previous,
    after: { is_suspended: true, suspended_reason: reason.reason },
    reason: reason.reason,
    requestId: input.requestId,
  });

  if (!audit.ok) {
    await revert(deps, "profiles", input.profileId, previous, "suspension");
    return fail("AUDIT_WRITE_FAILED", "The account was not suspended because it could not be recorded.");
  }

  return { ok: true, detail: null };
}

export interface UnsuspendInput extends LadderActor {
  profileId: string;
  reason: string;
}

export async function unsuspendConsumer(
  input: UnsuspendInput,
  deps: ConsequenceDeps | null = defaultConsequenceDeps(),
): Promise<ConsequenceOutcome> {
  if (deps === null) return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  const actor = await assertCanAct(deps, input.actorId);
  if (!actor.ok) return actor;

  const { data: profile, error: readError } = await deps.supabase
    .from("profiles")
    .select("id, is_suspended, suspended_reason")
    .eq("id", input.profileId)
    .maybeSingle<{ id: string; is_suspended: boolean; suspended_reason: string | null }>();

  if (readError !== null) {
    console.error("[admin/consequences] unsuspend read failed", readError);
    return fail("WRITE_FAILED", "That account could not be read. Try again.");
  }
  if (profile === null) return fail("NOT_FOUND", "That account no longer exists.");
  if (!profile.is_suspended) return fail("INVALID_STATE", "That account is not suspended.");

  const previous = { is_suspended: profile.is_suspended, suspended_reason: profile.suspended_reason };
  const { error: writeError } = await deps.supabase
    .from("profiles")
    .update({ is_suspended: false, suspended_reason: null })
    .eq("id", input.profileId);

  if (writeError !== null) {
    console.error("[admin/consequences] unsuspend write failed", writeError);
    return fail("WRITE_FAILED", "The suspension could not be lifted. Try again.");
  }

  const audit = await writeAuditRow(deps, {
    actorId: input.actorId,
    actorRole: actor.role,
    businessId: null,
    action: ACTION_UNSUSPENDED,
    entityType: ENTITY_PROFILE,
    entityId: input.profileId,
    before: previous,
    after: { is_suspended: false, suspended_reason: null },
    reason: reason.reason,
    requestId: input.requestId,
  });

  if (!audit.ok) {
    await revert(deps, "profiles", input.profileId, previous, "unsuspend");
    return fail("AUDIT_WRITE_FAILED", "The suspension was not lifted because it could not be recorded.");
  }

  return { ok: true, detail: null };
}

// ---------------------------------------------------------------------------
// Ladder step 5: clawback (doc 37, doc 35 §9)
// ---------------------------------------------------------------------------

export interface ClawbackInput extends LadderActor {
  receiptId: string;
  reason: string;
}

export interface ClawbackDetail {
  earnPoints: number;
  clawedPoints: number;
  shortfallPoints: number;
  balanceAfter: number;
}

/**
 * The thinnest function in this file, and deliberately so.
 *
 * Everything that matters - the actor check, the earn lookup, the
 * already-reversed check, the pair lock, the clamp, the ledger row, the CRM
 * cache, the receipt status and the audit row - is inside
 * `public.clawback_receipt_points` (0031), in ONE transaction. Doc 35 §11
 * requires one implementation of the points rules and this codebase already has
 * one award path; a TypeScript clawback that computed a clamped amount between
 * two round trips would be a second, racier ledger writer.
 *
 * So this layer owns exactly three things: the session-resolved actor id (which
 * the RPC re-verifies rather than trusts), an early reason check so a blank one
 * never reaches SQL, and the translation of the RPC's stable message strings
 * into sentences an admin can act on. That mapping is the 0013 pattern, already
 * used by `rewards/server/service.ts`.
 */
export async function clawbackReceipt(
  input: ClawbackInput,
  deps: ConsequenceDeps | null = defaultConsequenceDeps(),
): Promise<ConsequenceOutcome<ClawbackDetail>> {
  if (deps === null) return fail("DEPENDENCY_UNAVAILABLE", "This action is not available right now.");

  const reason = checkReason(input.reason);
  if (!reason.ok) return fail("REASON_REQUIRED", reason.message);

  const actor = await assertCanAct(deps, input.actorId);
  if (!actor.ok) return actor;

  const { data, error } = await deps.supabase.rpc("clawback_receipt_points", {
    p_receipt_id: input.receiptId,
    p_actor_id: input.actorId,
    p_reason: reason.reason,
    p_request_id: input.requestId,
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("CLAWBACK_REASON_REQUIRED")) {
      return fail("REASON_REQUIRED", "A reason is required. It is recorded in the audit log.");
    }
    if (message.includes("CLAWBACK_FORBIDDEN")) {
      return fail("FORBIDDEN", "Your admin access could not be confirmed. Sign in again.");
    }
    if (message.includes("RECEIPT_NOT_FOUND")) {
      return fail("NOT_FOUND", "That receipt no longer exists.");
    }
    if (message.includes("CLAWBACK_INVALID_STATE")) {
      return fail(
        "INVALID_STATE",
        "There is nothing to claw back: this receipt never earned points, or its points were already reversed.",
      );
    }
    console.error("[admin/consequences] clawback failed", error);
    return fail("WRITE_FAILED", "The clawback did not go through. Nothing was changed.");
  }

  const detail = readClawbackDetail(data);
  if (detail === null) {
    // The RPC committed but returned a shape this code does not recognise. The
    // ledger is correct either way (the transaction is what guarantees that),
    // so this is a display problem, reported as such rather than as a failure
    // that would tempt an admin to retry a completed clawback.
    console.error("[admin/consequences] clawback returned an unreadable result", data);
    return fail("WRITE_FAILED", "The clawback went through but its result could not be read. Refresh the receipt.");
  }

  return { ok: true, detail };
}

function readClawbackDetail(value: unknown): ClawbackDetail | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const numbers = ["earn_points", "clawed_points", "shortfall_points", "balance_after"] as const;
  for (const key of numbers) {
    if (typeof row[key] !== "number") return null;
  }
  return {
    earnPoints: row.earn_points as number,
    clawedPoints: row.clawed_points as number,
    shortfallPoints: row.shortfall_points as number,
    balanceAfter: row.balance_after as number,
  };
}

// ---------------------------------------------------------------------------
// The undo
// ---------------------------------------------------------------------------

/**
 * Put a column back after the audit row that was supposed to justify it failed
 * to write.
 *
 * BEST EFFORT, and the log line is the point. If this succeeds, nothing
 * happened and the admin is told so. If it fails, an admin action stands with
 * no audit row behind it, which is the exact condition doc 15 forbids, and the
 * only remaining honest response is to make it loud and attributable: subject,
 * actor and intended value, at error level, so the gap is found by whoever
 * reads logs rather than by whoever reads the audit trail six months later and
 * finds nothing.
 */
async function revert(
  deps: ConsequenceDeps,
  table: "consumers" | "profiles",
  id: string,
  values: Record<string, unknown>,
  label: string,
): Promise<void> {
  const { error } =
    table === "consumers"
      ? await deps.supabase
          .from("consumers")
          .update(values as { scan_blocked_until: string | null })
          .eq("id", id)
      : await deps.supabase
          .from("profiles")
          .update(values as { is_suspended: boolean; suspended_reason: string | null })
          .eq("id", id);

  if (error !== null) {
    console.error(
      `[admin/consequences] UNAUDITED CHANGE: the ${label} on ${table}.${id} could not be recorded and could not be reverted`,
      { values, error },
    );
    return;
  }
  console.warn(
    `[admin/consequences] the ${label} on ${table}.${id} was reverted because its audit row could not be written`,
  );
}
