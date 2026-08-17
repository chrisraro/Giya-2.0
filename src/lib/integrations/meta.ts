import "server-only";

import { z } from "zod";

import { getServerEnv } from "@/lib/env";

import { CircuitOpenError, withCircuitBreaker } from "./circuit-breaker";

// =============================================================================
// The Meta Graph API client. THE ONLY PLACE THIS CODEBASE TALKS TO META.
// =============================================================================
//
// docs/30-modules/42-integrations.md, "Integration resilience standards":
// typed clients in `src/lib/integrations/`, Zod-validated responses, an
// explicit timeout on every call, a circuit breaker, and NO SDK - features
// never import a vendor library, they call this module.
//
// No SDK is not stylistic. `facebook-nodejs-business-sdk` is several megabytes,
// carries its own transport, its own retry policy and its own logging, and the
// one thing this integration must guarantee above all others is that an access
// token is never written to a log. A dependency that logs is a dependency that
// will eventually log the wrong thing, and we would not find out from reading
// our own code. Four fetch calls with explicit schemas are smaller than the
// SDK's type definitions alone.
//
// -----------------------------------------------------------------------------
// DORMANT UNTIL CREDENTIALED
// -----------------------------------------------------------------------------
//
// META_APP_ID and META_APP_SECRET DO NOT EXIST YET. The Meta app has not been
// created, and Meta requires app review before most Page permissions work
// against a real account. This module is therefore complete and functional but
// asleep: `isMetaConfigured()` answers false, every call throws a typed
// META_NOT_CONFIGURED, and every caller above it degrades honestly (see
// src/features/integrations/meta/). Setting the two variables activates the
// whole integration with no code change.
//
// This is deliberately the same shape as
// src/features/receipts/server/ocr/provider.ts, which solved the same problem
// for the OCR container, with one difference that is worth naming: the OCR
// provider falls back to a STUB, because a receipt pipeline with no OCR has
// nothing to do. There is no stub here and there must not be one. A fake Meta
// client would produce fake Page ids and fake insight numbers, and the honest
// answer to "the app is not configured" is a disabled button that says so, not
// a connection to a business page that does not exist.
//
// -----------------------------------------------------------------------------
// WHAT NEVER APPEARS IN THIS FILE
// -----------------------------------------------------------------------------
//
// A token, in a log line, in an error message, or in a URL that could end up
// in one. Meta's Graph API accepts the token either as a query parameter or as
// an Authorization header; this client always uses the HEADER, because a query
// parameter travels in `error.request.url`, in proxy access logs, and in the
// `url` field of almost every HTTP error object ever designed. The two
// endpoints that structurally cannot use a header (the OAuth code exchange,
// which has no token yet, and the token exchange, whose subject IS the token)
// send their parameters in a POST body instead.

/** Pinned. An unpinned Graph version is a silent breaking change on Meta's schedule. */
export const META_GRAPH_VERSION = "v21.0";

const GRAPH_BASE = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** Doc 42 resilience standard #2: every outbound call has an explicit timeout. */
export const META_TIMEOUT_MS = 10_000;

/** The `{service}` segment of doc 42's `{env}:cb:{service}` breaker key. */
export const META_CIRCUIT_SERVICE = "meta";

/**
 * The scopes the consent dialog asks for.
 *
 * FOUR READ SCOPES PLUS `pages_manage_posts`. Doc 42 originally deferred both
 * publishing scopes to [SCALE]; that doc now records this amendment and its
 * reasoning, and the short version is here because this constant is where
 * somebody will come looking:
 *
 *   - The campaign composer (features/integrations/meta/components) posts a
 *     campaign announcement to a connected Page. That is a real, shipped,
 *     merchant-triggered control, so the permission behind it is one we can
 *     both justify to app review and demonstrate on a screencast. The rule
 *     "ask for read, get read" was never about the count of scopes; it was
 *     about not asking for permissions nothing uses.
 *   - Facebook grants an UNREVIEWED scope to users who are admins, developers
 *     or testers of the app. That is what makes this reachable before App
 *     Review and it is the whole reason the scope goes in now rather than
 *     after: the operator tests with exactly such an account.
 *
 * WHAT DOES NOT FOLLOW FROM THIS, and the mistake this comment exists to
 * prevent: requesting a scope is NOT holding it. Everyone else gets less. A
 * merchant can untick `pages_manage_posts` on the consent screen, and a
 * non-tester on an unreviewed app is silently granted a shorter list than was
 * requested. So NOTHING may gate a publishing affordance on this constant.
 * The granted set is read back from `debugToken` at runtime, and
 * server/capability.ts is the only module allowed to answer "can this
 * connection post".
 *
 * `instagram_content_publish` stays deferred: no surface in this codebase
 * publishes to Instagram, so it would be exactly the unjustifiable review line
 * item the paragraph above is careful not to be.
 */
