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
      data: { onboarded_at: "2026-07-01T00:00:00.000Z" },
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
