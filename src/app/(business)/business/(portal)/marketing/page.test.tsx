import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// G2 SECTION 3: A MERCHANT NOBODY HAS APPROVED YET GETS THE META SURFACES.
// =============================================================================
//
// The whole point of the brief. A business at `draft` (what `register_business`
// creates) or `pending_verification` (what submitting for review sets) must
// reach this screen and read its Facebook figures WHILE it waits, because
// building the shop is what the waiting period is for.
//
// The named mutant for this file is `G-active-gate`: add
//
//     if (portal.business.status !== "active") redirect("/business/pending-approval");
//
// to the page. Today the page holds no status comparison at all, so these
// assertions pass without exercising a branch - which is exactly the shape of
// the unapproved-portal suite in the layout above, and exactly why the mutant
// has been RUN rather than reasoned about. A guard that would break this is the
// thing being guarded against.
//
// The other half of the claim - that an unapproved storefront stays hidden -
// belongs to `status = 'active'` in
// features/businesses/server/public-repo.ts and is proven in public-repo.test.ts
// and storefront-visibility.test.ts. It is not re-proven here; it is named here
// so the pairing is findable.

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
  resolveStaffContext: vi.fn(),
  resolvePortalContext: vi.fn(),
  loadInsightsView: vi.fn(),
  loadPublishView: vi.fn(),
}));

vi.mock("@/features/businesses/server/resolve-owner-business", () => ({
  resolveStaffContext: mocks.resolveStaffContext,
  BUSINESS_ROLES: ["owner", "manager", "marketing", "staff"],
}));

// Mocked but deliberately available: the mutant that gates this page on
// approval has to read the status from somewhere, and this is where.
vi.mock("@/features/businesses/server/portal-context", () => ({
  resolvePortalContext: mocks.resolvePortalContext,
  initialsOf: (name: string | null) => (name === null ? null : name.slice(0, 1)),
}));

// Only the READS are stubbed. Both panels render for real, because the subject
// of this file is what an unapproved merchant actually SEES, and a stubbed
// panel would show whatever the stub showed. Their own suites are
// features/integrations/meta/components/*.test.tsx.
vi.mock("@/features/integrations/meta/server/insights", () => ({
  loadInsightsView: mocks.loadInsightsView,
}));

vi.mock("@/features/integrations/meta/server/capability", () => ({
  loadPublishView: mocks.loadPublishView,
}));

// The composer's action module is "use server"; stubbed so a jsdom render does
// not drag the server env into its import graph.
vi.mock("@/features/integrations/meta/actions", () => ({
  startMetaConnect: vi.fn(),
  connectMetaPages: vi.fn(),
  disconnectMeta: vi.fn(),
  publishMetaCampaign: vi.fn(),
}));

const MarketingPage = (await import("./page")).default;

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "cccccccc-1111-4111-8111-111111111111";

/**
 * Transcribed from `businesses_status_check`, not imported from the app.
 *
 * The whole value of the list is that it can disagree with the code, so it is
 * typed out. Same reasoning as the portal layout's own suite.
 */
const LIVE_BUSINESS_STATUSES = [
  "draft",
  "pending_verification",
  "active",
  "suspended",
  "closed",
] as const;

/** What `register_business` creates, and what "submit for review" moves it to. */
const UNAPPROVED_STATUSES = ["draft", "pending_verification"] as const;

function staffContext(role = "owner") {
  return { businessId: BUSINESS, userId: "22222222-1111-4111-8111-111111111111", role };
}

function readyInsights() {
  return {
    state: "pages" as const,
    periodLabel: "Last 28 days",
    pages: [
      {
        connectionId: CONNECTION,
        pageName: "Kape Cebu",
        capability: "ready" as const,
        tiles: [
          {
            metric: "page_impressions",
            label: "Impressions",
            reading: { kind: "value" as const, value: 4820 },
          },
        ],
      },
    ],
  };
}

