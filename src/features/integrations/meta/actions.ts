"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { BUSINESS_SETTINGS_ROLES } from "@/features/businesses/settings/roles";

import * as service from "./server/service";
import type { ActionResult } from "./types";

// The three server actions behind the settings card. Each one resolves the
// caller's tenancy from `business_staff` under their OWN session first: no
// business id is ever accepted from the client, so there is nothing here for a
// forged form field to point at.
//
// doc 01's matrix and doc 42 agree on the audience - owner and manager - and
// BUSINESS_SETTINGS_ROLES is reused rather than redeclared so the settings
// screen and its integrations card cannot drift apart.

const SETTINGS_PATH = "/business/settings";

const NOT_ALLOWED: ActionResult<never> = {
  ok: false,
  message: "Only an owner or manager can manage connected accounts.",
};

/**
 * The public origin this request arrived on, used to build the OAuth
 * redirect_uri.
 *
 * Derived from the request headers rather than from an env var because the
 * value has to match the URL the merchant is actually on: a preview deployment
 * and production have different origins, and Meta refuses a redirect_uri that
 * is not byte-identical to the one the dialog was opened with.
 *
 * `x-forwarded-proto` is honoured because the app runs behind a proxy that
 * terminates TLS. That header is caller-influenced in principle, and the
 * consequence is bounded: the worst an attacker can do is make THEIR OWN
 * connect attempt open a dialog whose redirect_uri Meta will then refuse,
 * because it must also be on the app's registered domain allowlist in the Meta
 * console. The host is the deployment's own, from the platform.
 */
async function requestOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "";
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

/** Start the connect flow. Returns the consent dialog URL for the client to visit. */
export async function startMetaConnect(): Promise<ActionResult<{ authorizeUrl: string }>> {
  const context = await resolveStaffContext(BUSINESS_SETTINGS_ROLES);
  if (context === null) return NOT_ALLOWED;

  const result = await service.startConnect({
    businessId: context.businessId,
    userId: context.userId,
    origin: await requestOrigin(),
  });

  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, data: { authorizeUrl: result.authorizeUrl } };
}

const connectPagesSchema = z.object({
  selectionId: z.string().min(16).max(128),
  // A bounded list. Meta's `/me/accounts` is capped at 100 by the client, and
  // an unbounded array here would be an unbounded number of upserts and audit
  // rows from one form post.
  pageIds: z.array(z.string().min(1).max(64)).min(1).max(100),
});

/** Confirm the merchant's Page choice, writing one connection row per Page. */
export async function connectMetaPages(
  input: unknown,
): Promise<ActionResult<{ connected: number }>> {
  const context = await resolveStaffContext(BUSINESS_SETTINGS_ROLES);
  if (context === null) return NOT_ALLOWED;

  const parsed = connectPagesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Choose at least one Page to connect." };
  }

  const result = await service.connectPages({
    selectionId: parsed.data.selectionId,
    businessId: context.businessId,
    userId: context.userId,
    actorRole: context.role,
    pageIds: parsed.data.pageIds,
  });

  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(SETTINGS_PATH);
  return { ok: true, data: { connected: result.connected } };
}

const disconnectSchema = z.object({
  connectionId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
});

/**
 * Disconnect one connection.
 *
 * `reason` is optional: 0022 makes it mandatory only for `actor_kind='admin'`,
 * and this is a merchant acting inside their own tenant (`'user'`). Demanding
 * one would push callers into writing filler text, which devalues the field on
 * the rows where it is a security control.
 */
export async function disconnectMeta(input: unknown): Promise<ActionResult<null>> {
  const context = await resolveStaffContext(BUSINESS_SETTINGS_ROLES);
  if (context === null) return NOT_ALLOWED;

  const parsed = disconnectSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "That connection could not be found." };
  }

  const result = await service.disconnect({
    connectionId: parsed.data.connectionId,
    businessId: context.businessId,
    userId: context.userId,
    actorRole: context.role,
    reason: parsed.data.reason?.trim() || null,
  });

  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath(SETTINGS_PATH);
  return { ok: true, data: null };
}