export const META_V1_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
  "pages_manage_posts",
] as const;

export type MetaScope = (typeof META_V1_SCOPES)[number];

/**
 * The permission `publishFacebookPost` needs, named once.
 *
 * Exported so the capability gate compares a granted scope list against this
 * rather than spelling a Meta permission inline in a feature module. It is
 * declared separately from `META_V1_SCOPES` and NOT derived from it, because
 * the two answer different questions - "what did we ask for" and "what does
 * posting require" - and a gate built out of the request list is the exact
 * defect this whole design is avoiding.
 */
export const META_PUBLISH_SCOPE = "pages_manage_posts";

/** The permission `readPageInsights` needs. Same reasoning as above. */
export const META_INSIGHTS_SCOPE = "read_insights";

export type MetaErrorCode =
  /** META_APP_ID and/or META_APP_SECRET are unset. The dormant state. */
  | "META_NOT_CONFIGURED"
  /** Meta rejected the token: expired, revoked, or scoped wrong. Terminal. */
  | "META_AUTH_FAILED"
  /** Meta rejected the request itself (bad id, bad parameter). Terminal. */
  | "META_BAD_REQUEST"
  /** Meta throttled us. Retryable, and it counts against the breaker. */
  | "META_RATE_LIMITED"
  /** Meta is down or unreachable. Retryable, counts against the breaker. */
  | "META_UNAVAILABLE"
  /** The 10s timeout elapsed. Retryable, counts against the breaker. */
  | "META_TIMEOUT"
  /** A 200 whose body is not the documented shape. Terminal for this call. */
  | "META_BAD_RESPONSE"
  /** The breaker is open; the call was never made. */
  | "META_CIRCUIT_OPEN";

/**
 * A failure from the Meta boundary.
 *
 * `retryable` is explicit rather than derived, exactly as `OcrError` makes it
 * explicit, because the answer is not guessable from the HTTP status: a 400
 * from Meta with an OAuthException subcode is a permanently dead token, and
 * retrying it burns the budget and the merchant's patience alike.
 *
 * The MESSAGE is ours, not Meta's. Meta's error bodies echo request context,
 * and this client is called with a token in hand; a message built from their
 * response is a message that might contain it. Their `code`/`subcode` are kept
 * as numbers - useful for triage, incapable of carrying a credential.
 */
export class MetaError extends Error {
  readonly code: MetaErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Meta's numeric `error.code`, when the body carried one. */
  readonly providerCode: number | undefined;
  /** Meta's numeric `error.error_subcode`, when the body carried one. */
  readonly providerSubcode: number | undefined;

  constructor(
    code: MetaErrorCode,
    message: string,
    options: {
      retryable: boolean;
      // `| undefined` on each, because this project runs
      // exactOptionalPropertyTypes: an absent Meta error code and an explicit
      // `undefined` are the same fact here, and forcing callers to build the
      // object conditionally would be noise around a diagnostic field.
      status?: number | undefined;
      providerCode?: number | undefined;
      providerSubcode?: number | undefined;
    },
  ) {
    super(message);
    this.name = "MetaError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.providerSubcode = options.providerSubcode;
  }
}

// ---------------------------------------------------------------- schemas
// Every response is parsed. An unvalidated `as` on a third-party body is how a
// missing field becomes `undefined` three layers away, and here it would
// become a connection row with no external_account_id.

const metaErrorBodySchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
  }),
});

const accessTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  // Seconds. Absent on some long-lived exchanges, which is why the caller
  // computes an expiry only when it is present rather than defaulting to now.
  expires_in: z.number().int().nonnegative().optional(),
});

const pageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** The PAGE access token, present because `accounts` returns one per page. */
  access_token: z.string().min(1),
  category: z.string().optional(),
  tasks: z.array(z.string()).optional(),
});

const pagesResponseSchema = z.object({
  data: z.array(pageSchema),
});

const insightValueSchema = z.object({
  value: z.union([z.number(), z.record(z.string(), z.number())]),
  end_time: z.string().optional(),
});

const insightMetricSchema = z.object({
  name: z.string(),
  period: z.string(),
  values: z.array(insightValueSchema),
  title: z.string().optional(),
});

