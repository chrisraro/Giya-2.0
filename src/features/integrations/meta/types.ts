// Shared types for the Meta Business integration. No server imports here, so
// the client components can use these without dragging a service-role client
// or `server-only` into a browser bundle.

/** `integration_connections.provider`, the only value this slice writes. */
export const META_PROVIDER = "meta_business";

/** `integration_connections.status`, migration 0032's check constraint. */
export const CONNECTION_STATUSES = ["connected", "expired", "revoked", "error"] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/**
 * A connection as the PORTAL sees it.
 *
 * There is no token field on this type and there must never be one. That is
 * not merely a convention: `integration_connections` has no client SELECT
 * grant on the two token columns (migration 0032), so a query that tried to
 * populate one would raise 42501 rather than succeed quietly. This type is the
 * compile-time half of the same fence - the field is unspellable, so no
 * component can ask for it and no serializer can accidentally carry it across
 * the server/client boundary.
 */
export interface MetaConnectionView {
  readonly id: string;
  readonly status: ConnectionStatus;
  /** The Facebook Page id. Not a secret: it appears in every public Page URL. */
  readonly externalAccountId: string;
  readonly externalAccountName: string | null;
  readonly scopes: readonly string[];
  /** ISO string, or null when Meta did not state one. */
  readonly tokenExpiresAt: string | null;
  readonly lastSyncedAt: string | null;
  /** Operator-facing summary when `status` is 'error'. Never a provider body. */
  readonly error: string | null;
  readonly connectedAt: string;
}

/**
 * Everything the settings card needs in one shape, including the two "why is
 * there no Connect button" cases the merchant is entitled to an explanation
 * for.
 */
export interface MetaIntegrationView {
  /**
   * False when META_APP_ID / META_APP_SECRET are unset. The card renders a
   * plain "not configured" state and no button; see the component.
   */
  readonly configured: boolean;
  /**
   * False when INTEGRATION_TOKEN_AES_KEY is unset. Distinct from `configured`
   * because it is a DIFFERENT missing variable with a different fix, and
   * because connecting without it would obtain a real token from Meta and then
   * have nowhere safe to put it.
   */
  readonly storageReady: boolean;
  /** Whether the caller's role may press the buttons (owner/manager). */
  readonly canManage: boolean;
  readonly connections: readonly MetaConnectionView[];
}

export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string };

/**
 * A status that means the merchant has to walk the consent dialog again.
 *
 * 'error' is deliberately NOT in this list: an error is our problem or Meta's,
 * and telling a merchant to reconnect because a read timed out trains them to
 * re-grant permissions whenever anything looks wrong, which is exactly the
 * habit a phishing flow relies on.
 */
export function needsReconnect(status: ConnectionStatus): boolean {
  return status === "expired" || status === "revoked";
}
