import "server-only";

import { cache } from "react";

import { isTokenCipherConfigured } from "@/lib/crypto/token-cipher";
import {
  META_PUBLISH_SCOPE,
  MetaError,
  debugToken,
  isMetaConfigured,
} from "@/lib/integrations/meta";

import {
  needsReconnect,
  type MetaConnectionCapability,
  type MetaConnectionView,
  type MetaPageCapability,
  type MetaPublishView,
  type MetaSurfaceState,
} from "../types";
import * as repo from "./repo";
import { withPageToken } from "./tokens";

// =============================================================================
// WHAT A TOKEN CAN ACTUALLY DO. The one module allowed to answer that.
// =============================================================================
//
// `META_V1_SCOPES` says what the consent dialog ASKED for. This module says
// what Meta GRANTED, and those are different lists often enough that the
// difference is the whole reason the file exists:
//
//   - Meta's consent screen lets a user untick individual permissions.
//   - An app that has not passed App Review grants an unreviewed permission
//     only to users who are admins, developers or testers of that app. Every
//     other merchant silently receives a shorter list.
//   - A merchant can remove a permission later from Facebook's own settings,
//     without deauthorizing, which leaves `integration_connections.scopes`
//     stale for as long as the row lives.
//
// Any one of those turns a gate written against `META_V1_SCOPES` into a button
// that fails every time it is pressed, on a permission the merchant never had.
// Doc 42's scope amendment records the same rule in prose. THE ONLY
// TRUSTWORTHY SOURCE IS `GET /debug_token`, and it is read here.
//
// -----------------------------------------------------------------------------
// WHY THE ROW'S `scopes` COLUMN IS NOT USED FOR THIS
// -----------------------------------------------------------------------------
//
// It is a snapshot taken at connect time (service.ts records `debugToken`'s
// answer, not the request, which was already the right call). A snapshot is
// fine for showing a merchant what they granted. It is not fine for deciding
// whether a button works, because the third bullet above ages it silently.
//
// -----------------------------------------------------------------------------
// COST, AND WHY THE MEMOIZATION IS NOT DECORATION
// -----------------------------------------------------------------------------
//
// The marketing screen renders analytics tiles AND the composer, and both need
// the same answer for the same connections. `cache` makes that one Graph call
// per connection per request instead of two. Without it, every render doubles
// the traffic through a circuit breaker that opens after five consecutive
// failures, which is a self-inflicted outage under exactly the conditions the
// breaker exists for.
//
// -----------------------------------------------------------------------------
// NOTHING HERE THROWS, EVER
// -----------------------------------------------------------------------------
//
// Doc 42: expired or revoked tokens make "insights tiles show 'reconnect'
// state; never blocks core loops." These functions run inside a page render, so
// a Meta outage that escaped as an exception would take down the screen it sits
// on. Every failure becomes a value.

export type GrantedScopesResult =
  | { readonly ok: true; readonly scopes: readonly string[] }
  | {
      readonly ok: false;
      /** Maps 1:1 onto the non-'ready' members of MetaConnectionCapability. */
      readonly failure: Exclude<MetaConnectionCapability, "ready" | "scope_missing">;
    };

/**
 * What Meta says the token behind one connection currently carries.
 *
 * TWO POSITIONAL STRINGS, NOT AN OPTIONS OBJECT, and that is the one thing
 * about this signature worth defending. React's `cache` keys its memo on
 * ARGUMENT IDENTITY: primitives compare by value, objects by reference. An
 * `{ businessId, connectionId }` parameter would therefore be a fresh object on
 * every call and miss the cache every single time, leaving a memoization
 * comment sitting above a function that memoizes nothing. The rest of this
 * feature prefers named-field inputs; this function is the exception and here
 * is why.
 */