const insightsResponseSchema = z.object({
  data: z.array(insightMetricSchema),
});

const debugTokenSchema = z.object({
  data: z.object({
    app_id: z.string().optional(),
    is_valid: z.boolean(),
    scopes: z.array(z.string()).optional(),
    /** Unix seconds. 0 means "never expires" in Meta's encoding. */
    expires_at: z.number().int().optional(),
    user_id: z.string().optional(),
  }),
});

// ---------------------------------------------------------------- public types

/** A token plus, when Meta told us, when it stops working. */
export interface MetaAccessToken {
  readonly accessToken: string;
  /** Null when Meta did not state an expiry (it does for long-lived tokens). */
  readonly expiresAt: Date | null;
}

/** One Page the connecting user administers. */
export interface MetaPage {
  readonly id: string;
  readonly name: string;
  /**
   * The page-scoped token. This is the credential that gets stored, not the
   * user token: it survives the user's session and is scoped to this Page
   * alone, which is the least privilege available for a read integration.
   */
  readonly accessToken: string;
  readonly category: string | null;
}

/** One metric series from the Page insights edge. */
export interface MetaInsightMetric {
  readonly name: string;
  readonly period: string;
  readonly title: string | null;
  readonly values: ReadonlyArray<{
    readonly value: number | Record<string, number>;
    readonly endTime: string | null;
  }>;
}

/** What Meta says about a token we hold. */
export interface MetaTokenDebug {
  readonly isValid: boolean;
  readonly scopes: readonly string[];
  /** Null when Meta reports 0 ("never expires") or omits the field. */
  readonly expiresAt: Date | null;
}

export interface MetaAppCredentials {
  readonly appId: string;
  readonly appSecret: string;
}

// ---------------------------------------------------------------- configuration

/**
 * The app credentials, or null when the integration is dormant.
 *
 * Reads through `getServerEnv()` inside a try, exactly as
 * src/lib/queue/verify.ts does: that schema validates as a unit, so an
 * unrelated missing variable would otherwise surface here as "Meta is
 * misconfigured", which sends whoever is debugging in the wrong direction.
 *
 * HALF A CONFIGURATION IS ALWAYS A MISTAKE, and it is treated as dormant
 * rather than as an error - the opposite of the OCR provider's choice, and for
 * a reason that is specific to this integration. The OCR provider throws on a
 * half configuration because its fallback is a STUB that would fabricate
 * receipt text and corrupt the points ledger; being loud is the lesser harm
 * there. Here the fallback is a disabled button. An app id without a secret
 * cannot produce a wrong connection, only no connection, so the honest
 * behaviour is the same as no configuration at all - with a warning, because
 * it is still someone's half-finished deployment.
 */
export function getMetaCredentials(): MetaAppCredentials | null {
  let appId: string | undefined;
  let appSecret: string | undefined;

  try {
    const env = getServerEnv();
    appId = env.META_APP_ID;
    appSecret = env.META_APP_SECRET;
  } catch {
    // A server env that will not parse cannot tell us anything about Meta.
    return null;
  }

  if (appId === undefined && appSecret === undefined) return null;

  if (appId === undefined || appSecret === undefined) {
    console.warn(
      "[integrations/meta] META_APP_ID and META_APP_SECRET must both be set; treating the Meta integration as not configured.",
    );
    return null;
  }

  return { appId, appSecret };
}

/** Whether the Meta integration is live. Never throws; safe in a render path. */
export function isMetaConfigured(): boolean {
  return getMetaCredentials() !== null;
}

function requireCredentials(): MetaAppCredentials {
  const credentials = getMetaCredentials();
  if (credentials === null) {
    throw new MetaError(
      "META_NOT_CONFIGURED",
      "The Meta integration is not configured on this deployment.",
      { retryable: false },
    );
  }
  return credentials;
}

/**
 * The consent dialog URL the merchant is sent to.
 *
 * Pure and synchronous: no network call, so it is safe to build in a server
 * action. Returns null when the integration is dormant, which is what lets the
 * portal render "not configured" rather than a link to a broken dialog.
 */
export function buildAuthorizeUrl(input: {
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly string[];
}): string | null {
  const credentials = getMetaCredentials();
  if (credentials === null) return null;

  const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", credentials.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", (input.scopes ?? META_V1_SCOPES).join(","));
  url.searchParams.set("response_type", "code");
  return url.toString();
}

// ---------------------------------------------------------------- transport

