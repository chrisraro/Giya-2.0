// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Page insights, and the one defect this suite exists to make impossible.
// =============================================================================
//
// EMPTY IS NOT FAILED. A merchant reads these tiles and decides where to spend
// their week. A tile that renders 0 because Meta did not report the metric is
// not a blank tile, it is a false report that their reach collapsed. So the
// two cases are structurally different in the type (`{kind:'value'}` versus
// `{kind:'unreported'}`), and the two assertions below are a PAIR: one that a
// missing metric never becomes a zero, one that a genuine zero never becomes
// "not reported". Either alone can be satisfied by a constant.
//
// The other half of the suite is the six degraded states from the brief. None
// of them needs a live Meta app, which is exactly why they are the ones that
// ship first.

vi.mock("server-only", () => ({}));

const serverEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({ env: {}, getServerEnv: () => serverEnv }));

const cipherMock = vi.hoisted(() => ({ isTokenCipherConfigured: vi.fn(() => true) }));
vi.mock("@/lib/crypto/token-cipher", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/crypto/token-cipher")>("@/lib/crypto/token-cipher");
  return { ...actual, isTokenCipherConfigured: cipherMock.isTokenCipherConfigured };
});

const metaMock = vi.hoisted(() => ({ debugToken: vi.fn(), readPageInsights: vi.fn() }));
vi.mock("@/lib/integrations/meta", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/integrations/meta")>("@/lib/integrations/meta");
  return {
    ...actual,
    debugToken: metaMock.debugToken,
    readPageInsights: metaMock.readPageInsights,
  };
});

const tokensMock = vi.hoisted(() => ({ withPageToken: vi.fn() }));
vi.mock("./tokens", () => tokensMock);

const repoMock = vi.hoisted(() => ({ listConnections: vi.fn() }));
vi.mock("./repo", () => repoMock);

import { MetaError } from "@/lib/integrations/meta";

import type { MetaConnectionView } from "../types";
import { INSIGHT_TILES, loadInsightsView } from "./insights";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "cccccccc-1111-4111-8111-111111111111";

/** Hand-written, so it can disagree with META_V1_SCOPES. */
const FULL_GRANT = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
  "pages_manage_posts",
];
/** A merchant who unticked "read insights" on Meta's consent screen. */
const NO_INSIGHTS_GRANT = ["pages_show_list", "pages_read_engagement", "instagram_basic"];

function connection(overrides: Partial<MetaConnectionView> = {}): MetaConnectionView {
  return {
    id: CONNECTION,
    status: "connected",
    externalAccountId: "1001",
    externalAccountName: "Kape Cebu",
    scopes: [...FULL_GRANT],
    tokenExpiresAt: null,
    lastSyncedAt: null,
    error: null,
    connectedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

function tokenWorks(): void {
  tokensMock.withPageToken.mockImplementation(
    async (_i: unknown, run: (token: string) => Promise<unknown>) => ({
      ok: true,
      data: await run("EAAGlive-page-token"),
    }),
  );
}

/** One metric series in the shape `readPageInsights` returns. */
function series(name: string, value: number | Record<string, number>) {
  return {
    name,
    period: "days_28",
    title: null,
    values: [{ value, endTime: "2026-08-18T07:00:00+0000" }],
  };
}

const ALL_FOUR = [
  series("page_impressions", 4820),
  series("page_impressions_unique", 3110),
  series("page_post_engagements", 264),
  series("page_views_total", 91),
];

beforeEach(() => {
  vi.clearAllMocks();
  serverEnv.META_APP_ID = "1234567890";
  serverEnv.META_APP_SECRET = "test-app-secret-value";
  cipherMock.isTokenCipherConfigured.mockReturnValue(true);
  repoMock.listConnections.mockResolvedValue([connection()]);
  tokenWorks();
  metaMock.debugToken.mockResolvedValue({ isValid: true, scopes: FULL_GRANT, expiresAt: null });
  metaMock.readPageInsights.mockResolvedValue(ALL_FOUR);
});

describe("the tile registry is fixed prose, not derived from Meta's metric names", () => {
  it("names four tiles, in order, with the labels a merchant reads", () => {
    // Literals on the expected side. A label built by prettifying
    // `page_impressions_unique` would render "Page Impressions Unique", which
    // is Meta's vocabulary and not a merchant's.
    expect(INSIGHT_TILES.map((tile) => [tile.metric, tile.label])).toEqual([
      ["page_impressions", "Impressions"],
      ["page_impressions_unique", "People reached"],
      ["page_post_engagements", "Post engagements"],
      ["page_views_total", "Page views"],
    ]);
  });
});

describe("the deployment-wide degraded states (brief states 1, 2, 3)", () => {
  it("state 1: not configured on this deployment, and no Meta call is made", async () => {
    delete serverEnv.META_APP_ID;
    delete serverEnv.META_APP_SECRET;

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.state).toBe("not_configured");
    expect(view.pages).toEqual([]);
    expect(metaMock.readPageInsights).not.toHaveBeenCalled();
  });

  it("state 2: token storage unconfigured, reported separately from state 1", async () => {
    cipherMock.isTokenCipherConfigured.mockReturnValue(false);

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.state).toBe("storage_unavailable");
    expect(view.pages).toEqual([]);
  });

  it("state 3: no connection at all", async () => {
    repoMock.listConnections.mockResolvedValue([]);

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.state).toBe("not_connected");
    expect(view.pages).toEqual([]);
    expect(metaMock.readPageInsights).not.toHaveBeenCalled();
  });

  it("carries the period the tiles actually describe", async () => {
    const view = await loadInsightsView({ businessId: BUSINESS });
    expect(view.periodLabel).toBe("Last 28 days");
  });
});