function readyPublish() {
  return {
    state: "pages" as const,
    canManage: true,
    pages: [{ connectionId: CONNECTION, pageName: "Kape Cebu", capability: "ready" as const }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveStaffContext.mockResolvedValue(staffContext());
  mocks.resolvePortalContext.mockResolvedValue({
    business: { id: BUSINESS, slug: "kape-cebu", name: "Kape Cebu", status: "draft" },
    displayName: "Owner",
  });
  mocks.loadInsightsView.mockResolvedValue(readyInsights());
  mocks.loadPublishView.mockResolvedValue(readyPublish());
});

describe("an unapproved business reaches the Meta surfaces (G2 section 3)", () => {
  for (const status of UNAPPROVED_STATUSES) {
    it(`CRITICAL: a ${status} business sees its Facebook figures`, async () => {
      mocks.resolvePortalContext.mockResolvedValue({
        business: { id: BUSINESS, slug: "kape-cebu", name: "Kape Cebu", status },
        displayName: "Owner",
      });

      render(await MarketingPage());

      expect(screen.getByText("Facebook audience and engagement")).toBeInTheDocument();
      expect(screen.getByText("Impressions")).toBeInTheDocument();
      expect(screen.getByText("4,820")).toBeInTheDocument();
    });

    it(`CRITICAL: a ${status} business can reach the campaign composer`, async () => {
      mocks.resolvePortalContext.mockResolvedValue({
        business: { id: BUSINESS, slug: "kape-cebu", name: "Kape Cebu", status },
        displayName: "Owner",
      });

      render(await MarketingPage());

      expect(screen.getByRole("button", { name: "Post to Facebook" })).toBeInTheDocument();
    });
  }

  it("CRITICAL: no live status is turned away from this screen", async () => {
    // The pairing assertion over the whole state machine. Adding a gate for a
    // single status fails here even if someone also updates that status's own
    // test above. `suspended` is blocked by the LAYOUT, not by this page, and
    // that separation is the thing being asserted: a page-level status gate is
    // a second, divergent copy of a rule that already has an owner.
    const redirected: string[] = [];
    for (const status of LIVE_BUSINESS_STATUSES) {
      vi.clearAllMocks();
      mocks.resolveStaffContext.mockResolvedValue(staffContext());
      mocks.resolvePortalContext.mockResolvedValue({
        business: { id: BUSINESS, slug: "kape-cebu", name: "Kape Cebu", status },
        displayName: "Owner",
      });
      mocks.loadInsightsView.mockResolvedValue(readyInsights());
      mocks.loadPublishView.mockResolvedValue(readyPublish());

      const outcome = await MarketingPage().then(
        () => null,
        (error: unknown) => (error instanceof RedirectError ? error.to : "threw"),
      );
      if (outcome !== null) redirected.push(`${status} -> ${outcome}`);
    }

    expect(redirected).toEqual([]);
  });

  it("CRITICAL: the page reads no business status at all", async () => {
    // The structural version of the same claim. A page that never asks for the
    // status cannot gate on it, and this is the assertion that notices the
    // moment somebody starts asking.
    await MarketingPage();
    expect(mocks.resolvePortalContext).not.toHaveBeenCalled();
  });
});

describe("the marketing screen still enforces the things it should", () => {
  it("turns away a role outside doc 32 section 11.1's audience", async () => {
    mocks.resolveStaffContext.mockResolvedValue(null);

    await expect(MarketingPage()).rejects.toThrow("NEXT_REDIRECT:/business/dashboard");
  });

  it("asks for the marketing roles, not the settings pair", async () => {
    await MarketingPage();
    expect(mocks.resolveStaffContext).toHaveBeenCalledWith(["owner", "manager", "marketing"]);
  });

  it("passes the caller's own resolved business id to both reads", async () => {
    // Tenancy. Nothing on this route accepts a business id from anywhere else.
    await MarketingPage();
    expect(mocks.loadInsightsView).toHaveBeenCalledWith({ businessId: BUSINESS });
    expect(mocks.loadPublishView).toHaveBeenCalledWith({
      businessId: BUSINESS,
      canManage: true,
    });
  });
});

describe("a dormant Meta integration does not take the screen down", () => {
  it("renders both panels with their own honest copy and no crash", async () => {
    // The state EVERY deployment is in today: META_APP_ID is unset. This is
    // the path that ships first, so it is asserted as the ordinary case rather
    // than as an edge one.
    mocks.loadInsightsView.mockResolvedValue({
      state: "not_configured",
      pages: [],
      periodLabel: "Last 28 days",
    });
    mocks.loadPublishView.mockResolvedValue({
      state: "not_configured",
      pages: [],
      canManage: true,
    });

    render(await MarketingPage());

    expect(
      screen.getByText("Audience and engagement figures are not available on this deployment yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Posting to a Facebook Page is not available on this deployment yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post to Facebook" })).not.toBeInTheDocument();
  });
});
