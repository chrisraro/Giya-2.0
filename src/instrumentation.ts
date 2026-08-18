import { requestLogger, resolveRequestId } from "@/lib/log";
import {
  buildSentryOptions,
  readDsn,
  type EnvLike,
  type SentryLike,
} from "@/lib/observability/sentry";

// =============================================================================
// Next's instrumentation hook.
// =============================================================================
//
// THIS FILE IS THE POINT OF THE TASK, so it is worth saying why in full.
//
// Earlier in this project three merged, adversarially-reviewed tasks were
// reverted in an emergency after EVERY DYNAMICALLY RENDERED PAGE 500'd. The
// three revert commits carry git's default message and nothing else: no stack
// trace, no log line, no request id. Two agents then tried to diagnose it from
// the code; one was confidently wrong and one correctly refused to guess. The
// cause is still unknown.
//
// A page is not a route handler. src/lib/api/handler.ts logs faults for
// /api/v1 and it logs them well, but a server component that throws during
// render never goes anywhere near it - which is exactly the shape that
// incident had. `onRequestError` is the hook that sees those: Next calls it for
// server components, route handlers, server actions and middleware, with the
// error, the request, and which route was rendering.
//
// So `onRequestError` LOGS UNCONDITIONALLY and forwards to Sentry only if a DSN
// is set. That order is deliberate and is the whole design:
//
//   * The log line needs no credential, no vendor, no network and no account.
//     It works in `next dev`, in CI, and in a production deploy nobody has
//     finished configuring - which is every deploy this project has had.
//   * Sentry is a SECOND destination for the same fact, never the only one.
//     If it were the only one, this file would answer "which line threw?" with
//     "set up Sentry first", and the incident would replay exactly.
//
// -----------------------------------------------------------------------------
// WHY THE IMPORT IS DYNAMIC AND INSIDE THE `if`
// -----------------------------------------------------------------------------
// `await import("@sentry/nextjs")` runs only after a DSN is found. With no DSN
// the module is never evaluated: no OpenTelemetry registration, no global
// patching, no integration hooks, no network. A top-level import would do all
// of that before the check could run, and "installed but configured off" is a
// materially different runtime from "not there" - which is the difference the
// brief is asking for when it says no DSN must mean no behaviour change
// anywhere.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT HERE, AND WHY (READ BEFORE ADDING IT)
// -----------------------------------------------------------------------------
// Sentry's own setup guide also has you wrap `next.config.ts` with
// `withSentryConfig`. THAT IS NOT DONE, on purpose: a build-config change is
// what took production down last time, and t7-5-brief.md forbids one outright.
//
// Everything in this file works without it - `register` and `onRequestError`
// are Next's own hooks and `Sentry.init` is a runtime call - and the parts of
// `withSentryConfig` that would matter here were checked against the package
// (@sentry/nextjs 10.70.0) rather than assumed:
//
//   * serverExternalPackages. It appends pg, mysql, mongodb, redis, express
//     and similar so their OpenTelemetry instrumentation is not bundled. THIS
//     APP USES NONE OF THEM - Supabase and Upstash are both plain REST over
//     fetch - so the patch is inert here.
//   * A `release` and an `environment`. Injected at build time by the plugin;
//     set explicitly at runtime by buildSentryOptions() instead, from the same
//     VERCEL_GIT_COMMIT_SHA. No loss.
//   * SOURCE MAP UPLOAD. This one is a REAL loss and is not worked around:
//     without the plugin, client-side stack traces in Sentry stay minified.
//     Server-side traces are unaffected, and the structured log line carries
//     the server stack regardless - so "which line threw" survives on the
//     server and degrades on the client.
//   * A tunnel route (ad-blocker circumvention) and route-manifest transaction
//     naming. Both cosmetic here.
//
// If minified client stack traces are not acceptable, that is a decision about
// next.config.ts and it belongs to whoever owns that file. It is not a decision
// to make silently inside an instrumentation file.

/** Set once `register()` has actually initialized the SDK. Null on the
 * shipping path, and `onRequestError` reads it as "do not forward". */
let sentry: SentryLike | null = null;

function currentEnv(): EnvLike {
  return typeof process === "undefined" ? {} : ((process.env ?? {}) as EnvLike);
}

export interface RegisterDeps {
  readonly env?: EnvLike;
  /**
   * How `@sentry/nextjs` is obtained. Injected in tests for one assertion in
   * particular: with no DSN this must NEVER BE CALLED. That is the difference
   * between "we did not initialize" and "we did not even load it", and only
   * the second one is what the brief asks for.
   */
  readonly load?: () => Promise<SentryLike>;
}

/**
 * Next calls this once per server runtime at startup.
 *
 * Returns having done nothing at all when there is no DSN, which is the
 * configuration every deploy of this app has shipped with.
 */
export async function register(deps: RegisterDeps = {}): Promise<void> {
  const env = deps.env ?? currentEnv();
  const dsn = readDsn(env);
  if (dsn === null) {
    // No DSN. No init, no import, no network, no log line. See the header for
    // why silence is correct here rather than a "Sentry disabled" notice.
    sentry = null;
    return;
  }

  try {
    const loaded = await (deps.load ?? (() => import("@sentry/nextjs") as Promise<SentryLike>))();
    loaded.init(buildSentryOptions({ dsn, env }));
    sentry = loaded;
  } catch (error) {
    // A DSN IS SET AND SENTRY FAILED TO START. Unlike the absent case this is
    // worth exactly one line, because the operator has asked for error
    // reporting and is not getting it - and the silence would otherwise look
    // identical to "no errors". It must not throw: a monitoring tool that can
    // take the server down with it has inverted its own purpose.
    sentry = null;
    requestLogger("instrumentation-boot").error("Sentry is configured but failed to start", {
      err: error,
    });
  }
}

/** Next's shape for the second and third arguments of `onRequestError`. */
export interface RequestErrorRequest {
  readonly path?: string;
  readonly method?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
}

export interface RequestErrorContext {
  readonly routerKind?: string;
  readonly routePath?: string;
  readonly routeType?: string;
  readonly renderSource?: string;
  readonly revalidateReason?: string;
}

function headerValue(
  headers: RequestErrorRequest["headers"],
  name: string,
): string | null {
  const raw = headers?.[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

/**
 * Next's error hook for server components, route handlers, server actions and
 * middleware.
 *
 * ALWAYS logs. Forwards to Sentry only when `register()` initialized it.
 * Never throws - it runs while Next is already handling a failure, and a throw
 * from here would replace a diagnosable 500 with an undiagnosable one.
 */
export async function onRequestError(
  error: unknown,
  request: RequestErrorRequest,
  context: RequestErrorContext,
): Promise<void> {
  try {
    // The same correlation key /api/v1 uses, resolved by the same screened
    // function, so a page fault and an API fault in one user's session join on
    // one column. Absent inbound, a fresh id: an id nobody can join on the
    // client side is still better than no id at all, because it groups the
    // lines this one fault produced.
    const requestId = resolveRequestId(headerValue(request.headers, "x-request-id"));

    requestLogger(requestId).error("unhandled error rendering a request", {
      err: error,
      // `route_path` is the PATTERN (/business/[id]/rewards) and `path` is what
      // was actually requested. The pattern is what you group by; the path is
      // what you reproduce with. Neither substitutes for the other.
      route_path: context.routePath,
      path: request.path,
      method: request.method,
      router_kind: context.routerKind,
      route_type: context.routeType,
      render_source: context.renderSource,
      revalidate_reason: context.revalidateReason,
    });

    sentry?.captureRequestError(error, request, context);
  } catch {
    // See above: never the reason something fails.
  }
}
