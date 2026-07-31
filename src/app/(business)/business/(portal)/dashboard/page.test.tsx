import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ===========================================================================
// THE FENCE AROUND THE DASHBOARD'S HONESTY.
//
// This page used to render `MOCK_KPIS`, `MOCK_WEEK_VISITS` and `MOCK_ACTIVITY`
// from src/lib/mock/business.ts. A merchant who had just signed up and had an
// empty database was told they had 128 visits, +12% vs last week, 4,320 points
// issued, and that "Mia Santos scanned a receipt for PHP 180" eighteen minutes
// ago. None of those people exist. None of those numbers were theirs.
//
// Every test below is one of the ways that must never come back.
// ===========================================================================

const mocks = vi.hoisted(() => ({
  resolvePortalContext: vi.fn(),
  loadBusinessDashboard: vi.fn(),
  resolveReviewerContext: vi.fn(),
  countPendingReview: vi.fn(),
  loadActivationFacts: vi.fn(),
  getBaseRule: vi.fn(),
}));

vi.mock("@/features/businesses/server/portal-context", () => ({
  resolvePortalContext: mocks.resolvePortalContext,
  initialsOf: (name: string | null) => (name === null ? null : name.slice(0, 1)),
}));

vi.mock("@/features/analytics/server/dashboard", () => ({
  loadBusinessDashboard: mocks.loadBusinessDashboard,
}));

vi.mock("@/features/receipts/review/access", () => ({
  resolveReviewerContext: mocks.resolveReviewerContext,
}));

vi.mock("@/features/receipts/review/queue", () => ({
  countPendingReview: mocks.countPendingReview,
  PENDING_COUNT_CAP: 99,
}));

// The activation slice. The FACTS are mocked; the presenter, the checklist and
// the go-live card are the real ones, because the point of these tests is that
// the dashboard says true things and a stubbed card would say whatever the stub
// said. The two server-action modules the card imports are stubbed instead:
// they exist to be called on a click, and importing them for real drags the
// whole server env into a render test.
vi.mock("@/features/businesses/activation/server/state", () => ({
  loadActivationFacts: mocks.loadActivationFacts,
}));

vi.mock("@/features/campaigns/server/repo", () => ({
  getBaseRule: mocks.getBaseRule,
}));

vi.mock("@/features/businesses/activation/actions", () => ({
  submitForReviewAction: vi.fn(),
}));

vi.mock("@/features/campaigns/actions", () => ({
  upsertBaseRule: vi.fn(),
}));

const DashboardPage = (await import("./page")).default;

const BUSINESS_ID = "3f1b0d9c-4444-4444-8444-444444444444";

/** Every string the deleted fixtures put on this page. */
const FIXTURE_STRINGS = [
  "Ramon Dela Cruz",
  "Mia Santos",
  "Carlo Reyes",
  "Jenny Aquino",
  "Paolo Cruz",
  "Ana Villanueva",
  "128",
  "4,320",
  "+12% vs last week",
];

const EMPTY_DASHBOARD = {
  kpis: [
    { label: "Visits, last 7 days", value: "0", delta: { text: "No comparison yet", tone: "muted" } },
    {
      label: "Points issued, last 7 days",
      value: "0",
      delta: { text: "No comparison yet", tone: "muted" },
    },
    {
      label: "Redemptions, last 7 days",
      value: "0",
      delta: { text: "No comparison yet", tone: "muted" },
    },
    {
      label: "Customers, all time",
      value: "0",
      delta: { text: "No new customers in the last 7 days", tone: "muted" },
    },
  ],
  visitsByDay: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => ({ day, value: 0 })),
  visitsChartLabel: "Visits per day for the last 7 days, no visits recorded yet",
  activity: [],
  ledgerCapped: false,
};

const BUSY_DASHBOARD = {
  kpis: [
    { label: "Visits, last 7 days", value: "31", delta: { text: "+24% vs previous 7 days", tone: "trend" } },
    {
      label: "Points issued, last 7 days",
      value: "1,205",
      delta: { text: "-8% vs previous 7 days", tone: "trend" },
    },
    { label: "Redemptions, last 7 days", value: "9", delta: { text: "No comparison yet", tone: "muted" } },
    {
      label: "Customers, all time",
      value: "57",
      delta: { text: "+4 in the last 7 days", tone: "trend" },
    },
  ],
  visitsByDay: [
    { day: "Mon", value: 3 },
    { day: "Tue", value: 5 },
    { day: "Wed", value: 4 },
    { day: "Thu", value: 6 },
    { day: "Fri", value: 7 },
    { day: "Sat", value: 4 },
    { day: "Sun", value: 2 },
  ],
  visitsChartLabel: "Visits per day for the last 7 days, highest Friday",
  activity: [
    {
      id: "earn-txn-1",
      icon: "document_scanner",
      text: "Ana Bautista earned 25 points",
      timeLabel: "30 min ago",
    },
    {
      id: "redeem-claim-1",
      icon: "redeem",
      text: "Noel Tiu redeemed Free medium brew",
      timeLabel: "2 hours ago",
    },
  ],
  ledgerCapped: false,
};

