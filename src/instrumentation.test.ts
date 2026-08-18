import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onRequestError, register } from "./instrumentation";
import type { SentryLike } from "@/lib/observability/sentry";

// =============================================================================
// src/instrumentation.ts
// =============================================================================
//
// THE DISABLED PATH IS THE SUBJECT HERE, not the fallback. t7-5-brief.md,
// binding constraint 5: "A test that only runs in the environment where the
// failure cannot occur proves nothing. There is no SENTRY_DSN anywhere, so the
// disabled path is the one that ships - test it as such."
//
// So the strongest assertion in this file is a NEGATIVE one, and it is stated
// through an injected loader rather than a spy on `init`: with no DSN,
// `@sentry/nextjs` MUST NOT BE LOADED AT ALL. "We did not initialize it" and
// "we did not even evaluate the module" are different runtimes - the first
// still registers OpenTelemetry, patches globals and installs integration
// hooks - and only the second is what the brief asks for.
//
// The other subject is `onRequestError`, which is the half of this task that
// addresses the incident directly: a server component that throws during
// render never reaches src/lib/api/handler.ts, and that is the shape the
// reverted incident had.

const DSN = "https://abc123@o1.ingest.sentry.io/42";

function sentryDouble(): SentryLike & {
  init: ReturnType<typeof vi.fn>;
  captureRequestError: ReturnType<typeof vi.fn>;
} {
  return {
    init: vi.fn(),
    captureRequestError: vi.fn(),
  } as unknown as SentryLike & {
    init: ReturnType<typeof vi.fn>;
    captureRequestError: ReturnType<typeof vi.fn>;
  };
}

function lines(channel: "error" | "warn" | "info"): Record<string, unknown>[] {
  const spy = console[channel] as unknown as { mock: { calls: unknown[][] } };
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}

function onlyErrorLine(): Record<string, unknown> {
  const parsed = lines("error");
  expect(parsed).toHaveLength(1);
  return parsed[0]!;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(async () => {
  // Leave the module in the state that ships, so no later test inherits an
  // initialized SDK from an earlier one.
  await register({ env: {} });
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// The path that ships
// -----------------------------------------------------------------------------

describe("register - with no SENTRY_DSN (the shipping configuration)", () => {
  it("does not even LOAD @sentry/nextjs", async () => {
    const load = vi.fn(async () => sentryDouble());

    await register({ env: {}, load });

    expect(load).not.toHaveBeenCalled();
  });

  it("does not load it for a blank or malformed DSN either", async () => {
    const load = vi.fn(async () => sentryDouble());

    await register({ env: { SENTRY_DSN: "" }, load });
    await register({ env: { SENTRY_DSN: "   " }, load });
    await register({ env: { SENTRY_DSN: "not-a-dsn" }, load });

    expect(load).not.toHaveBeenCalled();
  });

  it("writes nothing to any console channel", async () => {
    // A "Sentry disabled" notice on every cold start, forever, for a feature
    // nobody has enabled, is how people learn to ignore startup output.
    await register({ env: {} });

    for (const channel of ["error", "warn", "info", "log", "debug"] as const) {
      expect(console[channel]).not.toHaveBeenCalled();
    }
  });

  it("makes no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await register({ env: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resolves rather than throwing, so a boot cannot fail on it", async () => {
    await expect(register({ env: {} })).resolves.toBeUndefined();
  });
});

describe("onRequestError - with no SENTRY_DSN", () => {
  it("STILL LOGS - the log is the primary channel, Sentry is the second one", async () => {
    await register({ env: {} });

    await onRequestError(new Error("Cannot read properties of undefined (reading 'id')"), {
      path: "/business/b-1/rewards",
      method: "GET",
      headers: { "x-request-id": "req-abcdefgh" },
    }, {
      routerKind: "App Router",
      routePath: "/business/[id]/rewards",
      routeType: "render",
    });

    const logged = onlyErrorLine() as { err: { message: string; stack: string } } & Record<
      string,
      unknown
    >;
    // Which request - the same key /api/v1 uses, resolved by the same screened
    // function, so a page fault and an API fault join on one column.
    expect(logged.request_id).toBe("req-abcdefgh");
    // Which route - the pattern to group by, the path to reproduce with.
    expect(logged.route_path).toBe("/business/[id]/rewards");
    expect(logged.path).toBe("/business/b-1/rewards");
    expect(logged.route_type).toBe("render");
    expect(logged.router_kind).toBe("App Router");
    expect(logged.method).toBe("GET");
    // Which line threw.
    expect(logged.err.message).toBe("Cannot read properties of undefined (reading 'id')");
    expect(typeof logged.err.stack).toBe("string");
  });

  it("records renderSource and revalidateReason, which separate the failure shapes", async () => {
    // `renderSource` is what tells a module-evaluation failure apart from a
    // per-request render failure - the two candidate shapes of the incident
    // this task exists because of. Dropping it would leave the next
    // investigation with the same ambiguity that stranded the last one.
    await register({ env: {} });

    await onRequestError(new Error("boom"), { path: "/wallet", method: "POST" }, {
      routerKind: "App Router",
      routePath: "/wallet",
      routeType: "render",
      renderSource: "react-server-components",
      revalidateReason: "on-demand",
    });

    expect(onlyErrorLine()).toMatchObject({
      method: "POST",
      render_source: "react-server-components",
      revalidate_reason: "on-demand",
    });
  });

  it("mints an id when the request carries none, so the line is still traceable", async () => {
    await register({ env: {} });

    await onRequestError(new Error("boom"), { path: "/wallet" }, { routeType: "render" });

    const logged = onlyErrorLine();
    expect(typeof logged.request_id).toBe("string");
    expect(String(logged.request_id).length).toBeGreaterThan(7);
    expect(logged).not.toHaveProperty("correlation_missing");
  });

  it("discards an inbound id that is not one, rather than echoing it into the line", async () => {
    await register({ env: {} });

    await onRequestError(
      new Error("boom"),
      { path: "/wallet", headers: { "x-request-id": 'evil","msg":"forged' } },
      { routeType: "render" },
    );

    const raw = String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]);
    expect(raw).not.toContain("forged");
  });

  it("reads a repeated header without crashing on the array", async () => {
    await register({ env: {} });

    await onRequestError(
      new Error("boom"),
      { path: "/wallet", headers: { "x-request-id": ["req-abcdefgh", "req-second"] } },
      { routeType: "render" },
    );

    expect(onlyErrorLine().request_id).toBe("req-abcdefgh");
  });

  it("never throws, even when handed nothing it expects", async () => {
    await register({ env: {} });

    await expect(
      onRequestError(undefined, undefined as never, undefined as never),
    ).resolves.toBeUndefined();
  });

  it("redacts a secret that arrived inside the error's own structured data", async () => {
    await register({ env: {} });

    const error = Object.assign(new Error("upstream refused"), {
      cause: { authorization: "Bearer sb_secret_leak" },
    });
    await onRequestError(error, { path: "/wallet" }, { routeType: "render" });

    const raw = String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]);
    expect(raw).not.toContain("sb_secret_leak");
  });
});

