"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveStaffContext } from "../server/resolve-owner-business";
import { BUSINESS_SETTINGS_ROLES } from "./roles";
import { businessProfileSchema } from "./schemas";
import * as service from "./server/service";
import type { ActionResult, BusinessProfileView } from "./types";

const SETTINGS_PATH = "/business/settings";

const NOT_ALLOWED: ActionResult<never> = {
  ok: false,
  message: "Only an owner or manager can edit business details.",
};

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

/**
 * Saves the business's presentation fields.
 *
 * The input is parsed by a STRICT schema, so a payload that carries `status`,
 * `verified_at` or `plan` is rejected outright rather than having those keys
 * stripped. That is deliberate: silently dropping them would make a caller that
 * tried believe it had succeeded, and this action is the only client-reachable
 * write on `businesses`.
 */
export async function saveBusinessProfile(
  input: unknown,
): Promise<ActionResult<BusinessProfileView>> {
  const context = await resolveStaffContext(BUSINESS_SETTINGS_ROLES);
  if (!context) return NOT_ALLOWED;

  const parsed = businessProfileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await service.saveProfile(context.businessId, parsed.data);
  if (result.ok) revalidatePath(SETTINGS_PATH);
  return result;
}