describe("the per-Page degraded states (brief states 4, 5, 6)", () => {
  it("state 4: an expired connection prompts a reconnect and is never read", async () => {
    repoMock.listConnections.mockResolvedValue([connection({ status: "expired" })]);

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.pages).toEqual([
      {
        connectionId: CONNECTION,
        pageName: "Kape Cebu",
        capability: "needs_reconnect",
        tiles: [],
      },
    ]);
    expect(metaMock.readPageInsights).not.toHaveBeenCalled();
  });

  it("state 4: a revoked connection does the same", async () => {
    repoMock.listConnections.mockResolvedValue([connection({ status: "revoked" })]);

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.pages[0]?.capability).toBe("needs_reconnect");
    expect(view.pages[0]?.tiles).toEqual([]);
  });

  it("state 5: an open circuit yields NO tiles rather than empty ones", async () => {
    metaMock.readPageInsights.mockRejectedValue(
      new MetaError("META_CIRCUIT_OPEN", "The Meta integration is temporarily unavailable.", {
        retryable: true,
      }),
    );

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.pages[0]?.capability).toBe("unavailable");
    // Four tiles reading 0 would be the exact defect. Nothing is rendered.
    expect(view.pages[0]?.tiles).toEqual([]);
  });

  it("state 5: an open circuit before the scope check does the same", async () => {
    metaMock.debugToken.mockRejectedValue(
      new MetaError("META_CIRCUIT_OPEN", "The Meta integration is temporarily unavailable.", {
        retryable: true,
      }),
    );

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.pages[0]?.capability).toBe("unavailable");
    expect(metaMock.readPageInsights).not.toHaveBeenCalled();
  });

  it("state 6: a token without read_insights is scope_missing and is never read", async () => {
    metaMock.debugToken.mockResolvedValue({
      isValid: true,
      scopes: NO_INSIGHTS_GRANT,
      expiresAt: null,
    });

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.pages[0]?.capability).toBe("scope_missing");
    expect(view.pages[0]?.tiles).toEqual([]);
    // Spending a Graph call to be refused is a circuit-breaker failure charged
    // to every other tenant on the platform.
    expect(metaMock.readPageInsights).not.toHaveBeenCalled();
  });

  it("state 6 is decided on the TOKEN, not on the row's recorded scopes", async () => {
    repoMock.listConnections.mockResolvedValue([connection({ scopes: [...FULL_GRANT] })]);
    metaMock.debugToken.mockResolvedValue({
      isValid: true,
      scopes: NO_INSIGHTS_GRANT,
      expiresAt: null,
    });

    const view = await loadInsightsView({ businessId: BUSINESS });
    expect(view.pages[0]?.capability).toBe("scope_missing");
  });

  it("a Meta rejection of the credential during the read prompts a reconnect", async () => {
    metaMock.readPageInsights.mockRejectedValue(
      new MetaError("META_AUTH_FAILED", "Meta rejected the stored credential.", {
        retryable: false,
        status: 400,
        providerCode: 190,
      }),
    );

    const view = await loadInsightsView({ businessId: BUSINESS });
    expect(view.pages[0]?.capability).toBe("needs_reconnect");
  });
});

