import "server-only";

import { decryptToken } from "@/lib/crypto/token-cipher";
import { MetaError, exchangeForLongLivedToken } from "@/lib/integrations/meta";

import { AUDIT_ACTIONS, recordConnectionChange } from "./audit";
import * as repo from "./repo";

// =============================================================================
// Refresh-on-read: THE ONLY MODULE THAT DECRYPTS A STORED TOKEN.
// =============================================================================
//
// docs/30-modules/42-integrations.md: "V1 refresh is on-read: the insights
// client re-exchanges any token older than 45d before use (long-lived tokens
// last ~60d, so read-time refresh suffices at V1 insight volumes); a dedicated
// scheduled refresh queue is added only when publishing arrives [SCALE] and
// stale tokens become user-visible failures."
//
// THERE IS DELIBERATELY NO REFRESH QUEUE. It would be a `jobs` row, a worker
// route, a QStash schedule and a failure path per tenant, all to solve a
// problem that does not exist yet: at V1 nothing WRITES to Meta, so a stale
// token cannot fail anything a merchant is watching - it can only make an
// insights tile show "reconnect" a little sooner than necessary. The moment
// publishing lands, a token that silently expired means a post that silently
// did not happen, and that is when the queue earns its keep. Doc 42 is
// explicit about the ordering and this file honours it rather than
// pre-building it.
//
// -----------------------------------------------------------------------------
// WHY 45 DAYS
// -----------------------------------------------------------------------------
//
// Meta's long-lived tokens last about 60. Refreshing at 45 leaves a fifteen-day
// window in which a merchant with ANY traffic at all gets a fresh token, which
// is what makes read-time refresh sufficient - a business whose portal nobody
// opens for fifteen consecutive days has no insights tile to break.
//
// The age is measured from `updated_at`, not from `token_expires_at`: the
// expiry Meta reports is sometimes absent (see the client's `toExpiry`), and a
// rule that silently does nothing when a field is null is a rule that will
// eventually not run at all. `updated_at` is maintained by the touch trigger
// on every write including a refresh, so it is exactly "how long since we last
// held a fresh token".
//
// -----------------------------------------------------------------------------
// THE TOKEN'S LIFETIME IN MEMORY
// -----------------------------------------------------------------------------
//
// Decrypted here, handed to exactly one caller, never returned to a server
// action, never serialized, never logged. `withPageToken` takes a callback
// instead of returning the token so that the value has no name in the caller's
// scope: a function that RETURNS a credential invites it to be stored in a
// variable, put in a context object, and eventually rendered.

/** Doc 42's threshold, in days. */
export const REFRESH_AFTER_DAYS = 45;

const REFRESH_AFTER_MS = REFRESH_AFTER_DAYS * 24 * 60 * 60 * 1000;

export type TokenFailure =
  /** No live connection with that id in that tenant. */
  | "not_found"
  /** The stored envelope could not be opened. Key rotated away, or tampered. */
  | "undecryptable"
  /** Meta says the token is dead. The connection is flipped to 'expired'. */
  | "expired"
  /** Meta is unreachable or the circuit is open. Retryable, nothing changed. */
  | "unavailable";

export type TokenResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: TokenFailure };

function isStale(updatedAt: string): boolean {
  const age = Date.now() - new Date(updatedAt).getTime();
  return Number.isFinite(age) && age >= REFRESH_AFTER_MS;
}

/**
 * Run `run` with a live page access token for one connection.
 *
 * The callback is named `run` rather than the more natural `use` because
 * `react-hooks/rules-of-hooks` treats any call to a bare `use(...)` as React's
 * `use` hook and rejects it outside a component. A lint rule is a poor reason
 * to name a parameter, so it is recorded here rather than left as a puzzle.
 *
 * The refresh is attempted BEFORE the callback runs, never after a failure,
 * and that ordering is the point of "refresh on read": a token refreshed
 * reactively (call, fail, refresh, retry) turns every expiry into at least one
 * user-visible error, which is exactly what doc 42's 45-day rule exists to
 * avoid.
 *
 * A REFRESH FAILURE IS NOT AUTOMATICALLY FATAL. If Meta is merely unreachable
 * the stored token is very likely still valid for another fifteen days, so the
 * call proceeds with it: refusing would convert a transient Meta outage into a
 * broken integration. Only an explicit rejection of the token itself
 * (META_AUTH_FAILED) flips the connection to 'expired', because that is Meta
 * telling us the credential is dead rather than telling us nothing.
 */