/**
 * Which failures open the circuit.
 *
 * Only the ones that mean "the dependency is unhealthy". A dead token
 * (META_AUTH_FAILED) is a per-connection fact - if it opened the breaker, one
 * merchant who deleted their Page would stop insights working for every other
 * merchant on the platform. Same for META_BAD_REQUEST and META_BAD_RESPONSE:
 * those are bugs in our request or in our schema, and no amount of waiting
 * fixes them.
 */
function countsAgainstCircuit(error: unknown): boolean {
  if (!(error instanceof MetaError)) return true;
  return (
    error.code === "META_UNAVAILABLE" ||
    error.code === "META_TIMEOUT" ||
    error.code === "META_RATE_LIMITED"
  );
}

function mapErrorBody(status: number, body: unknown): MetaError {
  const parsed = metaErrorBodySchema.safeParse(body);
  const providerCode = parsed.success ? parsed.data.error.code : undefined;
  const providerSubcode = parsed.success ? parsed.data.error.error_subcode : undefined;

  // Meta's own rate-limit codes. They arrive as a 400, not a 429, which is why
  // status alone cannot classify this response.
  const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
  // 190 is OAuthException: token expired, revoked, or invalidated by a
  // password change. 102 is a dead session. 10 and 200..299 are permission
  // errors, which for our purposes are the same conversation with the
  // merchant: reconnect and grant the scope.
  const isAuthCode =
    providerCode === 190 ||
    providerCode === 102 ||
    providerCode === 10 ||
    (providerCode !== undefined && providerCode >= 200 && providerCode <= 299);

  if (providerCode !== undefined && RATE_LIMIT_CODES.has(providerCode)) {
    return new MetaError("META_RATE_LIMITED", "Meta is throttling this application.", {
      retryable: true,
      status,
      providerCode,
      providerSubcode,
    });
  }
  if (status === 429) {
    return new MetaError("META_RATE_LIMITED", "Meta is throttling this application.", {
      retryable: true,
      status,
      providerCode,
      providerSubcode,
    });
  }
  if (status >= 500) {
    return new MetaError("META_UNAVAILABLE", "Meta returned a server error.", {
      retryable: true,
      status,
      providerCode,
      providerSubcode,
    });
  }
  if (status === 401 || status === 403 || isAuthCode) {
    return new MetaError("META_AUTH_FAILED", "Meta rejected the stored credential.", {
      retryable: false,
      status,
      providerCode,
      providerSubcode,
    });
  }
  return new MetaError("META_BAD_REQUEST", "Meta rejected the request.", {
    retryable: false,
    status,
    providerCode,
    providerSubcode,
  });
}

interface RequestInput {
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly form?: Record<string, string>;
  /** Sent as `Authorization: Bearer`, NEVER as a query parameter. */
  readonly accessToken?: string;
}

/**
 * One Graph call: timeout, status mapping, JSON parse. No schema knowledge and
 * no breaker - both belong to `call` below, which is the only caller.
 */
