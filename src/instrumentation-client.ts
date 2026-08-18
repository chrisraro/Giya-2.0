import {
  buildSentryOptions,
  readDsn,
  type EnvLike,
  type SentryLike,
} from "@/lib/observability/sentry";

// =============================================================================
// The browser half, behind NEXT_PUBLIC_SENTRY_DSN.
// =============================================================================
//
// Next 15.3+ runs this file before the app hydrates. It is the client
// counterpart of src/instrumentation.ts and follows the same two rules:
//
//   1. NO DSN MEANS NOTHING HAPPENS. `@sentry/nextjs` is not imported, so no
//      global handler is installed, no fetch or XHR wrapper is patched, no
//      Replay recorder starts, and no byte crosses the network. On this path
//      the only cost is one `process.env` read, which Next has already inlined
//      to a constant at build time.
//   2. IT NEVER THROWS. Anything thrown here runs before the app does, so it
//      would be a blank screen caused by the crash reporter.
//
// A CLIENT DSN IS A DIFFERENT VARIABLE, NOT AN ALIAS. Next inlines only
// `NEXT_PUBLIC_*` into the browser bundle, so a file reading
// `process.env.SENTRY_DSN` here would read `undefined` no matter what the
// operator set - wired-looking and permanently inert. See
// src/lib/observability/sentry.ts for why publishing a DSN is not the
// compromise it appears to be.
//
// Deliberately NOT enabled even when a DSN is present: Session Replay. It
// records the DOM, and this app's screens carry receipt photographs, points
// balances and email addresses. Turning it on is a privacy decision with a
// consent question attached, not an observability default.

let sentry: SentryLike | null = null;

// Counts completed registrations. This exists for exactly one reason: the
// module body's `registerClient()` call at the bottom of this file is the ONLY
// thing that wires the browser SDK up, and on the shipping path it has no
// observable effect at all - so deleting it changed nothing any test could
// see. A guard, or a wire, whose removal changes nothing observable is
// untested. This makes it observable.
let registrations = 0;

/** How many times `registerClient` has completed in this module instance. */
export function registrationCount(): number {
  return registrations;
}

/** Reset alongside `sentry` so each registration gets one warning, not one
 * ever. Tests re-register between cases and would otherwise inherit silence. */
function resetTransitionWarning(): void {
  warnedAboutTransitions = false;
}

function currentEnv(): EnvLike {
  return typeof process === "undefined" ? {} : ((process.env ?? {}) as EnvLike);
}

export interface RegisterClientDeps {
  readonly env?: EnvLike;
  /** Injected in tests. With no DSN it must never be called - "not loaded" is
   * a stronger claim than "not initialized", and it is the one being made. */
  readonly load?: () => Promise<SentryLike>;
  readonly onError?: (error: unknown) => void;
}

/**
 * Initialize the browser SDK if, and only if, a public DSN is configured.
 *
 * Exported (and awaited by the module body below) so the disabled path is
 * testable without a browser - the path that ships.
 */
export async function registerClient(deps: RegisterClientDeps = {}): Promise<void> {
  const env = deps.env ?? currentEnv();
  const dsn = readDsn(env, { client: true });
  resetTransitionWarning();
  if (dsn === null) {
    sentry = null;
    registrations += 1;
    return;
  }

  try {
    const loaded = await (deps.load ?? (() => import("@sentry/nextjs") as Promise<SentryLike>))();
    loaded.init(buildSentryOptions({ dsn, env }));
    sentry = loaded;
  } catch (error) {
    sentry = null;
    deps.onError?.(error);
  }
  registrations += 1;
}

/**
 * Next's client navigation hook. Next calls it synchronously, so it can only
 * forward once `registerClient` has finished - which is correct rather than a
 * limitation: before that there is no SDK to receive a span, and the
 * alternative (blocking hydration on a dynamic import) trades a real cost for
 * a cosmetic one.
 */
export function onRouterTransitionStart(href: string, navigationType: string): void {
  const hook = sentry?.captureRouterTransitionStart;
  // The early return is not merely an optimisation over letting the try/catch
  // absorb a TypeError, and it is not decoration either: on the shipping path
  // this runs on EVERY navigation, and the catch below is not silent. Without
  // this line the disabled path would warn once per session about an SDK that
  // was never asked to exist. (A mutant survived here until the catch was
  // given something to say - with a silent catch the two are indistinguishable
  // and one of them is dead code.)
  if (hook === undefined) return;

  try {
    hook.call(sentry, href, navigationType);
  } catch (error) {
    // Never the reason a navigation fails - but not silent either. An SDK
    // whose instrumentation throws is broken observability, and broken
    // observability that reports nothing is indistinguishable from healthy
    // observability with nothing to report. Once per page load, not per
    // navigation: the same fault on every click is one fact, not fifty.
    if (!warnedAboutTransitions) {
      warnedAboutTransitions = true;
      console.warn("[sentry] router transition instrumentation failed", error);
    }
  }
}

let warnedAboutTransitions = false;

// The module body itself. `void` rather than a top-level await: a top-level
// await here would make this an async module and delay hydration on every
// page load, on the shipping path, for a feature that is switched off.
void registerClient();
