import "server-only";

import { isTokenCipherConfigured } from "@/lib/crypto/token-cipher";
import {
  META_PUBLISH_SCOPE,
  MetaError,
  isMetaConfigured,
  publishFacebookPost,
} from "@/lib/integrations/meta";

import { PUBLISH_PAGE_COPY, PUBLISH_SURFACE_COPY } from "../copy";
import { AUDIT_ACTIONS, recordConnectionChange } from "./audit";
import { readGrantedScopes } from "./capability";
import * as repo from "./repo";
import { withPageToken } from "./tokens";

// =============================================================================
// Posting a campaign announcement to a connected Facebook Page.
// =============================================================================
//
// THE ONLY WRITE THIS PLATFORM MAKES TO A MERCHANT'S META ACCOUNT. Everything
// else in this feature reads. That asymmetry is why this file is longer than
// the one line of Graph call it wraps.
//
// -----------------------------------------------------------------------------
// THE GATE, AND WHY IT IS NOT THE OBVIOUS ONE
// -----------------------------------------------------------------------------
//
// `publishFacebookPost` needs `pages_manage_posts`. That scope is now in
// META_V1_SCOPES, so it is REQUESTED. The obvious gate - "we ask for it,
// therefore we have it" - is wrong in three separate ways, each of which
// happens in production:
//
//   1. Meta's consent screen lets a user decline individual permissions.
//   2. An app pending App Review grants an unreviewed permission ONLY to its
//      own admins, developers and testers. Everyone else gets a shorter list
//      and no warning.
//   3. A merchant can remove a permission afterwards in Facebook's settings
//      without deauthorizing, which leaves our row's `scopes` column stale.
//
// So the gate is `readGrantedScopes`, which asks Meta what the token carries.
// The refusal when it is absent says what is TRUE - the permission has not been
// approved for this app yet - and does not tell the merchant to reconnect,
// because for anyone outside case 2's list, reconnecting produces exactly the
// same token.
//
// -----------------------------------------------------------------------------
// TWO THINGS THIS FILE USED TO DO AND NO LONGER DOES
// -----------------------------------------------------------------------------
//
// It called `decryptToken` directly. tokens.ts describes itself as the only
// module that opens a stored credential, and it was right to: routing through
// `withPageToken` is also what puts doc 42's refresh-on-read on the publish
// path, so a token in its forty-sixth day is re-exchanged before the post
// rather than after the failure.
//
// It returned `error?.message` off an `any`. On a MetaError that message is
// ours and harmless; on anything else it is a stack-adjacent string from a
// library, and the request it describes was made with a page token in the
// headers. Every failure now maps to prose written here.

export type PublishResult =
  | { readonly ok: true; readonly postId: string }
  | { readonly ok: false; readonly message: string };

/** Used for every failure at the Meta boundary itself. Never Meta's words. */
const PUBLISH_FAILED_MESSAGE = "That post could not be published. Please try again.";

export async function publishCampaignToMeta(input: {
  readonly businessId: string;
  readonly connectionId: string;
  /** `profiles.id` of the merchant pressing Publish. Audited, never sent to Meta. */
  readonly actorId: string;
  /** The role held at the time, denormalized onto the audit row per 0022. */
  readonly actorRole: string;
  readonly message: string;
  readonly linkUrl?: string | undefined;
}): Promise<PublishResult> {
  // Both checked before anything is read. They are separate variables with
  // separate fixes, and the two sentences differ so a support ticket can be
  // acted on.
  if (!isMetaConfigured()) {
    return { ok: false, message: PUBLISH_SURFACE_COPY.not_configured };
  }
  if (!isTokenCipherConfigured()) {
    return { ok: false, message: PUBLISH_SURFACE_COPY.storage_unavailable };
  }

  // Tenancy: `readConnectionSecret` pins `business_id` as well as the row id,
  // and the business id here comes from the caller's own `business_staff`
  // resolution in the action above. A connection id from another tenant finds
  // nothing.
  const connection = await repo.readConnectionSecret({
    connectionId: input.connectionId,
    businessId: input.businessId,
  });
  if (connection === null) {
    return { ok: false, message: PUBLISH_SURFACE_COPY.not_connected };
  }
  if (connection.status !== "connected") {
    return { ok: false, message: PUBLISH_PAGE_COPY.needs_reconnect };
  }

  // THE GATE. Asked before the post is composed into a request, so a merchant
  // without the grant costs one debug_token call and no write attempt.
  const granted = await readGrantedScopes(input.businessId, input.connectionId);
  if (!granted.ok) {
    return { ok: false, message: PUBLISH_PAGE_COPY[granted.failure] };
  }
  if (!granted.scopes.includes(META_PUBLISH_SCOPE)) {
    return { ok: false, message: PUBLISH_PAGE_COPY.scope_missing };
  }

  let published: { id: string };
  try {
    const result = await withPageToken(
      { connectionId: input.connectionId, businessId: input.businessId },
      (pageAccessToken) =>
        publishFacebookPost({
          pageId: connection.externalAccountId,
          pageAccessToken,
          message: input.message,
          link: input.linkUrl,
        }),
    );

    if (!result.ok) {
      // `withPageToken` already flipped the connection to 'expired' and
      // audited it when Meta rejected the credential during refresh.
      if (result.failure === "expired") {
        return { ok: false, message: PUBLISH_PAGE_COPY.needs_reconnect };
      }
      if (result.failure === "undecryptable" || result.failure === "not_found") {
        return { ok: false, message: PUBLISH_PAGE_COPY.unreadable };
      }
      return { ok: false, message: PUBLISH_PAGE_COPY.unavailable };
    }

    published = result.data;
  } catch (error) {
    // By CODE only, exactly as the callback path logs it. Meta's error bodies
    // quote the request, and this request carried a page token.
    const code = error instanceof MetaError ? error.code : "unknown";
    console.error(`[integrations/meta] a campaign post could not be published (${code})`);
    return { ok: false, message: PUBLISH_FAILED_MESSAGE };
  }

  // Audited AFTER the post lands, so the trail never claims a post that did
  // not happen. `after` carries the Page id and Meta's post id, both of which
  // appear in the public URL of the post itself; no token, in any form, since
  // 0022 publishes before/after to the tenant owner.
  await recordConnectionChange({
    action: AUDIT_ACTIONS.published,
    businessId: input.businessId,
    connectionId: input.connectionId,
    actorId: input.actorId,
    actorKind: "user",
    actorRole: input.actorRole,
    before: null,
    after: { external_account_id: connection.externalAccountId, post_id: published.id },
    reason: null,
  });

  return { ok: true, postId: published.id };
}
