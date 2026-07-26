import "server-only";

import { decryptToken, isTokenCipherConfigured } from "@/lib/crypto/token-cipher";
import {
  MetaError,
  buildAuthorizeUrl,
  debugToken,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  isMetaConfigured,
  listPages,
  revokePermissions,
} from "@/lib/integrations/meta";

import type { MetaIntegrationView } from "../types";
import { AUDIT_ACTIONS, recordConnectionChange } from "./audit";
import * as repo from "./repo";
import { consumeSelection, peekSelectablePages, storePendingSelection } from "./selection";
// `verifyState` is deliberately NOT imported here. The state check belongs to
// the callback ROUTE, which runs it before calling into this module at all -
// see that route's step ordering.
import { issueState } from "./state";

// =============================================================================
// The connect / select / disconnect flow, per doc 42's "Connect flow" bullet.
// =============================================================================
//
//   1. startConnect     owner/manager presses Connect. Mints a state nonce,
//                       returns the consent dialog URL.
//   2. completeCallback the callback route, AFTER state verification. Exchanges
//                       the code, upgrades to a long-lived token, lists Pages,
//                       parks them encrypted, returns a selection id.
//   3. listSelectable   the picker screen reads the parked page names.
//   4. connectPages     the merchant's choice becomes connection rows.
//   5. disconnect       soft delete plus a best-effort revoke at Meta.
//
// Steps 2 and 4 are separate because doc 42 requires the merchant to PICK, and
// because a callback cannot render a chooser - it has to answer with a
// redirect. What travels through the browser between them is one opaque
// selection id; the tokens stay server-side and encrypted (see selection.ts).
//
// -----------------------------------------------------------------------------
// EVERYTHING HERE DEGRADES HONESTLY WHEN THE INTEGRATION IS DORMANT
// -----------------------------------------------------------------------------
//
// META_APP_ID and META_APP_SECRET do not exist yet. Every entry point below
// checks first and returns a message that names the actual problem, so nothing
// throws and nothing half-completes. `INTEGRATION_TOKEN_AES_KEY` is checked
// separately and BEFORE the dialog is opened rather than at the insert: a
// connect that walks the merchant through Meta's consent screen and only then
// discovers it has nowhere safe to put the token has already obtained a real
// credential it must now discard.

/** Where Meta sends the merchant back. Must match the token exchange exactly. */
export function callbackUrl(origin: string, businessId: string): string {
  return `${origin}/api/v1/businesses/${businessId}/integrations/meta/callback`;
}

export type ConnectStart =
  | { readonly ok: true; readonly authorizeUrl: string }
  | { readonly ok: false; readonly message: string };

const NOT_CONFIGURED_MESSAGE =
  "Facebook and Instagram connections are not available on this deployment yet.";

const NO_STORAGE_MESSAGE =
  "Facebook and Instagram connections are not available yet: secure credential storage is not configured.";

/**
 * Step 1. Mint the state and build the consent URL.
 *
 * The state is issued BEFORE the URL is built and is bound to this business
 * and this user; see state.ts for the three attacks that binding stops.
 */
export async function startConnect(input: {
  readonly businessId: string;
  readonly userId: string;
  readonly origin: string;
}): Promise<ConnectStart> {
  if (!isMetaConfigured()) return { ok: false, message: NOT_CONFIGURED_MESSAGE };
  if (!isTokenCipherConfigured()) return { ok: false, message: NO_STORAGE_MESSAGE };

  const redirectUri = callbackUrl(input.origin, input.businessId);

  let state: string;
  try {
    state = await issueState({
      businessId: input.businessId,
      userId: input.userId,
      redirectUri,
    });
  } catch {
    // The state store is the CSRF defence; without it there is no safe flow.
    return { ok: false, message: "Could not start the connection. Please try again." };
  }

  const authorizeUrl = buildAuthorizeUrl({ redirectUri, state });
  if (authorizeUrl === null) return { ok: false, message: NOT_CONFIGURED_MESSAGE };

  return { ok: true, authorizeUrl };
}

export type CallbackFailure =
  | "not_configured"
  | "state_rejected"
  | "exchange_failed"
  | "unavailable"
  | "no_pages";

export type CallbackResult =
  | { readonly ok: true; readonly selectionId: string; readonly pageCount: number }
  | { readonly ok: false; readonly failure: CallbackFailure };

/**
 * Step 2. Everything the callback does after the state has been verified.
 *
 * The state check is NOT here - it is in the route, before this is called,
 * because the route is the only place that has the raw query parameters and
 * because "verify before you exchange" is easier to audit when the verify is
 * the first thing in the file that handles the request.
 *
 * A merchant with no Pages is a distinct outcome, not an error: they are
 * signed in to a personal Facebook account with no Page attached, and the
 * honest answer names that rather than saying something failed.
 */