async function renderDashboard(): Promise<HTMLElement> {
  const { container } = render(await DashboardPage());
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolvePortalContext.mockResolvedValue({
    business: { id: BUSINESS_ID, slug: "kape-diaria", name: "Kape Diaria", status: "active" },
    displayName: "Karla Mendoza",
  });
  mocks.resolveReviewerContext.mockResolvedValue({
    userId: "user-1",
    businessId: BUSINESS_ID,
    businessName: "Kape Diaria",
    role: "owner",
  });
  mocks.countPendingReview.mockResolvedValue(0);
  mocks.loadBusinessDashboard.mockResolvedValue(EMPTY_DASHBOARD);
  // The default tenant on this page is LIVE, so activation renders nothing and
  // every assertion below is about the numbers, exactly as it was before the
  // activation slice existed. The draft cases have their own describe block.
  mocks.loadActivationFacts.mockResolvedValue({
    businessId: BUSINESS_ID,
    status: "active",
    hasEarningRule: true,
    hasMenuItem: true,
    hasStorefrontDetails: true,
    latestRound: null,
  });
  mocks.getBaseRule.mockResolvedValue(null);
});

// ---------------------------------------------------------------- tenancy

describe("tenancy", () => {
  it("reads metrics for the business resolved from the caller's membership, and nothing else", async () => {
    await renderDashboard();
    expect(mocks.loadBusinessDashboard).toHaveBeenCalledTimes(1);
    expect(mocks.loadBusinessDashboard).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it("asks for no metrics at all when the caller has no business", async () => {
    mocks.resolvePortalContext.mockResolvedValue(null);
    await renderDashboard();
    expect(mocks.loadBusinessDashboard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- fixtures

describe("no fixture may reach the screen", () => {
  it("CRITICAL: renders none of the deleted fixture strings for an empty database", async () => {
    const container = await renderDashboard();
    for (const fixture of FIXTURE_STRINGS) {
      expect(container.textContent ?? "").not.toContain(fixture);
    }
  });

  it("CRITICAL: renders none of them for a busy business either", async () => {
    mocks.loadBusinessDashboard.mockResolvedValue(BUSY_DASHBOARD);
    const container = await renderDashboard();
    for (const fixture of FIXTURE_STRINGS) {
      expect(container.textContent ?? "").not.toContain(fixture);
    }
  });
});

// ---------------------------------------------------------------- empty state

describe("a business with no data yet", () => {
  it("shows real zeros rather than an invented headline", async () => {
    await renderDashboard();
    expect(screen.getByText("Visits, last 7 days")).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(4);
  });

  it("CRITICAL: shows no percentage change anywhere, because there is no history to compare", async () => {
    const container = await renderDashboard();
    expect(container.textContent ?? "").not.toContain("%");
    expect(screen.getAllByText("No comparison yet").length).toBe(3);
  });

  it("draws a chart of seven honest zeros", async () => {
    await renderDashboard();
    expect(
      screen.getByRole("img", { name: "Visits per day for the last 7 days, no visits recorded yet" }),
    ).toBeInTheDocument();
  });

  it("says the activity feed is empty instead of inventing a feed", async () => {
    await renderDashboard();
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- real data

describe("a business with real data", () => {
  beforeEach(() => {
    mocks.loadBusinessDashboard.mockResolvedValue(BUSY_DASHBOARD);
  });

  it("renders the real KPI figures", async () => {
    await renderDashboard();
    expect(screen.getByText("31")).toBeInTheDocument();
    expect(screen.getByText("1,205")).toBeInTheDocument();
    expect(screen.getByText("57")).toBeInTheDocument();
  });

  it("renders the real week-over-week comparisons where they exist", async () => {
    await renderDashboard();
    expect(screen.getByText("+24% vs previous 7 days")).toBeInTheDocument();
    expect(screen.getByText("-8% vs previous 7 days")).toBeInTheDocument();
  });

  it("still says nothing rather than fabricating a comparison for the metric that has no history", async () => {
    await renderDashboard();
    expect(screen.getByText("No comparison yet")).toBeInTheDocument();
  });

  it("renders the real activity feed", async () => {
    await renderDashboard();
    expect(screen.getByText("Ana Bautista earned 25 points")).toBeInTheDocument();
    expect(screen.getByText("Noel Tiu redeemed Free medium brew")).toBeInTheDocument();
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
  });

  it("uses the real chart description", async () => {
    await renderDashboard();
    expect(
      screen.getByRole("img", { name: "Visits per day for the last 7 days, highest Friday" }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- failure

describe("when the metrics could not be read", () => {
  beforeEach(() => {
    mocks.loadBusinessDashboard.mockResolvedValue(null);
  });

  it("says so instead of printing zeros it cannot prove", async () => {
    await renderDashboard();
    expect(screen.getByText("Your numbers are not available right now")).toBeInTheDocument();
    expect(screen.queryByText("Visits, last 7 days")).not.toBeInTheDocument();
  });

  it("keeps the review queue tile, which is read separately", async () => {
    mocks.countPendingReview.mockResolvedValue(3);
    await renderDashboard();
    expect(screen.getByText("Receipts to review")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- review tile

describe("the review queue tile is untouched", () => {
  it("renders for a reviewer and links to the queue", async () => {
    mocks.countPendingReview.mockResolvedValue(4);
    await renderDashboard();
    const link = screen.getByRole("link", { name: /Receipts to review/ });
    expect(link).toHaveAttribute("href", "/business/receipts");
  });

  it("is absent for a role that cannot review receipts", async () => {
    mocks.resolveReviewerContext.mockResolvedValue(null);
    await renderDashboard();
    expect(screen.queryByText("Receipts to review")).not.toBeInTheDocument();
    expect(mocks.countPendingReview).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- activation
//
// THE SILENT DEAD END, AND THE FENCE AGAINST IT COMING BACK.
//
// Before migration 0033 and the go-live card, a merchant who finished
// onboarding sat at `businesses.status='draft'` forever. Every consumer read
// filters `status='active'`, so their customers could not scan for them, they
// could not be found on /home, and their public page did not resolve. Nothing
// errored. Nothing on this dashboard said a word about it.
//
// Every test below is one of the ways that must never come back.

const DRAFT_FACTS = {
  businessId: BUSINESS_ID,
  status: "draft" as const,
  hasEarningRule: false,
  hasMenuItem: false,
  hasStorefrontDetails: false,
  latestRound: null,
};

describe("a draft business is told it is not live", () => {
  beforeEach(() => {
    mocks.loadActivationFacts.mockResolvedValue(DRAFT_FACTS);
  });

  it("CRITICAL: says the business is not shown to customers", async () => {
    const container = await renderDashboard();
    expect(container.textContent ?? "").toContain("not shown to customers");
  });

  it("CRITICAL: names the earning rule as the thing that is blocking, and marks it required", async () => {
    await renderDashboard();
    expect(screen.getByText("Set how customers earn points")).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
  });

  it("puts the earning-rule editor on this page, not behind a link to another one", async () => {
    await renderDashboard();
    expect(screen.getByLabelText("Rule type")).toBeInTheDocument();
  });

  it("does not offer to send for review while a required item is undone", async () => {
    await renderDashboard();
    expect(screen.queryByRole("button", { name: "Send for review" })).not.toBeInTheDocument();
  });

  it("offers to send for review once the required item is done", async () => {
    mocks.loadActivationFacts.mockResolvedValue({ ...DRAFT_FACTS, hasEarningRule: true });
    await renderDashboard();
    expect(screen.getByRole("button", { name: "Send for review" })).toBeInTheDocument();
  });

  it("marks the menu and storefront items as recommended, never as required", async () => {
    await renderDashboard();
    expect(screen.getByText("Add what you sell")).toBeInTheDocument();
    expect(screen.getAllByText("Recommended").length).toBe(2);
    expect(screen.getAllByText("Required").length).toBe(1);
  });
});

describe("a business that was sent back", () => {
  it("CRITICAL: shows the admin's reason verbatim", async () => {
    mocks.loadActivationFacts.mockResolvedValue({
      ...DRAFT_FACTS,
      hasEarningRule: true,
      latestRound: {
        id: "round-1",
        status: "rejected" as const,
        decisionReason: "The address on the permit does not match the listing.",
        decidedAt: "2026-07-30T02:00:00.000Z",
        createdAt: "2026-07-29T02:00:00.000Z",
      },
    });

    await renderDashboard();
    expect(
      screen.getByText("The address on the permit does not match the listing."),
    ).toBeInTheDocument();
  });
});

describe("a business under review", () => {
  beforeEach(() => {
    mocks.loadActivationFacts.mockResolvedValue({
      ...DRAFT_FACTS,
      status: "pending_verification" as const,
      hasEarningRule: true,
      latestRound: {
        id: "round-1",
        status: "pending" as const,
        decisionReason: null,
        decidedAt: null,
        createdAt: "2026-07-29T02:00:00.000Z",
      },
    });
  });

  it("says the submission is with the Giya team and offers no button", async () => {
    await renderDashboard();
    expect(screen.getByText("With the Giya team")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send for review" })).not.toBeInTheDocument();
  });

  it("does not claim documents are under review, because none were ever uploaded", async () => {
    const container = await renderDashboard();
    expect(container.textContent ?? "").not.toContain("documents are under review");
  });
});

describe("an active business", () => {
  it("gets no banner and no checklist at all", async () => {
    await renderDashboard();
    expect(screen.queryByText("Before customers can find you")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("when the activation state could not be read", () => {
  it("CRITICAL: renders no checklist rather than one assembled from a failed query", async () => {
    mocks.loadActivationFacts.mockResolvedValue(null);
    await renderDashboard();
    expect(screen.queryByText("Before customers can find you")).not.toBeInTheDocument();
    expect(screen.queryByText("Set how customers earn points")).not.toBeInTheDocument();
  });
});
