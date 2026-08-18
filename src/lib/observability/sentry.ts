import { redact } from "@/lib/log";

// =============================================================================
// Sentry, behind SENTRY_DSN - and OFF is the shipping configuration.
// =============================================================================
//
// t7-5-brief.md, stated as plainly as it can be: "Absent `SENTRY_DSN` is the
// shipping path, exactly as it is today. No DSN must mean: no initialization,
// no network call, no console noise, no crash, and no behaviour change
// anywhere."
//
// There is no DSN in CI, none in development, and none in production until an
// operator sets one. So the disabled path is not the edge case to be tolerated;
// it is the ONLY path that has ever run. Everything here is arranged so that
// path does as close to nothing as a function can:
//
//   * `readDsn` returns null and the caller returns immediately.
//   * `@sentry/nextjs` IS NEVER IMPORTED. src/instrumentation.ts loads it with
//     a dynamic `import()` INSIDE the DSN check, so with no DSN the module is
//     never evaluated, no OpenTelemetry is registered, no global is patched and
//     no integration installs a hook. A top-level import would do all of that
//     before the check could run, which is the difference between "configured
//     off" and "not there".
//   * Nothing is logged. A warning on every cold start, forever, for a feature
//     nobody has turned on, is how people learn to ignore startup output.
//
// -----------------------------------------------------------------------------
// WHY THE CLIENT NEEDS ITS OWN VARIABLE
// -----------------------------------------------------------------------------
// `SENTRY_DSN` is a server variable. Next inlines only `NEXT_PUBLIC_*` into the
// browser bundle, so a client config reading `process.env.SENTRY_DSN` would
// read `undefined` FOREVER, no matter what the operator set - it would look
// wired and never once initialize. `NEXT_PUBLIC_SENTRY_DSN` is therefore a
// separate key rather than an alias, and the client reads it first. A DSN is
// not a secret (it is embedded in every browser bundle of every app that uses
// Sentry; it authorizes writing events and nothing else), so publishing it is
// not the compromise it looks like.
//
// -----------------------------------------------------------------------------
// PII
// -----------------------------------------------------------------------------
// Sentry's defaults capture more than this product should. `sendDefaultPii` is
// false, and `scrubEvent` runs on the way out as a second, independent pass:
// request bodies and query strings are dropped, headers are reduced to the one
// that carries no personal data and does carry the correlation id, cookies go,
// and the user object keeps `id` and loses email, username and IP.
//
// `redact()` is imported from src/lib/log.ts rather than reimplemented, so the
// two scrubbers CANNOT drift - which is the only way a claim like "the same
// rules apply to anything forwarded" stays true after someone adds a key.

/** The surface of `@sentry/nextjs` this app uses. Structural, so the tests can
 * substitute a double and so nothing here depends on the package being
 * installed in order to type-check. */
export interface SentryLike {
  init(options: Record<string, unknown>): void;
  captureRequestError(error: unknown, request: unknown, context: unknown): void;
  captureRouterTransitionStart?(href: string, navigationType: string): void;
}

export type EnvLike = Record<string, string | undefined>;

/** A Sentry event, as much of one as this module touches. */
export interface SentryEventLike {
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    data?: unknown;
    query_string?: unknown;
  };
  user?: { id?: string; email?: string; username?: string; ip_address?: string };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The only header forwarded to Sentry. It carries no personal data and it is
 * the join key between a Sentry issue and the structured log line for the same
 * fault - which is the whole point of forwarding anything.
 */
const FORWARDED_HEADERS: readonly string[] = ["x-request-id"];

/** A DSN has to be a URL with a public key in it. Anything else is a typo, and
 * handing a typo to `Sentry.init` produces a warning per event forever. */
const DSN_PATTERN = /^https?:\/\/[^@/]+@[^/]+\/\d+$/;

/**
 * The configured DSN, or null.
 *
 * Null covers unset, empty, whitespace, and malformed. All four mean the same
 * thing to every caller - do nothing - and collapsing them here is what lets
 * the call sites be a single `if`.
 */
export function readDsn(env: EnvLike, options: { client?: boolean } = {}): string | null {
  // The client reads ONLY the public key, with no fallback to `SENTRY_DSN`.
  // A fallback would be dead code that reads as a feature: in a browser bundle
  // `process.env.SENTRY_DSN` is `undefined` no matter what the operator set,
  // so the branch could never be taken in production and would exist purely to
  // make a test pass in Node. The server accepts either, so one public key can
  // still configure both halves.
  const raw = options.client ? env.NEXT_PUBLIC_SENTRY_DSN : (env.SENTRY_DSN ?? env.NEXT_PUBLIC_SENTRY_DSN);
  // One check, not two. An explicit `length === 0` guard was here and a mutant
  // survived it: the pattern already rejects the empty string, so the guard
  // could be deleted without any test noticing. A guard whose removal changes
  // nothing observable is dead code that reads as diligence.
  const trimmed = raw?.trim() ?? "";
  return DSN_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * `beforeSend`. Drops everything that could carry personal data and redacts
 * what is left with src/lib/log.ts's rules.
 */
export function scrubEvent(event: SentryEventLike): SentryEventLike {
  const scrubbed: SentryEventLike = { ...event };

  if (scrubbed.request) {
    const { url, method, headers } = scrubbed.request;
    const kept: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = headers?.[name];
      if (typeof value === "string") kept[name] = value;
    }
    // Rebuilt from an allowlist rather than deleted key by key: a denylist has
    // to be updated every time a framework starts sending a new header, and
    // the update always lands after the disclosure.
    scrubbed.request = { ...(url ? { url } : {}), ...(method ? { method } : {}), headers: kept };
  }

  if (scrubbed.user) {
    // The id is not personal data on its own and it is what makes an issue
    // actionable ("which user"). The other three are.
    scrubbed.user = scrubbed.user.id === undefined ? {} : { id: scrubbed.user.id };
  }

  for (const key of ["extra", "contexts", "tags"] as const) {
    const value = scrubbed[key];
    if (value !== undefined) {
      scrubbed[key] = redact(value) as Record<string, unknown>;
    }
  }

  return scrubbed;
}

export interface SentryOptionsInput {
  readonly dsn: string;
  readonly env: EnvLike;
}

/**
 * The init options, identical on server, edge and client.
 *
 * Tracing is OFF unless an operator asks for it. A default sample rate would
 * put a performance bill and a request-shaped data flow behind a variable
 * somebody set to capture a crash.
 */
export function buildSentryOptions({ dsn, env }: SentryOptionsInput): Record<string, unknown> {
  const rate = Number.parseFloat(env.SENTRY_TRACES_SAMPLE_RATE ?? "");
  const release = (env.VERCEL_GIT_COMMIT_SHA ?? env.VERCEL_DEPLOYMENT_ID ?? "").trim();

  return {
    dsn,
    // Never let the SDK decide what counts as personal data.
    sendDefaultPii: false,
    tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0,
    // Set explicitly rather than left to the build plugin: without
    // `withSentryConfig` (see src/instrumentation.ts's header) nothing injects
    // a release, and an issue that cannot say which deploy it came from is the
    // exact gap this task exists to close.
    ...(release.length > 0 ? { release } : {}),
    environment: env.VERCEL_ENV ?? env.NODE_ENV ?? "development",
    beforeSend: (event: SentryEventLike) => scrubEvent(event),
    beforeSendTransaction: (event: SentryEventLike) => scrubEvent(event),
  };
}
