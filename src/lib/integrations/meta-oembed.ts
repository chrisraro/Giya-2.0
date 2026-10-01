import "server-only";

import { z } from "zod";

import { getServerEnv } from "@/lib/env";

import { toFacebookPageUrl } from "./facebook-url";
import { META_GRAPH_VERSION } from "./meta-version";

// =============================================================================
// Meta oEmbed Read: the embed HTML for a public Facebook Page.
// =============================================================================
//
// Separate from meta.ts on purpose. Everything there is a per-merchant OAuth
// call that must never be cached (`cache: "no-store"`) and must never fail
// silently. This is the opposite on both counts: an APP token (app id + client
// token, no merchant consent involved), a response that is public and safe to
// cache for a day, and a caller - a render path - that wants `null` rather
// than an exception when Meta is unreachable. Bending meta.ts's `call` to cover
// both would weaken the guarantees it exists to give.
//
// The token goes in the Authorization header, as everywhere else in this
// codebase: a query-string token ends up in access logs and error objects.

const OEMBED_TIMEOUT_MS = 5_000;

/** Meta's embed is public content; a day is the longest we hold it. */
export const OEMBED_REVALIDATE_SECONDS = 86_400;

const oembedResponseSchema = z.object({ html: z.string().min(1) });
const graphErrorSchema = z.object({ error: z.object({ code: z.number() }) });

/**
 * Graph error #10 on this endpoint means "oEmbed Read must be reviewed and
 * approved" - a valid token, a feature not yet granted. It is named apart
 * from every other failure because the answer to it is different: the Page
 * can still be shown through Facebook's review-free Page Plugin, which the
 * component does, while a dead token or an outage leaves only the link.
 */
const OEMBED_NOT_APPROVED_CODE = 10;

export type FacebookPageEmbed =
  | { readonly status: "ok"; readonly html: string }
  | { readonly status: "pending_review" }
  | { readonly status: "unavailable" };

const UNAVAILABLE: FacebookPageEmbed = { status: "unavailable" };

/**
 * `app_id|client_token`, or null when oEmbed is not configured. The client
 * token is preferred (it is what Meta documents for oEmbed); the app secret is
 * accepted as a fallback because `app_id|app_secret` is also a valid app token
 * and is already set wherever the Meta integration is live.
 */
function getAppToken(): string | null {
  try {
    const env = getServerEnv();
    const secret = env.META_CLIENT_TOKEN ?? env.META_APP_SECRET;
    if (env.META_APP_ID === undefined || secret === undefined) return null;
    return `${env.META_APP_ID}|${secret}`;
  } catch {
    return null;
  }
}

/**
 * The oEmbed HTML for a Facebook Page URL; `pending_review` while Meta has not
 * approved oEmbed Read for this app; `unavailable` for everything else (a URL
 * outside the allowlist, no credentials, a timeout, any other error, a body
 * without `html`). Never throws.
 */
export async function getFacebookPageEmbed(pageUrl: string): Promise<FacebookPageEmbed> {
  const safeUrl = toFacebookPageUrl(pageUrl);
  if (safeUrl === null) return UNAVAILABLE;

  const token = getAppToken();
  if (token === null) {
    // Without this line a missing variable and a Meta outage look identical
    // in production: both render the plain link.
    console.warn("[integrations/meta-oembed] not configured: META_APP_ID and META_CLIENT_TOKEN (or META_APP_SECRET) are required");
    return UNAVAILABLE;
  }

  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oembed_page`);
  url.searchParams.set("url", safeUrl);
  url.searchParams.set("maxwidth", "500");
  url.searchParams.set("omitscript", "true");

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
      next: { revalidate: OEMBED_REVALIDATE_SECONDS },
    });

    if (!response.ok) {
      // Status and Graph error code only. The message text can echo the
      // request, and the request carries the token in a header that some
      // error shapes copy.
      const body: unknown = await response.json().catch(() => null);
      const parsedError = graphErrorSchema.safeParse(body);
      const code = parsedError.success ? parsedError.data.error.code : undefined;
      console.warn(
        `[integrations/meta-oembed] oembed_page answered HTTP ${response.status}${code === undefined ? "" : ` (code ${code})`}`,
      );
      return code === OEMBED_NOT_APPROVED_CODE ? { status: "pending_review" } : UNAVAILABLE;
    }

    const parsed = oembedResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.warn("[integrations/meta-oembed] oembed_page returned no html");
      return UNAVAILABLE;
    }
    return { status: "ok", html: parsed.data.html };
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.warn(`[integrations/meta-oembed] oembed_page request failed (${name})`);
    return UNAVAILABLE;
  }
}
