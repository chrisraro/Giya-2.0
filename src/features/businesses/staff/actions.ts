"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { createClient } from "@/lib/supabase/server";

import { STAFF_ROSTER_ROLES } from "./roles";
import { changeRoleSchema, inviteSchema, staffIdSchema, tokenSchema } from "./schemas";
import * as service from "./server/service";
import type { AcceptedInvite, InvitePreview } from "./server/service";
import type { ActionResult, StaffRosterItem } from "./types";

// Session -> tenancy+role -> Zod -> service -> revalidate, same order
// src/features/customers/actions.ts and src/features/campaigns/actions.ts
// use. The business id and actor role never come from the input - they come
// from `resolveStaffContext`, so a payload cannot smuggle in a different
// tenant or claim a role the caller's own membership row does not hold.

const STAFF_PATH = "/business/staff";

const NOT_ALLOWED: ActionResult<never> = {
  ok: false,
  code: "NOT_ALLOWED",
  message: "Only an owner or manager can manage staff.",
};

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

async function requireRosterAccess(): Promise<
  | { ok: true; business: service.Business; actor: service.StaffActor }
  | { ok: false; result: ActionResult<never> }
> {
  const context = await resolveStaffContext(STAFF_ROSTER_ROLES);
  if (!context) return { ok: false, result: NOT_ALLOWED };

  return {
    ok: true,
    business: { id: context.businessId, name: context.businessName },
    actor: { userId: context.userId, role: context.role },
  };
}

export async function loadStaffRoster(): Promise<ActionResult<StaffRosterItem[]>> {
  const auth = await requireRosterAccess();
  if (!auth.ok) return auth.result;

  return service.loadRoster(auth.business.id);
}

export async function inviteStaffAction(input: unknown): Promise<ActionResult<StaffRosterItem>> {
  const auth = await requireRosterAccess();
  if (!auth.ok) return auth.result;

  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.inviteStaff(auth.business, auth.actor, parsed.data);
  if (result.ok) revalidatePath(STAFF_PATH);
  return result;
}

export async function revokeInviteAction(staffId: unknown): Promise<ActionResult<undefined>> {
  const auth = await requireRosterAccess();
  if (!auth.ok) return auth.result;

  const parsedId = staffIdSchema.safeParse(staffId);
  if (!parsedId.success) return { ok: false, message: "Invalid invite." };

  const result = await service.revokeInvite(auth.business, auth.actor, parsedId.data);
  if (result.ok) revalidatePath(STAFF_PATH);
  return result;
}

export async function changeStaffRoleAction(input: unknown): Promise<ActionResult<StaffRosterItem>> {
  const auth = await requireRosterAccess();
  if (!auth.ok) return auth.result;

  const parsed = changeRoleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.changeRole(auth.business, auth.actor, parsed.data);
  if (result.ok) revalidatePath(STAFF_PATH);
  return result;
}

/**
 * `/invite/[token]`'s read-only render. Same "not gated by
 * `resolveStaffContext`" reasoning as `acceptInviteAction` below - and unlike
 * that action, this one is safe to call from a plain page render (a GET),
 * because `service.previewInvite` never writes. See that function's header.
 */
export async function previewInviteAction(token: unknown): Promise<ActionResult<InvitePreview>> {
  const parsedToken = tokenSchema.safeParse(token);
  if (!parsedToken.success) {
    return { ok: false, code: "INVITE_INVALID", message: "This invite link is not valid." };
  }

  return service.previewInvite(parsedToken.data);
}

/**
 * `/invite/[token]` acceptance. Deliberately NOT gated by `resolveStaffContext`
 * - an invitee accepting is by definition not yet staff of this tenant, so
 * that gate would refuse the exact caller this action exists for. The only
 * identity input is whichever session (if any) is already signed in;
 * server/service.ts's `acceptInvite` is what decides whether that session may
 * complete THIS token.
 */
export async function acceptInviteAction(token: unknown): Promise<ActionResult<AcceptedInvite>> {
  const parsedToken = tokenSchema.safeParse(token);
  if (!parsedToken.success) {
    return { ok: false, code: "INVITE_INVALID", message: "This invite link is not valid." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return service.acceptInvite(parsedToken.data, user?.id ?? null);
}
