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

// =============================================================================
// THE DEGRADED STATES, ONCE, FOR BOTH MARKETING SURFACES.
// =============================================================================
//
// Analytics tiles and the campaign composer fail in the same six ways, and the
// merchant is owed a different sentence for each. They are enumerated in the
// type system rather than left as booleans because a boolean pair
// (`available`, `connected`) collapses "we have no credentials on this
// deployment" into "you have not connected a Page", and those are different
// facts with different fixes and different audiences.
//
// The split into a DEPLOYMENT-wide state and a PER-CONNECTION state is
// deliberate. `not_configured` and `storage_unavailable` are facts about this
// build; `needs_reconnect` and `scope_missing` are facts about one Page's
// token, and a merchant with two Pages can be in both at once. Flattening them
// would force the surface to pick one sentence for two different situations.

/**
 * A fact about this deployment or this tenant, before any single Page is
 * considered.
 *
 * - `not_configured`     META_APP_ID / META_APP_SECRET unset.
 * - `storage_unavailable` INTEGRATION_TOKEN_AES_KEY unset. A DIFFERENT missing
 *                        variable with a different fix, which is why it is not
 *                        folded into the one above.
 * - `not_connected`      Configured and ready, but no Page has been connected.
 * - `pages`              There is at least one connection; see each one.
 */
export type MetaSurfaceState = "not_configured" | "storage_unavailable" | "not_connected" | "pages";

/**
 * A fact about ONE connected Page's token.
 *
 * - `ready`           Meta answered, and the token carries what this surface needs.
 * - `needs_reconnect` The connection is expired or revoked, or Meta says the
 *                     token is no longer valid. Reconnecting fixes this.
 * - `scope_missing`   Meta answered, the token works, and the permission this
 *                     surface needs is NOT in it. RECONNECTING MAY NOT FIX
 *                     THIS: an unreviewed app grants a shorter list to anyone
 *                     who is not an app admin, developer or tester, so the
 *                     copy for this state must not tell the merchant to try
 *                     again. See docs/30-modules/42-integrations.md.
 * - `unavailable`     We could not ask Meta at all (circuit open, timeout,
 *                     outage). Nothing is known, and nothing is claimed.
 * - `unreadable`      The stored credential could not be opened by this build.
 *                     An operations problem; reconnecting does not fix it
 *                     either, and saying "reconnect" would be a lie with a
 *                     button on it.
 */
export type MetaConnectionCapability =
  | "ready"
  | "needs_reconnect"
  | "scope_missing"
  | "unavailable"
  | "unreadable";

/** One connected Page, with what this surface can actually do with it. */
export interface MetaPageCapability {
  readonly connectionId: string;
  /** The Page's name, or its id when Meta never gave us a name. Not a secret. */
  readonly pageName: string;
  readonly capability: MetaConnectionCapability;
}

/**
 * One analytics figure.
 *
 * `reading` is a SUM TYPE and not a `number | null`, and that is the single
 * most important line in this file. A tile that stores 0 for "we could not
 * read impressions" is a tile that tells a merchant their reach collapsed. The
 * two cases are structurally different here, so a component cannot render one
 * as the other without deleting a branch.
 */
export interface MetaInsightTile {
  /** Meta's metric name, e.g. `page_impressions`. Useful in a bug report. */
  readonly metric: string;
  /** What the merchant reads. Fixed prose, not derived from `metric`. */
  readonly label: string;
  readonly reading:
    | { readonly kind: "value"; readonly value: number }
    | /**
       * Meta did not report this metric, or reported it in a shape that is not
       * one number (a breakdown object). NOT a zero. The tile says so.
       */
      { readonly kind: "unreported" };
}

/** One connected Page's analytics, or the reason there are none. */
export interface MetaPageInsights extends MetaPageCapability {
  /** Empty unless `capability` is 'ready'. Never partially invented. */
  readonly tiles: readonly MetaInsightTile[];
}

export interface MetaInsightsView {
  readonly state: MetaSurfaceState;
  /** Empty unless `state` is 'pages'. */
  readonly pages: readonly MetaPageInsights[];
  /** The window the tiles describe, as fixed prose for the panel heading. */
  readonly periodLabel: string;
}

export interface MetaPublishView {
  readonly state: MetaSurfaceState;
  /** Empty unless `state` is 'pages'. */
  readonly pages: readonly MetaPageCapability[];
  /** Whether the caller's role may press Publish at all (owner/manager). */
  readonly canManage: boolean;
}

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
