"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { resolveStaffContext } from "@/features/businesses/server/resolve-owner-business";
import { BUSINESS_SETTINGS_ROLES } from "@/features/businesses/settings/roles";

import { BUSINESS_MARKETING_ROLES } from "./roles";
import { publishCampaignToMeta } from "./server/publishing";
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

const MARKETING_PATH = "/business/marketing";

const NOT_ALLOWED_TO_PUBLISH: ActionResult<never> = {
  ok: false,
  message: "Only an owner, manager or marketing seat can post to a connected Page.",
};

/**
 * The campaign announcement composer's payload.
 *
 * `message` is bounded at 5000: Facebook's own feed limit is around 63k, but
 * nothing a merchant should type into a portal textarea approaches that, and an
 * unbounded string is an unbounded request body from one form post.
 *
 * `linkUrl` is validated as a URL and OPTIONAL, and an empty string is
 * normalized away rather than rejected - a merchant who clears the field is not
 * making a mistake, they are posting without a link.
 */
const publishSchema = z.object({
  connectionId: z.uuid(),
  message: z.string().trim().min(1).max(5000),
  linkUrl: z.union([z.url(), z.literal("")]).optional(),
});

/**
 * Post a campaign announcement to one connected Facebook Page.
 *
 * THE ONLY WRITE THIS PLATFORM MAKES TO A MERCHANT'S META ACCOUNT.
 *
 * The tenancy is resolved from `business_staff` under the caller's own session
 * first, exactly as the three actions above do: no business id is accepted from
 * the client, so a forged `connectionId` has nothing to point at - the repo
 * read pins `business_id` as well as the row id.
 *
 * The SCOPE gate is not here. It lives in server/publishing.ts, against what
 * Meta says the token carries, because an action that checked
 * `META_V1_SCOPES` would be checking what we asked for rather than what we
 * hold. See that file's header and doc 42's scope amendment.
 */
export async function publishMetaCampaign(
  input: unknown,
): Promise<ActionResult<{ postId: string }>> {
  const context = await resolveStaffContext(BUSINESS_MARKETING_ROLES);
  if (context === null) return NOT_ALLOWED_TO_PUBLISH;

  const parsed = publishSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: "Write a message, and check the link is a full web address." };
  }

  const result = await publishCampaignToMeta({
    businessId: context.businessId,
    connectionId: parsed.data.connectionId,
    actorId: context.userId,
    actorRole: context.role,
    message: parsed.data.message,
    // An empty field is "no link", not a link that is empty.
    linkUrl: parsed.data.linkUrl === "" ? undefined : parsed.data.linkUrl,
  });

  if (!result.ok) return { ok: false, message: result.message };

  // The capability panel above the composer reads a live token state, so the
  // screen is revalidated even on success: a publish that consumed the last of
  // a rate budget, or landed just as a token expired, should not leave a stale
  // "ready" next to it.
  revalidatePath(MARKETING_PATH);
  return { ok: true, data: { postId: result.postId } };
}