describe("EMPTY IS NOT FAILED", () => {
  it("reads the four metrics into their tiles when Meta reports them all", async () => {
    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.state).toBe("pages");
    expect(view.pages[0]?.capability).toBe("ready");
    expect(view.pages[0]?.tiles).toEqual([
      { metric: "page_impressions", label: "Impressions", reading: { kind: "value", value: 4820 } },
      {
        metric: "page_impressions_unique",
        label: "People reached",
        reading: { kind: "value", value: 3110 },
      },
      {
        metric: "page_post_engagements",
        label: "Post engagements",
        reading: { kind: "value", value: 264 },
      },
      { metric: "page_views_total", label: "Page views", reading: { kind: "value", value: 91 } },
    ]);
  });

  it("CRITICAL: a metric Meta did not report is 'unreported', NEVER a zero", async () => {
    // Meta drops metrics it cannot serve rather than returning them at 0. A
    // tile that fills that gap with 0 tells the merchant their reach was zero.
    metaMock.readPageInsights.mockResolvedValue([
      series("page_impressions", 4820),
      series("page_views_total", 91),
    ]);

    const view = await loadInsightsView({ businessId: BUSINESS });
    const tiles = view.pages[0]?.tiles ?? [];

    expect(tiles.find((t) => t.metric === "page_impressions_unique")?.reading).toEqual({
      kind: "unreported",
    });
    expect(tiles.find((t) => t.metric === "page_post_engagements")?.reading).toEqual({
      kind: "unreported",
    });
    // The ones that WERE reported are untouched, so this is not "give up on
    // the whole Page because one metric was absent".
    expect(tiles.find((t) => t.metric === "page_impressions")?.reading).toEqual({
      kind: "value",
      value: 4820,
    });
  });

  it("CRITICAL: a metric Meta reported AS ZERO is a zero, not 'unreported'", async () => {
    // The pairing assertion. Without it, a rule of "treat falsy as unreported"
    // passes the test above and hides a real, legitimate zero behind "we could
    // not read this" - the same defect pointing the other way.
    metaMock.readPageInsights.mockResolvedValue([
      series("page_impressions", 0),
      series("page_impressions_unique", 0),
      series("page_post_engagements", 0),
      series("page_views_total", 0),
    ]);

    const view = await loadInsightsView({ businessId: BUSINESS });
    const tiles = view.pages[0]?.tiles ?? [];

    expect(tiles.map((t) => t.reading)).toEqual([
      { kind: "value", value: 0 },
      { kind: "value", value: 0 },
      { kind: "value", value: 0 },
      { kind: "value", value: 0 },
    ]);
  });

  it("treats a metric with an empty series as unreported", async () => {
    metaMock.readPageInsights.mockResolvedValue([
      { name: "page_impressions", period: "days_28", title: null, values: [] },
      ...ALL_FOUR.slice(1),
    ]);

    const view = await loadInsightsView({ businessId: BUSINESS });
    expect(view.pages[0]?.tiles[0]?.reading).toEqual({ kind: "unreported" });
  });

  it("treats a breakdown object as unreported rather than summing it into a number", async () => {
    // Some Meta metrics answer with `{"organic": 12, "paid": 3}`. Adding those
    // up would invent a figure Meta never stated, under the label of one it
    // did.
    metaMock.readPageInsights.mockResolvedValue([
      series("page_impressions", { organic: 12, paid: 3 }),
      ...ALL_FOUR.slice(1),
    ]);

    const view = await loadInsightsView({ businessId: BUSINESS });
    expect(view.pages[0]?.tiles[0]?.reading).toEqual({ kind: "unreported" });
  });

  it("reads the LATEST point in a series, not the first", async () => {
    metaMock.readPageInsights.mockResolvedValue([
      {
        name: "page_impressions",
        period: "days_28",
        title: null,
        values: [
          { value: 100, endTime: "2026-07-21T07:00:00+0000" },
          { value: 4820, endTime: "2026-08-18T07:00:00+0000" },
        ],
      },
      ...ALL_FOUR.slice(1),
    ]);

    const view = await loadInsightsView({ businessId: BUSINESS });
    expect(view.pages[0]?.tiles[0]?.reading).toEqual({ kind: "value", value: 4820 });
  });
});

describe("insights never take down the page they sit on (doc 42)", () => {
  it("does not throw when the connection read fails", async () => {
    repoMock.listConnections.mockRejectedValue(new Error("PostgREST is having a day"));

    await expect(loadInsightsView({ businessId: BUSINESS })).resolves.toMatchObject({
      state: "not_connected",
      pages: [],
    });
  });

  it("does not throw on an unrecognised exception from the boundary", async () => {
    metaMock.readPageInsights.mockRejectedValue(new TypeError("fetch failed"));

    const view = await loadInsightsView({ businessId: BUSINESS });
    expect(view.pages[0]?.capability).toBe("unavailable");
  });

  it("reports each connected Page independently", async () => {
    repoMock.listConnections.mockResolvedValue([
      connection({ id: "aaaaaaaa-1111-4111-8111-111111111111", externalAccountName: "Kape Cebu" }),
      connection({ id: "bbbbbbbb-1111-4111-8111-111111111111", externalAccountName: null }),
    ]);
    metaMock.debugToken
      .mockResolvedValueOnce({ isValid: true, scopes: FULL_GRANT, expiresAt: null })
      .mockResolvedValueOnce({ isValid: true, scopes: NO_INSIGHTS_GRANT, expiresAt: null });

    const view = await loadInsightsView({ businessId: BUSINESS });

    expect(view.pages[0]?.capability).toBe("ready");
    expect(view.pages[1]?.capability).toBe("scope_missing");
    // A Page with no name falls back to its id, which is public anyway.
    expect(view.pages[1]?.pageName).toBe("1001");
  });
});
