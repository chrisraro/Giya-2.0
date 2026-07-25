"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";

import { CUSTOMER_WRITE_ROLES } from "./roles";
import { changeSegmentSchema, updateNotesSchema } from "./schemas";
import * as service from "./server/service";
import type { ActionResult, CustomerListItem } from "./types";

// Session -> tenancy+role -> Zod -> service -> revalidate, the same order
// src/features/campaigns/actions.ts uses. The business id is never taken from
// the input; it comes from `resolveStaffContext`.

const CUSTOMERS_PATH = "/business/customers";

const NOT_ALLOWED: ActionResult<never> = {
  ok: false,
  message: "Only an owner or manager can change a customer's standing.",
};

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

async function requireWriter(): Promise<
  | { ok: true; businessId: string; actor: service.SegmentActor }
  | { ok: false; result: ActionResult<never> }
> {
  const context = await resolveStaffContext(CUSTOMER_WRITE_ROLES);
  if (!context) return { ok: false, result: NOT_ALLOWED };

  return {
    ok: true,
    businessId: context.businessId,
    actor: { userId: context.userId, role: context.role },
  };
}

export async function changeCustomerSegment(
  input: unknown,
): Promise<ActionResult<CustomerListItem>> {
  const auth = await requireWriter();
  if (!auth.ok) return auth.result;

  const parsed = changeSegmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.changeSegment(auth.businessId, auth.actor, parsed.data);
  if (result.ok) revalidatePath(CUSTOMERS_PATH);
  return result;
}

export async function updateCustomerNotes(
  input: unknown,
): Promise<ActionResult<CustomerListItem>> {
  const auth = await requireWriter();
  if (!auth.ok) return auth.result;

  const parsed = updateNotesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.updateNotes(auth.businessId, auth.actor, parsed.data);
  if (result.ok) revalidatePath(CUSTOMERS_PATH);
  return result;
}
