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

// ===========================================================================
// THE UNAPPROVED-PORTAL RULE (G1 section 3).
//
// A business that has not been approved yet has FULL portal access. That is a
// product decision and not an accident: the portal is where a merchant builds
// its profile, menu, promos and rewards WHILE it waits for review. Approval
// controls the STOREFRONT, and that control is `status = 'active'` in
// src/features/businesses/server/public-repo.ts - proven separately in
// public-repo.test.ts, which is the suite that must stay green for this one to
// be safe.
//
// THESE ASSERTIONS EXIST TO STOP A TIDY-UP. This layout used to carry
//
//   if (portal.business.status === "pending") redirect("/business/pending-approval");
//
// and "pending" is not a status this system has. `businesses_status_check`
// allows exactly ('draft','pending_verification','active','suspended',
// 'closed'), so the branch could never fire and the unapproved merchant got
// into the portal by accident. The obvious "fix" - correcting the comparison to
// `pending_verification`, or widening it to also catch `draft` - would lock
// every unapproved merchant out of the product. It turns these tests red
// instead.
//
// The status list below is written out as literals rather than imported from
// the code under test: it is a transcription of the live check constraint, so
// it can disagree with the application, which is the entire point of it.
// ===========================================================================
const LIVE_BUSINESS_STATUSES = [
  "draft",
  "pending_verification",
  "active",
  "suspended",
  "closed",
] as const;

/** What `register_business` creates, and what "submit for review" moves it to. */
const UNAPPROVED_STATUSES = ["draft", "pending_verification"] as const;

describe("unapproved businesses keep full portal access (G1 section 3)", () => {
  for (const status of UNAPPROVED_STATUSES) {
    it(`CRITICAL: renders the portal for a ${status} business instead of redirecting it away`, async () => {
      signedIn();
      mocks.resolvePortalContext.mockResolvedValue(portalOf(status));

      // Not `resolves.toBeDefined()` alone: a redirect throws, so this asserts
      // the layout got all the way to a rendered tree for a merchant nobody
      // has approved yet.
      await expect(renderLayout()).resolves.toBeDefined();
    });
  }

  it("CRITICAL: never redirects any live status to /business/pending-approval", async () => {
    for (const status of LIVE_BUSINESS_STATUSES) {
      vi.clearAllMocks();
      mocks.resolveReviewerContext.mockResolvedValue(null);
      mocks.countPendingReview.mockResolvedValue(null);
      signedIn();
      mocks.resolvePortalContext.mockResolvedValue(portalOf(status));

      // `.catch` rather than a try/catch: `suspended` legitimately redirects,
      // and what is asserted is the DESTINATION of whatever happened, not that
      // nothing happened.
      const outcome = await renderLayout().then(
        () => null,
        (error: unknown) => (error instanceof RedirectError ? error.to : null),
      );

      expect(outcome, `status ${status} redirected to the approval waiting room`).not.toBe(
        "/business/pending-approval",
      );
    }
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
