import type * as React from "react";

import { describe, expect, it, vi, beforeEach } from "vitest";

// The business portal's session/membership/suspension gates. Membership
// enforcement already lived here (doc 12: claims are hints, tables are
// truth); this suite adds the suspension gate (doc 30 section 2.8) - a
// suspended business's `businesses.status='suspended'` blocked nothing here
// before this change, so every portal screen kept working for its staff.

vi.mock("server-only", () => ({}));

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
  resolvePortalContext: vi.fn(),
  resolveReviewerContext: vi.fn(),
  countPendingReview: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
  }),
}));

vi.mock("@/features/businesses/server/portal-context", () => ({
  resolvePortalContext: mocks.resolvePortalContext,
  initialsOf: (name: string | null) => (name === null ? null : name.slice(0, 1)),
}));

vi.mock("@/features/receipts/review/access", () => ({
  resolveReviewerContext: mocks.resolveReviewerContext,
}));

vi.mock("@/features/receipts/review/queue", () => ({
  countPendingReview: mocks.countPendingReview,
}));

vi.mock("@/components/business/portal-shell", () => ({
  PortalShell: () => null,
}));

const PortalLayout = (await import("./layout")).default;

const USER_ID = "11111111-1111-4111-8111-111111111111";

function signedIn(): void {
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
}

function signedOut(): void {
  mocks.getUser.mockResolvedValue({ data: { user: null } });
}

function portalOf(status: string) {
  return {
    business: { id: "biz-1", slug: "biz-1", name: "Biz One", status },
    displayName: "Owner",
  };
}

async function renderLayout(): Promise<React.ReactElement> {
  return PortalLayout({ children: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveReviewerContext.mockResolvedValue(null);
  mocks.countPendingReview.mockResolvedValue(null);
});

describe("business portal suspension gate (doc 30 section 2.8)", () => {
  it("CRITICAL: redirects a suspended business's staff to /suspended", async () => {
    signedIn();
    mocks.resolvePortalContext.mockResolvedValue(portalOf("suspended"));

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/suspended?type=business");
  });

  it("does not touch an active business's staff (the negative case)", async () => {
    signedIn();
    mocks.resolvePortalContext.mockResolvedValue(portalOf("active"));

    await expect(renderLayout()).resolves.toBeDefined();
  });

  it("does not touch a pending_verification business's staff", async () => {
    signedIn();
    mocks.resolvePortalContext.mockResolvedValue(portalOf("pending_verification"));

    await expect(renderLayout()).resolves.toBeDefined();
  });
});

describe("business portal layout - unaffected existing behaviour", () => {
  it("sends an unauthenticated caller to /login", async () => {
    signedOut();

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mocks.resolvePortalContext).not.toHaveBeenCalled();
  });

  it("sends a signed-in caller with no membership to /business/onboarding", async () => {
    signedIn();
    mocks.resolvePortalContext.mockResolvedValue(null);

    await expect(renderLayout()).rejects.toThrow("NEXT_REDIRECT:/business/onboarding");
  });
});