export async function completeCallback(input: {
  readonly businessId: string;
  readonly userId: string;
  readonly code: string;
  readonly redirectUri: string;
}): Promise<CallbackResult> {
  if (!isMetaConfigured() || !isTokenCipherConfigured()) {
    return { ok: false, failure: "not_configured" };
  }

  try {
    // The short-lived user token. Roughly an hour, and useless to store.
    const shortLived = await exchangeCodeForToken({
      code: input.code,
      redirectUri: input.redirectUri,
    });

    // Upgraded immediately. doc 42: "Short-lived user token exchanged
    // server-side for a long-lived token (~60d) and page tokens."
    const longLived = await exchangeForLongLivedToken({
      accessToken: shortLived.accessToken,
    });

    // What Meta says was ACTUALLY granted. A user can uncheck a permission in
    // the consent dialog, and recording the requested list instead would turn
    // "you declined this" into an unexplained empty tile later.
    const granted = await debugToken({ accessToken: longLived.accessToken });

    const pages = await listPages({ userAccessToken: longLived.accessToken });
    if (pages.length === 0) return { ok: false, failure: "no_pages" };

    const selectionId = await storePendingSelection({
      businessId: input.businessId,
      userId: input.userId,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        category: page.category,
        accessToken: page.accessToken,
      })),
      grantedScopes: granted.scopes,
      tokenExpiresAt: (granted.expiresAt ?? longLived.expiresAt)?.toISOString() ?? null,
    });

    return { ok: true, selectionId, pageCount: pages.length };
  } catch (error) {
    const code = error instanceof MetaError ? error.code : "unknown";
    // By code only. Meta's own message can quote the request, and the request
    // carried the authorization code.
    console.error(`[integrations/meta] callback could not be completed (${code})`);

    if (
      code === "META_UNAVAILABLE" ||
      code === "META_TIMEOUT" ||
      code === "META_RATE_LIMITED" ||
      code === "META_CIRCUIT_OPEN"
    ) {
      return { ok: false, failure: "unavailable" };
    }
    return { ok: false, failure: "exchange_failed" };
  }
}

/** Step 3. The picker's page list, with no tokens in it (see selection.ts). */
export async function listSelectable(input: {
  readonly selectionId: string;
  readonly businessId: string;
  readonly userId: string;
}) {
  return peekSelectablePages(input);
}

export type ConnectPagesResult =
  | { readonly ok: true; readonly connected: number }
  | { readonly ok: false; readonly message: string };

/**
 * Step 4. Turn the merchant's choice into `integration_connections` rows.
 *
 * ONE ROW PER PAGE, per doc 42. The PAGE token is stored, not the user token:
 * it survives the user's session and is scoped to that Page alone, which is
 * the least privilege available for a read integration.
 *
 * The selection is consumed atomically first, so a double-submitted form
 * cannot connect twice, and so an abandoned flow leaves nothing behind when
 * its ten minutes elapse.
 */
export async function connectPages(input: {
  readonly selectionId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly actorRole: string;
  readonly pageIds: readonly string[];
}): Promise<ConnectPagesResult> {
  if (input.pageIds.length === 0) {
    return { ok: false, message: "Choose at least one Page to connect." };
  }

  const selection = await consumeSelection({
    selectionId: input.selectionId,
    businessId: input.businessId,
    userId: input.userId,
  });
  if (selection === null) {
    return {
      ok: false,
      message: "That connection attempt has expired. Please start again.",
    };
  }

  const chosen = selection.pages.filter((page) => input.pageIds.includes(page.id));
  if (chosen.length === 0) {
    return { ok: false, message: "Those Pages are no longer available. Please start again." };
  }

  const expiresAt =
    selection.tokenExpiresAt === null ? null : new Date(selection.tokenExpiresAt);

  let connected = 0;
  for (const page of chosen) {
    const stored = await repo.upsertConnection({
      businessId: input.businessId,
      actorId: input.userId,
      externalAccountId: page.id,
      externalAccountName: page.name,
      accessToken: page.accessToken,
      scopes: selection.grantedScopes,
      tokenExpiresAt: expiresAt,
    });

    if (!stored.ok) return { ok: false, message: stored.message };
    connected += 1;

    await recordConnectionChange({
      action: AUDIT_ACTIONS.connected,
      businessId: input.businessId,
      connectionId: stored.data.id,
      actorId: input.userId,
      actorKind: "user",
      actorRole: input.actorRole,
      before: null,
      // Page id and name only. NO TOKEN, in any form: 0022 grants before/after
      // to the tenant owner, so anything here is published to that tenant.
      after: {
        status: "connected",
        external_account_id: page.id,
        external_account_name: page.name,
        scopes: [...selection.grantedScopes],
      },
      reason: null,
    });
  }

  return { ok: true, connected };
}

