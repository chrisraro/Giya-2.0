import type * as React from "react";

import { describe, expect, it, vi, beforeEach } from "vitest";

// The consumer onboarding gate. `/onboarding` was reachable from exactly one
// place before this - destinationFor() on the signup page - so signing IN to
// an un-onboarded account, or arriving through /auth/callback (whose `next`
// defaults to /home), skipped the wizard permanently. These tests are the
// fence against that regressing, and against the opposite failure: a gate
// that bounces people who HAVE onboarded, or that fires on a read error and
// traps someone in a loop.

vi.mock("server-only", () => ({}));

// redirect() throws a special error in Next so control never returns to the
// caller. Model that: the tests assert on the throw, which is also what
// proves the layout stops rather than rendering children behind a redirect.
class RedirectError extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectError(to);
  },
}));

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: mocks.maybeSingle }),
      }),
    }),
  }),
}));

const ConsumerLayout = (await import("./layout")).default;
const { OfflineBanner } = await import("@/components/pwa/offline-banner");
const { RegisterServiceWorker } = await import("@/components/pwa/register-service-worker");

const USER_ID = "11111111-1111-4111-8111-111111111111";

function signedIn(): void {
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
}

function signedOut(): void {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
}

async function renderLayout(): Promise<React.ReactElement> {
  return ConsumerLayout({ children: null });
}

/**
 * Every component type in the tree the layout returns.
 *
 * Walks the element tree rather than grepping the source, because a grep for
 * `<OfflineBanner` is equally satisfied by a mount that has been commented out,
 * by a mention in a doc comment, and by a real one. This collects the actual
 * `type` references React would render, so the only thing that can put
 * `OfflineBanner` in the result is the layout really returning one.
 */
function componentTypes(node: unknown, out: Set<unknown> = new Set()): Set<unknown> {
  if (Array.isArray(node)) {
    for (const child of node) componentTypes(child, out);
    return out;
  }
  if (node === null || typeof node !== "object") return out;

  const element = node as { type?: unknown; props?: { children?: unknown } };
  if (element.type !== undefined) out.add(element.type);
  if (element.props?.children !== undefined) componentTypes(element.props.children, out);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consumer onboarding gate", () => {
  it("CRITICAL: redirects a signed-in consumer whose onboarded_at is null", async () => {
    signedIn();
    mocks.maybeSingle.mockResolvedValue({ data: { onboarded_at: null }, error: null });

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });

  it("lets an onboarded consumer through", async () => {
    signedIn();
    mocks.maybeSingle.mockResolvedValue({
      data: { onboarded_at: "2026-07-01T00:00:00.000Z", is_suspended: false },
      error: null,
    });

    await expect(renderLayout()).resolves.toBeDefined();
  });

  it("does not touch a signed-out visitor, so /b/[slug] stays public", async () => {
    signedOut();

    await expect(renderLayout()).resolves.toBeDefined();
    // The profile read must not even be attempted for an anonymous caller.
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });

  it("lets the request through when the profile row cannot be read", async () => {
    // A failed read answers `data: null`. Treating that as "not onboarded"
    // would send someone into the wizard on a transient database blip, and
    // onboarding is a preference collector, not a security boundary.
    signedIn();
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(renderLayout()).resolves.toBeDefined();
  });
});

describe("the consumer shell mounts the PWA surfaces", () => {
  // WHAT THESE PROVE, AND WHAT THEY DO NOT.
  //
  // They prove the layout's returned tree really contains these components -
  // by identity, not by name - for a consumer who gets past both gates. That
  // is the whole reason T5.2 exists: OfflineBanner was written in T-1 and
  // imported by nothing, so doc 41 section 9's "one global offline pill" did
  // not appear anywhere in the product.
  //
  // They do NOT prove the pill is VISIBLE, or that it is the only one, or
  // anything at all about which URLs the service worker caches. Visibility is
  // the component's own tests (offline-banner.test.tsx); uniqueness and the
  // portal exclusion are src/app/offline-ui-scope.test.ts and
  // src/app/service-worker-scope.test.ts; caching is decided by the route
  // matcher in src/lib/pwa/runtime-caching.ts and proved there.

  it("CRITICAL: mounts the offline pill", async () => {
    signedIn();
    mocks.maybeSingle.mockResolvedValue({
      data: { onboarded_at: "2026-07-01T00:00:00.000Z", is_suspended: false },
      error: null,
    });

    expect(componentTypes(await renderLayout())).toContain(OfflineBanner);
  });

  it("mounts it for a signed-out visitor too", async () => {
    // /b/[slug] lives in this group and is public. Somebody following a shared
    // shop link on a dying connection is exactly who the pill is for, and the
    // signed-out branch returns early from the gates - a mount placed inside
    // the authenticated branch would miss them.
    signedOut();

    expect(componentTypes(await renderLayout())).toContain(OfflineBanner);
  });

  it("still mounts the service worker registration alongside it (T5.1)", async () => {
    // Pinned here so a refactor of this return statement cannot quietly drop
    // one while adding the other.
    signedOut();

    expect(componentTypes(await renderLayout())).toContain(RegisterServiceWorker);
  });
});

describe("consumer suspension gate (doc 30 section 2.8)", () => {
  it("CRITICAL: redirects a signed-in consumer whose profile is suspended", async () => {
    signedIn();
    mocks.maybeSingle.mockResolvedValue({
      data: { onboarded_at: "2026-07-01T00:00:00.000Z", is_suspended: true },
      error: null,
    });

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/suspended?type=account");
  });

  it("checks suspension before onboarding, so a suspended-but-un-onboarded consumer lands on /suspended, not /onboarding", async () => {
    signedIn();
    mocks.maybeSingle.mockResolvedValue({
      data: { onboarded_at: null, is_suspended: true },
      error: null,
    });

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/suspended?type=account");
  });

  it("does not touch an unsuspended consumer (the negative case)", async () => {
    signedIn();
    mocks.maybeSingle.mockResolvedValue({
      data: { onboarded_at: "2026-07-01T00:00:00.000Z", is_suspended: false },
      error: null,
    });

    await expect(renderLayout()).resolves.toBeDefined();
  });
});