export async function withPageToken<T>(
  input: { readonly connectionId: string; readonly businessId: string },
  run: (accessToken: string) => Promise<T>,
): Promise<TokenResult<T>> {
  const row = await repo.readConnectionSecret(input);
  if (row === null) return { ok: false, failure: "not_found" };

  let token: string;
  try {
    token = decryptToken(row.accessTokenEncrypted);
  } catch {
    // The cause is swallowed: it is a TokenCipherError whose message is safe,
    // but nothing from the crypto path is re-thrown outward from this module
    // either. The connection is left alone - an undecryptable row is an
    // operations problem (a key removed from the registry too early), and
    // flipping it to 'expired' would tell the merchant to reconnect over
    // something reconnecting cannot fix.
    console.error(
      `[integrations/meta] connection ${input.connectionId} holds a token this build cannot open`,
    );
    return { ok: false, failure: "undecryptable" };
  }

  if (isStale(row.updatedAt)) {
    const refreshed = await refresh({
      connectionId: row.id,
      businessId: input.businessId,
      externalAccountId: row.externalAccountId,
      currentToken: token,
    });

    if (refreshed.ok) {
      token = refreshed.data;
    } else if (refreshed.failure === "expired") {
      return { ok: false, failure: "expired" };
    }
    // "unavailable" falls through deliberately: see the doc comment above.
  }

  return { ok: true, data: await run(token) };
}

/**
 * Re-exchange a long-lived token for a fresh long-lived token and store it.
 *
 * Meta's `fb_exchange_token` grant accepts a long-lived token as its input and
 * returns a new one with a fresh sixty-day window, which is why V1 needs no
 * refresh token and why `refresh_token_encrypted` is null on every
 * meta_business row (see migration 0032's column comment).
 */
async function refresh(input: {
  readonly connectionId: string;
  readonly businessId: string;
  readonly externalAccountId: string;
  readonly currentToken: string;
}): Promise<TokenResult<string>> {
  let fresh: { accessToken: string; expiresAt: Date | null };
  try {
    fresh = await exchangeForLongLivedToken({ accessToken: input.currentToken });
  } catch (error) {
    const code = error instanceof MetaError ? error.code : "unknown";

    if (code === "META_AUTH_FAILED") {
      // Meta has told us the credential is dead. This is the one branch that
      // changes state, and it is what makes doc 42's "expired/revoked token ->
      // connection status='expired', insights tiles show reconnect" happen.
      await repo.markStatus({
        connectionId: input.connectionId,
        status: "expired",
        actorId: null,
      });
      await recordConnectionChange({
        action: AUDIT_ACTIONS.expired,
        businessId: input.businessId,
        connectionId: input.connectionId,
        actorId: null,
        actorKind: "system",
        actorRole: null,
        before: { status: "connected" },
        after: { status: "expired", external_account_id: input.externalAccountId },
        reason: "Meta rejected the stored token during refresh-on-read",
      });
      return { ok: false, failure: "expired" };
    }

    // Logged by CODE only. Never the error, which could be re-serialized, and
    // never the token.
    console.warn(
      `[integrations/meta] refresh-on-read did not complete for connection ${input.connectionId} (${code})`,
    );
    return { ok: false, failure: "unavailable" };
  }

  // Store it, through the token-only UPDATE rather than the connect upsert -
  // see that function's header for why routing a refresh through the upsert
  // would erase the Page name and the granted scopes.
  //
  // A failed store is not fatal to this read: the token we just received still
  // works for the caller, and the next read will try again.
  const stored = await repo.updateConnectionToken({
    connectionId: input.connectionId,
    businessId: input.businessId,
    accessToken: fresh.accessToken,
    tokenExpiresAt: fresh.expiresAt,
  });
  if (!stored.ok) {
    console.warn(
      `[integrations/meta] refreshed token for connection ${input.connectionId} could not be stored`,
    );
  }

  return { ok: true, data: fresh.accessToken };
}