export type DisconnectResult =
  | { readonly ok: true; readonly revokedAtProvider: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * Step 5. Disconnect one connection.
 *
 * ORDER: revoke at Meta FIRST (best effort), then soft-delete locally. Doing
 * the local delete first would be tidier to write and wrong in one specific
 * way - the revoke needs the token, and the token is read from the row being
 * deleted, so a failure between the two steps would leave a grant standing at
 * Meta with nothing on our side pointing at it.
 *
 * A FAILED REVOKE NEVER BLOCKS THE DISCONNECT. doc 42 says "best-effort
 * revokes the grant", and the merchant's intent is unambiguous: refusing to
 * disconnect because Meta is having a bad afternoon leaves them staring at a
 * connection they have explicitly asked us to drop. The grant expires on its
 * own within sixty days regardless.
 */
export async function disconnect(input: {
  readonly connectionId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly actorRole: string;
  readonly reason: string | null;
}): Promise<DisconnectResult> {
  const row = await repo.readConnectionSecret({
    connectionId: input.connectionId,
    businessId: input.businessId,
  });
  if (row === null) {
    return { ok: false, message: "That connection could not be found." };
  }

  let revokedAtProvider = false;
  if (isMetaConfigured()) {
    try {
      const token = decryptToken(row.accessTokenEncrypted);
      revokedAtProvider = await revokePermissions({ accessToken: token });
    } catch {
      // An undecryptable token means we cannot revoke, which is exactly the
      // case "best effort" is for. Never surfaced to the merchant: from their
      // side the disconnect works either way.
      console.warn(
        `[integrations/meta] could not open the token for connection ${input.connectionId}; skipping the provider revoke`,
      );
    }
  }

  const removed = await repo.softDeleteConnection({
    connectionId: input.connectionId,
    businessId: input.businessId,
    actorId: input.userId,
  });
  if (!removed.ok) return { ok: false, message: removed.message };

  await recordConnectionChange({
    action: AUDIT_ACTIONS.disconnected,
    businessId: input.businessId,
    connectionId: input.connectionId,
    actorId: input.userId,
    actorKind: "user",
    actorRole: input.actorRole,
    before: { status: row.status, external_account_id: row.externalAccountId },
    after: { status: "revoked", deleted: true, revoked_at_provider: revokedAtProvider },
    reason: input.reason,
  });

  return { ok: true, revokedAtProvider };
}

/**
 * Everything the settings card renders, including WHY there is no button when
 * there is no button.
 *
 * Never throws: it runs inside a page render, and a settings screen that 500s
 * because an unconfigured integration asked a question is a worse outcome than
 * any message this can return.
 */
export async function loadIntegrationView(input: {
  readonly businessId: string;
  readonly canManage: boolean;
}): Promise<MetaIntegrationView> {
  const configured = isMetaConfigured();
  const storageReady = isTokenCipherConfigured();

  // The read is still performed when the integration is dormant. Credentials
  // can be removed from an environment while rows remain, and a merchant whose
  // connection exists is entitled to see it rather than to be told nothing is
  // connected.
  const connections = await repo.listConnections(input.businessId);

  return { configured, storageReady, canManage: input.canManage, connections };
}

/**
 * The deauthorize webhook's effect: every live connection for these external
 * accounts is marked 'revoked' and audited as a system action.
 *
 * Not a soft delete. doc 42 says the webhook "marks the connection `revoked`;
 * UI prompts reconnect" - the row has to survive for the prompt to have
 * anything to hang off, and for the merchant to see that the grant they made
 * has ended rather than simply finding the connection gone.
 */
export async function markDeauthorized(externalAccountIds: readonly string[]): Promise<number> {
  const connections = await repo.findConnectionsByExternalAccount(externalAccountIds);

  let marked = 0;
  for (const connection of connections) {
    const updated = await repo.markStatus({
      connectionId: connection.id,
      status: "revoked",
      actorId: null,
    });
    if (!updated.ok) continue;
    marked += 1;

    await recordConnectionChange({
      action: AUDIT_ACTIONS.revoked,
      businessId: connection.businessId,
      connectionId: connection.id,
      actorId: null,
      actorKind: "system",
      actorRole: null,
      before: { status: "connected" },
      after: { status: "revoked" },
      reason: "Meta deauthorize callback",
    });
  }

  return marked;
}
