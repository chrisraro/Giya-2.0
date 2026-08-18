import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  onRouterTransitionStart,
  registerClient,
  registrationCount,
} from "./instrumentation-client";
import type { SentryLike } from "@/lib/observability/sentry";

// Captured at MODULE SCOPE, before any hook or test body has run, so it
// records the state the import itself left behind and nothing else.
const REGISTRATIONS_AT_IMPORT = registrationCount();

// The browser half. Same subject as src/instrumentation.test.ts and for the
// same reason: THE DISABLED PATH IS WHAT SHIPS. On the client the cost of
// getting it wrong is higher than on the server - this file runs before
// hydration, so anything it loads is on the critical path of every first paint,
// and anything it throws is a blank screen caused by the crash reporter.

const PUBLIC_DSN = "https://xyz789@o1.ingest.sentry.io/43";

function sentryDouble() {
  return {
    init: vi.fn(),
    captureRequestError: vi.fn(),
    captureRouterTransitionStart: vi.fn(),
  } as unknown as SentryLike & {
    init: ReturnType<typeof vi.fn>;
    captureRouterTransitionStart: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  await registerClient({ env: {} });
  vi.restoreAllMocks();
});

describe("the module body", () => {
  it("registers itself on import - nothing else ever calls it in production", () => {
    // Next imports this file and calls the hooks it exports; it never calls
    // `registerClient`. The bare call at the bottom of the module is the ONLY
    // wire, and on the shipping path it has no other observable effect - so
    // without this assertion it could be deleted and every test would pass.
    expect(REGISTRATIONS_AT_IMPORT).toBe(1);
  });
});

describe("registerClient - with no DSN (the shipping configuration)", () => {
  it("does not even LOAD @sentry/nextjs", async () => {
    const load = vi.fn(async () => sentryDouble());
    await registerClient({ env: {}, load });
    expect(load).not.toHaveBeenCalled();
  });

  it("ignores a server-only SENTRY_DSN, which the browser can never see anyway", async () => {
    // Next inlines only NEXT_PUBLIC_*. Honouring a server DSN here would be a
    // branch that cannot be reached in a real browser bundle - dead code that
    // reads as a feature.
    const load = vi.fn(async () => sentryDouble());
    await registerClient({
      env: { SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/42" },
      load,
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("writes nothing to any console channel", async () => {
    await registerClient({ env: {} });
    for (const channel of ["error", "warn", "info", "log"] as const) {
      expect(console[channel]).not.toHaveBeenCalled();
    }
  });

  it("makes no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await registerClient({ env: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes onRouterTransitionStart a silent no-op on every navigation", async () => {
    await registerClient({ env: {} });

    onRouterTransitionStart("/wallet", "push");
    onRouterTransitionStart("/scan", "push");

    // Silent as well as safe. Letting the catch below absorb a TypeError would
    // also "not throw" - and would warn about an SDK nobody asked for, on the
    // path every user is on.
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("registerClient - with NEXT_PUBLIC_SENTRY_DSN", () => {
  it("initializes with the public DSN and the scrubbing options", async () => {
    const sentry = sentryDouble();

    await registerClient({
      env: { NEXT_PUBLIC_SENTRY_DSN: PUBLIC_DSN },
      load: async () => sentry,
    });

    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.dsn).toBe(PUBLIC_DSN);
    expect(options.sendDefaultPii).toBe(false);
    expect(typeof options.beforeSend).toBe("function");
  });

  it("does not enable Session Replay", async () => {
    // It records the DOM, and these screens carry receipt photographs, points
    // balances and email addresses. That is a consent decision, not a default.
    const sentry = sentryDouble();
    await registerClient({
      env: { NEXT_PUBLIC_SENTRY_DSN: PUBLIC_DSN },
      load: async () => sentry,
    });

    const options = sentry.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options).not.toHaveProperty("replaysSessionSampleRate");
    expect(options).not.toHaveProperty("replaysOnErrorSampleRate");
    expect(options).not.toHaveProperty("integrations");
  });

  it("forwards a router transition once it is initialized", async () => {
    const sentry = sentryDouble();
    await registerClient({
      env: { NEXT_PUBLIC_SENTRY_DSN: PUBLIC_DSN },
      load: async () => sentry,
    });

    onRouterTransitionStart("/wallet", "push");

    expect(sentry.captureRouterTransitionStart).toHaveBeenCalledExactlyOnceWith("/wallet", "push");
  });

  it("does not take the page down when the SDK fails to load", async () => {
    const onError = vi.fn();

    await expect(
      registerClient({
        env: { NEXT_PUBLIC_SENTRY_DSN: PUBLIC_DSN },
        load: async () => {
          throw new Error("chunk load failed");
        },
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    // ...and a navigation after the failure is still a no-op, not a throw.
    expect(() => onRouterTransitionStart("/wallet", "push")).not.toThrow();
  });

  it("survives an SDK whose transition hook throws, and says so once", async () => {
    const sentry = sentryDouble();
    sentry.captureRouterTransitionStart.mockImplementation(() => {
      throw new Error("instrumentation blew up");
    });
    await registerClient({
      env: { NEXT_PUBLIC_SENTRY_DSN: PUBLIC_DSN },
      load: async () => sentry,
    });

    expect(() => onRouterTransitionStart("/wallet", "push")).not.toThrow();
    expect(() => onRouterTransitionStart("/scan", "push")).not.toThrow();

    // ONCE, not once per click. Broken observability that reports nothing is
    // indistinguishable from healthy observability with nothing to report -
    // but the same fault on every navigation is one fact, not fifty.
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(sentry.captureRouterTransitionStart).toHaveBeenCalledTimes(2);
  });

  it("warns again after a re-registration, rather than once per process", async () => {
    const failing = () => {
      const sentry = sentryDouble();
      sentry.captureRouterTransitionStart.mockImplementation(() => {
        throw new Error("instrumentation blew up");
      });
      return sentry;
    };

    await registerClient({ env: { NEXT_PUBLIC_SENTRY_DSN: PUBLIC_DSN }, load: async () => failing() });
    onRouterTransitionStart("/wallet", "push");
    await registerClient({ env: { NEXT_PUBLIC_SENTRY_DSN: PUBLIC_DSN }, load: async () => failing() });
    onRouterTransitionStart("/wallet", "push");

    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