async function rawRequest(input: RequestInput): Promise<unknown> {
  const url = new URL(`${GRAPH_BASE}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.accessToken !== undefined) {
    headers.Authorization = `Bearer ${input.accessToken}`;
  }

  let body: string | undefined;
  if (input.form !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(input.form).toString();
  }

  // AbortSignal.timeout rather than a manual controller + setTimeout: the
  // manual form leaks the timer when the request settles first, which in a
  // long-lived server process is a slow accumulation nobody attributes to the
  // Meta client.
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const isTimeout =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new MetaError(
      isTimeout ? "META_TIMEOUT" : "META_UNAVAILABLE",
      isTimeout
        ? `Meta did not respond within ${META_TIMEOUT_MS}ms.`
        : "Meta could not be reached.",
      { retryable: true },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      throw new MetaError("META_UNAVAILABLE", "Meta returned an unreadable response.", {
        retryable: response.status >= 500,
        status: response.status,
      });
    }
    throw new MetaError("META_BAD_RESPONSE", "Meta returned a body that is not JSON.", {
      retryable: false,
      status: response.status,
    });
  }

  if (!response.ok) {
    throw mapErrorBody(response.status, payload);
  }

  return payload;
}

/**
 * The single entry point every operation below goes through: breaker, request,
 * schema. Keeping it in one function is what makes "every Meta call is behind
 * the circuit breaker and Zod-validated" a property of the file rather than a
 * habit four functions have to remember.
 */
async function call<T>(schema: z.ZodType<T>, input: RequestInput): Promise<T> {
  let payload: unknown;
  try {
    payload = await withCircuitBreaker(
      { service: META_CIRCUIT_SERVICE, isFailure: countsAgainstCircuit },
      () => rawRequest(input),
    );
  } catch (error) {
    if (error instanceof CircuitOpenError) {
      throw new MetaError(
        "META_CIRCUIT_OPEN",
        "The Meta integration is temporarily unavailable.",
        { retryable: true },
      );
    }
    throw error;
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // The Zod issues are NOT included. They quote the offending values, and on
    // the token endpoints the offending value is a token.
    throw new MetaError("META_BAD_RESPONSE", "Meta returned an unexpected response shape.", {
      retryable: false,
    });
  }
  return parsed.data;
}

function toExpiry(expiresInSeconds: number | undefined): Date | null {
  if (expiresInSeconds === undefined || expiresInSeconds === 0) return null;
  return new Date(Date.now() + expiresInSeconds * 1000);
}

// ---------------------------------------------------------------- operations

/**
 * Step 1 of the callback: exchange the one-time `code` for a SHORT-LIVED user
 * token (roughly one hour).
 *
 * The app secret is in the POST BODY, not the query string. Meta's own
 * documentation shows this endpoint as a GET with the secret in the URL, which
 * would put the application's master credential into every proxy log between
 * here and Menlo Park.
 */
export async function exchangeCodeForToken(input: {
  readonly code: string;
  readonly redirectUri: string;
}): Promise<MetaAccessToken> {
  const credentials = requireCredentials();

  const result = await call(accessTokenSchema, {
    path: "/oauth/access_token",
    form: {
      client_id: credentials.appId,
      client_secret: credentials.appSecret,
      // Must be byte-identical to the one sent to the dialog, or Meta refuses.
      redirect_uri: input.redirectUri,
      code: input.code,
    },
  });

  return { accessToken: result.access_token, expiresAt: toExpiry(result.expires_in) };
}

/**
 * Step 2: exchange a short-lived token for a LONG-LIVED one (~60 days).
 *
 * Also the refresh path. doc 42's refresh-on-read re-runs this against the
 * token it already holds, which is why the parameter is named for what it is
 * (an existing token) rather than for where it came from: a long-lived token
 * re-exchanged inside its validity window yields a fresh long-lived token, and
 * that is the entire refresh mechanism at V1.
 */
export async function exchangeForLongLivedToken(input: {
  readonly accessToken: string;
}): Promise<MetaAccessToken> {
  const credentials = requireCredentials();

  const result = await call(accessTokenSchema, {
    path: "/oauth/access_token",
    form: {
      grant_type: "fb_exchange_token",
      client_id: credentials.appId,
      client_secret: credentials.appSecret,
      fb_exchange_token: input.accessToken,
    },
  });

  return { accessToken: result.access_token, expiresAt: toExpiry(result.expires_in) };
}

/**
 * The Pages this user administers, each with its own page token.
 *
 * `/me/accounts` rather than `/{user-id}/accounts`: the token already
 * identifies the user, so asking for an id first would be an extra round trip
 * whose answer we would then have to trust.
 */
export async function listPages(input: {
  readonly userAccessToken: string;
}): Promise<readonly MetaPage[]> {
  requireCredentials();

  const result = await call(pagesResponseSchema, {
    path: "/me/accounts",
    query: { fields: "id,name,access_token,category,tasks", limit: "100" },
    accessToken: input.userAccessToken,
  });

  return result.data.map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    category: page.category ?? null,
  }));
}

/**
 * Page insights (doc 42: the V1 capability, feeding doc 32's analytics tiles).
 *
 * The tiles themselves are out of scope for this slice - this is the client
 * they will call. Metrics are passed in rather than hard-coded here so the
 * surface that renders them owns which ones it wants, which is also what keeps
 * this module free of product decisions.
 */
export async function readPageInsights(input: {
  readonly pageId: string;
  readonly pageAccessToken: string;
  readonly metrics: readonly string[];
  readonly period?: "day" | "week" | "days_28";
  readonly since?: Date;
  readonly until?: Date;
}): Promise<readonly MetaInsightMetric[]> {
  requireCredentials();

  if (input.metrics.length === 0) {
    throw new MetaError("META_BAD_REQUEST", "At least one insight metric is required.", {
      retryable: false,
    });
  }

  const query: Record<string, string> = {
    metric: input.metrics.join(","),
    period: input.period ?? "day",
  };
  if (input.since !== undefined) {
    query.since = String(Math.floor(input.since.getTime() / 1000));
  }
  if (input.until !== undefined) {
    query.until = String(Math.floor(input.until.getTime() / 1000));
  }

  const result = await call(insightsResponseSchema, {
    path: `/${encodeURIComponent(input.pageId)}/insights`,
    query,
    accessToken: input.pageAccessToken,
  });

  return result.data.map((metric) => ({
    name: metric.name,
    period: metric.period,
    title: metric.title ?? null,
    values: metric.values.map((value) => ({
      value: value.value,
      endTime: value.end_time ?? null,
    })),
  }));
}

/**
 * What Meta currently believes about a token we hold: still valid, which
 * scopes were ACTUALLY granted, and when it expires.
 *
 * Used at connect time to record the granted scopes rather than the requested
 * ones. A user can uncheck a permission in the consent dialog, and a
 * connection row claiming `read_insights` when the merchant declined it turns
 * a clear "you did not grant this" into an unexplained empty tile.
 *
 * Authenticated with the APP token (`{app-id}|{app-secret}`), which is what
 * this endpoint requires; the token under inspection is the subject, not the
 * credential, so it goes in the query string. That is the one place in this
 * file where a token appears in a URL, and it is unavoidable - the endpoint
 * has no other shape. It is confined to this function for that reason.
 */
export async function debugToken(input: {
  readonly accessToken: string;
}): Promise<MetaTokenDebug> {
  const credentials = requireCredentials();

  const result = await call(debugTokenSchema, {
    path: "/debug_token",
    query: { input_token: input.accessToken },
    accessToken: `${credentials.appId}|${credentials.appSecret}`,
  });

  const expiresAt =
    result.data.expires_at === undefined || result.data.expires_at === 0
      ? null
      : new Date(result.data.expires_at * 1000);

  return {
    isValid: result.data.is_valid,
    scopes: result.data.scopes ?? [],
    expiresAt,
  };
}

/**
 * Revoke the grant at Meta's end (`DELETE /{user-id}/permissions`, expressed
 * here as the documented POST override).
 *
 * BEST EFFORT BY CONTRACT, per doc 42's disconnect rule. Returns whether the
 * revoke landed and NEVER throws: a merchant clicking Disconnect must end up
 * disconnected whatever Meta says. The alternative - a failed revoke blocking
 * the local disconnect - leaves them staring at a connection they have
 * explicitly asked us to drop, which is both worse UX and worse privacy than
 * the row simply going away while the grant lingers until it expires.
 */
export async function revokePermissions(input: {
  readonly accessToken: string;
}): Promise<boolean> {
  try {
    requireCredentials();
    await call(z.object({ success: z.boolean().optional() }).passthrough(), {
      path: "/me/permissions",
      form: { method: "delete" },
      accessToken: input.accessToken,
    });
    return true;
  } catch (error) {
    // Logged with the CODE only. `error.message` here is ours, not Meta's, but
    // the rule that nothing from this path is interpolated into a log is worth
    // holding even when the current value happens to be safe.
    const code = error instanceof MetaError ? error.code : "unknown";
    console.warn(`[integrations/meta] permission revoke did not complete (${code})`);
    return false;
  }
}

/**
 * Publish a text/link post to a Facebook Page (requires pages_manage_posts).
 */
export async function publishFacebookPost(input: {
  readonly pageId: string;
  readonly pageAccessToken: string;
  readonly message: string;
  readonly link?: string | undefined;
}): Promise<{ id: string }> {
  requireCredentials();
  const form: Record<string, string> = { message: input.message };
  if (input.link) form.link = input.link;

  return call(z.object({ id: z.string() }), {
    path: `/${encodeURIComponent(input.pageId)}/feed`,
    form,
    accessToken: input.pageAccessToken,
  });
}

/**
 * Publish an image/media post to an Instagram Business account.
 */
export async function publishInstagramMedia(input: {
  readonly igUserId: string;
  readonly pageAccessToken: string;
  readonly imageUrl: string;
  readonly caption: string;
}): Promise<{ id: string }> {
  requireCredentials();

  const container = await call(z.object({ id: z.string() }), {
    path: `/${encodeURIComponent(input.igUserId)}/media`,
    form: {
      image_url: input.imageUrl,
      caption: input.caption,
    },
    accessToken: input.pageAccessToken,
  });

  return call(z.object({ id: z.string() }), {
    path: `/${encodeURIComponent(input.igUserId)}/media_publish`,
    form: { creation_id: container.id },
    accessToken: input.pageAccessToken,
  });
}