// -----------------------------------------------------------------------------
// The path an operator can switch on
// -----------------------------------------------------------------------------

describe("register - with a SENTRY_DSN", () => {
  it("loads the SDK and initializes it with the scrubbing options", async () => {
    const sentry = sentryDouble();

    await register({ env: { SENTRY_DSN: DSN }, load: async () => sentry });

    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.dsn).toBe(DSN);
    expect(options.sendDefaultPii).toBe(false);
    expect(typeof options.beforeSend).toBe("function");
  });

  it("forwards to Sentry AND still logs - never one instead of the other", async () => {
    const sentry = sentryDouble();
    await register({ env: { SENTRY_DSN: DSN }, load: async () => sentry });

    const thrown = new Error("boom");
    const request = { path: "/wallet", headers: { "x-request-id": "req-abcdefgh" } };
    const context = { routeType: "render" };
    await onRequestError(thrown, request, context);

    expect(sentry.captureRequestError).toHaveBeenCalledExactlyOnceWith(thrown, request, context);
    expect(onlyErrorLine().request_id).toBe("req-abcdefgh");
  });

  it("survives an SDK that fails to start, and says so exactly once", async () => {
    // The operator ASKED for error reporting and is not getting it. Silence
    // here would look identical to "no errors" - the one case where a line is
    // worth more than the quiet.
    await register({
      env: { SENTRY_DSN: DSN },
      load: async () => {
        throw new Error("@sentry/nextjs is not installed");
      },
    });

    const logged = onlyErrorLine() as { err: { message: string } } & Record<string, unknown>;
    expect(logged.err.message).toBe("@sentry/nextjs is not installed");
    expect(logged.request_id).toBe("instrumentation-boot");
  });

  it("does not forward after a failed start", async () => {
    const sentry = sentryDouble();
    await register({ env: { SENTRY_DSN: DSN }, load: async () => sentry });
    await register({
      env: { SENTRY_DSN: DSN },
      load: async () => {
        throw new Error("gone");
      },
    });
    (console.error as unknown as { mockClear: () => void }).mockClear();

    await onRequestError(new Error("boom"), { path: "/wallet" }, { routeType: "render" });

    expect(sentry.captureRequestError).not.toHaveBeenCalled();
  });

  it("stops forwarding when a later register finds no DSN", async () => {
    const sentry = sentryDouble();
    await register({ env: { SENTRY_DSN: DSN }, load: async () => sentry });
    await register({ env: {} });

    await onRequestError(new Error("boom"), { path: "/wallet" }, { routeType: "render" });

    expect(sentry.captureRequestError).not.toHaveBeenCalled();
  });
});