export const readGrantedScopes = cache(async function readGrantedScopes(
  businessId: string,
  connectionId: string,
): Promise<GrantedScopesResult> {
  // Checked before `withPageToken`, so a dormant deployment never decrypts a
  // credential it has no use for and never opens a request it cannot complete.
  if (!isMetaConfigured()) return { ok: false, failure: "unavailable" };

  let result: Awaited<ReturnType<typeof withPageToken<Awaited<ReturnType<typeof debugToken>>>>>;
  try {
    result = await withPageToken(
      { connectionId, businessId },
      // Refresh-on-read happens inside `withPageToken`, BEFORE this runs. A
      // capability check against a token that is about to be re-exchanged
      // would answer for the wrong credential.
      (accessToken) => debugToken({ accessToken }),
    );
  } catch (error) {
    // `debugToken` throwing is the Meta boundary failing, and the only code
    // that says anything about the CREDENTIAL rather than about Meta's health
    // is META_AUTH_FAILED.
    const code = error instanceof MetaError ? error.code : "unknown";
    if (code === "META_AUTH_FAILED") return { ok: false, failure: "needs_reconnect" };
    console.warn(`[integrations/meta] could not read granted scopes (${code})`);
    return { ok: false, failure: "unavailable" };
  }

  if (!result.ok) {
    switch (result.failure) {
      case "expired":
        return { ok: false, failure: "needs_reconnect" };
      case "not_found":
      case "undecryptable":
        // Neither is fixed by reconnecting, and both are ours to fix, so they
        // share the state whose copy does not send the merchant anywhere.
        return { ok: false, failure: "unreadable" };
      case "unavailable":
        return { ok: false, failure: "unavailable" };
    }
  }

  // A token Meta says is dead tells us NOTHING about scopes. Answering
  // 'scope_missing' with its empty list would send the merchant into a
  // conversation about permissions when the real problem is the grant.
  if (!result.data.isValid) return { ok: false, failure: "needs_reconnect" };

  return { ok: true, scopes: result.data.scopes };
});

/**
 * Whether one connection can be posted to.
 *
 * The scope name comes from `META_PUBLISH_SCOPE`, which is declared next to the
 * client that needs it and NOT derived from `META_V1_SCOPES` - see that
 * constant's header for why the two must be able to disagree.
 */
async function capabilityFor(
  businessId: string,
  connection: MetaConnectionView,
  requiredScope: string,
): Promise<MetaConnectionCapability> {
  // The row already records a dead grant. Asking Meta to confirm it would burn
  // a Graph call and, on a tenant with many expired connections, a run of
  // circuit-breaker failures that takes insights down for every other tenant.
  if (needsReconnect(connection.status)) return "needs_reconnect";

  const granted = await readGrantedScopes(businessId, connection.id);
  if (!granted.ok) return granted.failure;

  return granted.scopes.includes(requiredScope) ? "ready" : "scope_missing";
}

/** The Page's own name, or the id Meta identifies it by. Neither is a secret. */
function pageNameOf(connection: MetaConnectionView): string {
  return connection.externalAccountName ?? connection.externalAccountId;
}

/**
 * Read every connection for a tenant, or answer with the deployment-wide
 * reason there is nothing to read.
 *
 * Shared by this module and insights.ts so the two surfaces cannot disagree
 * about whether a tenant is connected.
 */
export async function resolveConnections(businessId: string): Promise<{
  readonly state: MetaSurfaceState;
  readonly connections: readonly MetaConnectionView[];
}> {
  if (!isMetaConfigured()) return { state: "not_configured", connections: [] };
  if (!isTokenCipherConfigured()) return { state: "storage_unavailable", connections: [] };

  let connections: readonly MetaConnectionView[];
  try {
    connections = await repo.listConnections(businessId);
  } catch {
    // `listConnections` already swallows a query error and answers []. This
    // catch is for the layer under it (no session, no client), and it lands on
    // the same honest answer: we cannot show you a connection.
    connections = [];
  }

  if (connections.length === 0) return { state: "not_connected", connections: [] };
  return { state: "pages", connections };
}

/**
 * Everything the campaign composer needs to decide what to render.
 *
 * One entry per connected Page, each with its OWN capability, because a
 * merchant with two Pages can genuinely hold the permission on one and not the
 * other, and a single collapsed answer would have to lie about one of them.
 */
export async function loadPublishView(input: {
  readonly businessId: string;
  readonly canManage: boolean;
}): Promise<MetaPublishView> {
  const resolved = await resolveConnections(input.businessId);
  if (resolved.state !== "pages") {
    return { state: resolved.state, pages: [], canManage: input.canManage };
  }

  const pages: MetaPageCapability[] = [];
  for (const connection of resolved.connections) {
    pages.push({
      connectionId: connection.id,
      pageName: pageNameOf(connection),
      capability: await capabilityFor(input.businessId, connection, META_PUBLISH_SCOPE),
    });
  }

  return { state: "pages", pages, canManage: input.canManage };
}
