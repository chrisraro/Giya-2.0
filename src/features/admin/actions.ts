"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveAdminContext } from "./access";
import {
  applyCooldown,
  clawbackReceipt,
  liftCooldown,
  suspendConsumer,
  unsuspendConsumer,
} from "./consequences";
import type { ConsequenceErrorCode } from "./consequences";
import { MAX_REASON_LENGTH } from "./presenter";

// ===========================================================================
// The consequence-ladder server actions.
//
// THIN BY DESIGN, exactly like `receipts/review/actions.ts`. Every guard that
// matters - the reason, the actor's live admin status, the subject's existence,
// the state check, the write and the audit row - lives in ./consequences.ts and
// is tested there. Re-implementing any of them here would create a second copy
// that can drift from the one an admin API route will also call.
//
// What this layer owns, and only this:
//   * the session, resolved to an ACTOR ID the client cannot supply,
//   * a `request_id` for the audit row,
//   * revalidating the paths each action changes,
//   * translating typed error codes into sentences an admin can act on.
//
// Note what is absent: nothing here accepts an actor id, an actor role or a
// business id. The actor comes from `resolveAdminContext()`, and the role the
// audit row records comes from a fresh `platform_admins` read inside the
// service - so a caller cannot widen their own authority by naming it.
//
// EVERY ACTION HERE TAKES A REASON AND NONE OF THEM WILL RUN WITHOUT ONE. That
// is doc 15's control, 0022's check constraint, and the one thing about this
// file that must never be made convenient.
// ===========================================================================

const FRAUD_PATH = "/admin/fraud";
const RECEIPTS_PATH = "/admin/receipts";
const OVERVIEW_PATH = "/admin";

export type AdminActionErrorCode = ConsequenceErrorCode | "NOT_ALLOWED" | "INVALID_INPUT";

export type AdminActionResult =
  | { ok: true; message: string }
  | { ok: false; code: AdminActionErrorCode; message: string };

function fail(code: AdminActionErrorCode, message: string): AdminActionResult {
  return { ok: false, code, message };
}

const NOT_ALLOWED = "You do not have permission to take this action.";
const BAD_INPUT = "That request could not be read. Refresh and try again.";

/**
 * The reason is shape-checked here and rule-checked in the service
 * (`reasonProblem`), which is also what the client island calls before
 * submitting. Three layers sounds like two too many; it is not. This one only
 * asserts it is a string of plausible length so a hostile payload cannot reach
 * the service as a number or a 4MB blob, the service's is the rule an admin
 * sees enforced, and the database's check constraint is the one that cannot be
 * bypassed by any caller at all.
 */
const reasonSchema = z.string().min(1).max(MAX_REASON_LENGTH);
const idSchema = z.string().uuid();

const consumerActionSchema = z.object({ consumerId: idSchema, reason: reasonSchema });
const profileActionSchema = z.object({ profileId: idSchema, reason: reasonSchema });
const receiptActionSchema = z.object({ receiptId: idSchema, reason: reasonSchema });

/**
 * Every ladder action changes what at least two admin screens show: the
 * receipt it was taken from, the fraud queue it was reached through, and the
 * overview's counts.
 */
function revalidateAdmin(receiptId?: string): void {
  revalidatePath(OVERVIEW_PATH);
  revalidatePath(FRAUD_PATH);
  revalidatePath(RECEIPTS_PATH);
  if (receiptId !== undefined) revalidatePath(`${RECEIPTS_PATH}/${receiptId}`);
}

export async function applyCooldownAction(input: unknown): Promise<AdminActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return fail("NOT_ALLOWED", NOT_ALLOWED);

  const parsed = consumerActionSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_INPUT", BAD_INPUT);

  const outcome = await applyCooldown({
    consumerId: parsed.data.consumerId,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return fail(outcome.code, outcome.message);

  revalidateAdmin();
  return { ok: true, message: "Scanning is blocked for this customer for the next 24 hours." };
}

export async function liftCooldownAction(input: unknown): Promise<AdminActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return fail("NOT_ALLOWED", NOT_ALLOWED);

  const parsed = consumerActionSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_INPUT", BAD_INPUT);

  const outcome = await liftCooldown({
    consumerId: parsed.data.consumerId,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return fail(outcome.code, outcome.message);

  revalidateAdmin();
  return { ok: true, message: "This customer can scan again." };
}

export async function suspendAction(input: unknown): Promise<AdminActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return fail("NOT_ALLOWED", NOT_ALLOWED);

  const parsed = profileActionSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_INPUT", BAD_INPUT);

  const outcome = await suspendConsumer({
    profileId: parsed.data.profileId,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return fail(outcome.code, outcome.message);

  revalidateAdmin();
  return { ok: true, message: "The account is suspended platform-wide." };
}

export async function unsuspendAction(input: unknown): Promise<AdminActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return fail("NOT_ALLOWED", NOT_ALLOWED);

  const parsed = profileActionSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_INPUT", BAD_INPUT);

  const outcome = await unsuspendConsumer({
    profileId: parsed.data.profileId,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return fail(outcome.code, outcome.message);

  revalidateAdmin();
  return { ok: true, message: "The suspension is lifted." };
}

/**
 * THIS IS A MONEY ACTION. A successful call writes a negative ledger row and
 * rejects the receipt, in one transaction inside the RPC. The screen confirms
 * before calling it and shows the points at stake.
 */
export async function clawbackAction(input: unknown): Promise<AdminActionResult> {
  const admin = await resolveAdminContext();
  if (admin === null) return fail("NOT_ALLOWED", NOT_ALLOWED);

  const parsed = receiptActionSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_INPUT", BAD_INPUT);

  const outcome = await clawbackReceipt({
    receiptId: parsed.data.receiptId,
    reason: parsed.data.reason,
    actorId: admin.userId,
    requestId: randomUUID(),
  });

  if (!outcome.ok) return fail(outcome.code, outcome.message);

  revalidateAdmin(parsed.data.receiptId);

  const { clawedPoints, shortfallPoints } = outcome.detail;
  return {
    ok: true,
    message:
      shortfallPoints === 0
        ? `${clawedPoints} points reversed and the receipt is rejected.`
        : `${clawedPoints} points reversed and the receipt is rejected. ${shortfallPoints} points were already spent and could not be recovered; that shortfall is in the audit record.`,
  };
}
