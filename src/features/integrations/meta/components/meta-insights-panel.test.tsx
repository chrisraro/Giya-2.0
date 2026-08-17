import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// =============================================================================
// What a merchant actually reads when the numbers are not there.
// =============================================================================
//
// Every degraded-state string below is pinned with a FULL literal, because each
// one makes a claim about WHY the figures are missing and a substring match
// would let the claim change while the test stayed green. `getByText` with a
// string argument is a whole-text-content match after whitespace normalisation,
// which is the pin.
//
// The literals are typed out here rather than imported from copy.ts on purpose.
// An assertion whose expected value comes from the module under test cannot
// disagree with it.

import { MetaInsightsPanel } from "./meta-insights-panel";
import type { MetaInsightTile, MetaInsightsView, MetaPageInsights } from "../types";

function tile(overrides: Partial<MetaInsightTile> = {}): MetaInsightTile {
  return {
    metric: "page_impressions",
    label: "Impressions",
    reading: { kind: "value", value: 4820 },
    ...overrides,
  };
}

function page(overrides: Partial<MetaPageInsights> = {}): MetaPageInsights {
  return {
    connectionId: "cccccccc-1111-4111-8111-111111111111",
    pageName: "Kape Cebu",
    capability: "ready",
    tiles: [
      tile(),
      tile({
        metric: "page_impressions_unique",
        label: "People reached",
        reading: { kind: "value", value: 3110 },
      }),
    ],
    ...overrides,
  };
}

function view(overrides: Partial<MetaInsightsView> = {}): MetaInsightsView {
  return {
    state: "pages",
    pages: [page()],
    periodLabel: "Last 28 days",
    ...overrides,
  };
}

describe("the deployment-wide states each get their own sentence", () => {
  it("says the integration is not available on this deployment", () => {
    render(<MetaInsightsPanel view={view({ state: "not_configured", pages: [] })} />);

    expect(
      screen.getByText("Audience and engagement figures are not available on this deployment yet."),
    ).toBeInTheDocument();
    // Not an error. Nothing is broken; something is not switched on.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says something DIFFERENT when only credential storage is unconfigured", () => {
    // A separate missing variable with a separate fix. A support ticket that
    // reads "not configured" for both is a ticket nobody can act on.
    render(<MetaInsightsPanel view={view({ state: "storage_unavailable", pages: [] })} />);

    expect(
      screen.getByText(
        "Audience and engagement figures are not available yet: secure credential storage is not configured.",
      ),
    ).toBeInTheDocument();
  });

  it("points an unconnected merchant at the screen that connects a Page", () => {
    render(<MetaInsightsPanel view={view({ state: "not_connected", pages: [] })} />);

    expect(
      screen.getByText(
        "Connect a Facebook Page in Settings to see your audience and engagement figures.",
      ),
    ).toBeInTheDocument();
  });

  it("CRITICAL: a failed read says the problem is ours, not that nothing is connected", () => {
    // The seventh degraded state. `not_connected` offers "Connect a Facebook
    // Page in Settings", and during a database wobble that is a remedy which
    // does nothing, aimed at a merchant whose Page is connected and fine.
    render(<MetaInsightsPanel view={view({ state: "read_failed", pages: [] })} />);

    expect(
      screen.getByText(
        "We could not load your connected Pages just now. This one is on our side, and nothing about your connection has changed.",
      ),
    ).toBeInTheDocument();
    // The wrong instruction must not appear.
    expect(screen.queryByText(/Connect a Facebook Page in Settings/)).not.toBeInTheDocument();
  });

  it("CRITICAL: keeps its heading in every state, including the degraded ones", () => {
    // The heading does not depend on `view.state`, so it is written once above
    // the branch. It used to be typed into both arms, where the degraded arm's
    // copy could drift with nothing to catch it: one fact in two places, only
    // one pinned. A card with no heading is also just an anonymous grey panel.
    for (const state of [
      "pages",
      "not_configured",
      "storage_unavailable",
      "not_connected",
      "read_failed",
    ] as const) {
      const { unmount } = render(
        <MetaInsightsPanel
          view={view({ state, pages: state === "pages" ? [page()] : [] })}
        />,
      );
      expect(
        screen.getByRole("heading", { name: "Facebook audience and engagement" }),
        `${state} lost or changed its heading`,
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("CRITICAL: does not name a period when there are no figures to describe", () => {
    // "Last 28 days" beside "not available on this deployment yet" describes a
    // window of numbers that are not there. A mutation run found the label and
    // the body were two independent branches off one discriminant with only the
    // body pinned; this is the assertion that was missing.
    for (const state of [
      "not_configured",
      "storage_unavailable",
      "not_connected",
      "read_failed",
    ] as const) {
      const { unmount } = render(<MetaInsightsPanel view={view({ state, pages: [] })} />);
      expect(screen.queryByText("Last 28 days"), `${state} showed a period`).not.toBeInTheDocument();
      unmount();
    }
  });

  it("renders no tile at all in any of those states", () => {
    for (const state of [
      "not_configured",
      "storage_unavailable",
      "not_connected",
      "read_failed",
    ] as const) {
      const { unmount } = render(<MetaInsightsPanel view={view({ state, pages: [] })} />);
      // A figure of any kind here would be a figure with no source.
      expect(screen.queryByText("Impressions")).not.toBeInTheDocument();
      expect(screen.queryByText("0")).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe("the per-Page states each get their own sentence", () => {
  it("offers reconnecting for a connection whose access ended", () => {
    render(<MetaInsightsPanel view={view({ pages: [page({ capability: "needs_reconnect", tiles: [] })] })} />);

    expect(
      screen.getByText(
        "The access we were given has ended. Reconnect this Page in Settings to bring these figures back.",
      ),
    ).toBeInTheDocument();
  });

  it("CRITICAL: says the permission is missing WITHOUT telling the merchant to retry", () => {
    render(<MetaInsightsPanel view={view({ pages: [page({ capability: "scope_missing", tiles: [] })] })} />);

    expect(
      screen.getByText(
        "This Page's access does not include permission to read insights, so there are no figures to show.",
      ),
    ).toBeInTheDocument();
    // Reconnecting does not add a scope the app has not been approved for, so
    // the word must not appear next to this state.
    expect(screen.queryByText(/Reconnect this Page/)).not.toBeInTheDocument();
  });

  it("says Meta is quiet without blaming the merchant or claiming a figure", () => {
    render(<MetaInsightsPanel view={view({ pages: [page({ capability: "unavailable", tiles: [] })] })} />);

    expect(
      screen.getByText(
        "Facebook is not responding right now. These figures will come back on their own.",
      ),
    ).toBeInTheDocument();
  });

  it("does not offer reconnecting for a credential this build cannot open", () => {
    render(<MetaInsightsPanel view={view({ pages: [page({ capability: "unreadable", tiles: [] })] })} />);

    expect(
      screen.getByText(
        "Giya cannot open the stored credential for this Page. This one is ours to fix, and reconnecting will not help.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Reconnect this Page/)).not.toBeInTheDocument();
  });

  it("CRITICAL: presents none of the per-Page states as an error", () => {
    // Four of these five are "not switched on" or "not right now", and the
    // fifth is ours to fix. A red panel with role=alert on any of them trains
    // a merchant that their Facebook connection is broken, which is the state
    // they then call support about. A mutation run found this untested: the
    // absence of `role="alert"` was asserted only for the deployment-wide
    // states, so the per-Page panel could have turned red unnoticed.
    for (const capability of [
      "needs_reconnect",
      "scope_missing",
      "unavailable",
      "unreadable",
    ] as const) {
      const { unmount } = render(
        <MetaInsightsPanel view={view({ pages: [page({ capability, tiles: [] })] })} />,
      );
      expect(screen.queryByRole("alert"), `${capability} rendered as an alert`).not.toBeInTheDocument();
      unmount();
    }
  });

  it("still names the Page in every degraded state, so the merchant knows which one", () => {
    for (const capability of ["needs_reconnect", "scope_missing", "unavailable", "unreadable"] as const) {
      const { unmount } = render(
        <MetaInsightsPanel view={view({ pages: [page({ capability, tiles: [] })] })} />,
      );
      expect(screen.getByText("Kape Cebu")).toBeInTheDocument();
      unmount();
    }
  });
});

describe("EMPTY IS NOT FAILED, on the screen", () => {
  it("renders a reported figure as a figure", () => {
    render(<MetaInsightsPanel view={view()} />);

    expect(screen.getByText("Impressions")).toBeInTheDocument();
    expect(screen.getByText("4,820")).toBeInTheDocument();
    expect(screen.getByText("People reached")).toBeInTheDocument();
    expect(screen.getByText("3,110")).toBeInTheDocument();
  });

  it("CRITICAL: renders an unreported metric as words, never as 0", () => {
    render(
      <MetaInsightsPanel
        view={view({
          pages: [page({ tiles: [tile({ reading: { kind: "unreported" } })] })],
        })}
      />,
    );

    expect(screen.getByText("Impressions")).toBeInTheDocument();
    expect(screen.getByText("Not reported")).toBeInTheDocument();
    // The defect, stated directly: no zero anywhere on this tile.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("CRITICAL: renders a genuine zero as 0, not as 'Not reported'", () => {
    // The pairing assertion. A panel that printed "Not reported" for every
    // falsy reading would pass the test above and hide a real quiet month.
    render(
      <MetaInsightsPanel
        view={view({
          pages: [page({ tiles: [tile({ reading: { kind: "value", value: 0 } })] })],
        })}
      />,
    );

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("Not reported")).not.toBeInTheDocument();
  });

  it("names the window the figures describe", () => {
    render(<MetaInsightsPanel view={view()} />);
    expect(screen.getByText("Last 28 days")).toBeInTheDocument();
  });

  it("gives an unreported tile an accessible reading, not a bare dash", () => {
    render(
      <MetaInsightsPanel
        view={view({ pages: [page({ tiles: [tile({ reading: { kind: "unreported" } })] })] })}
      />,
    );
    // A screen reader announcing "Impressions, dash" tells nobody anything.
    expect(screen.getByText("Not reported")).toBeVisible();
  });

  it("sets figures in the mono face and the unreported words in prose", () => {
    // Not styling for its own sake. It is the pre-reading signal that this
    // tile is not a measurement, and it was untested until a mutation run said
    // so: the panel used to decide the face and the text in two independent
    // branches off the same discriminant, and only one of them was pinned.
    const { unmount } = render(<MetaInsightsPanel view={view()} />);
    expect(screen.getByText("4,820")).toHaveClass("font-mono");
    unmount();

    render(
      <MetaInsightsPanel
        view={view({ pages: [page({ tiles: [tile({ reading: { kind: "unreported" } })] })] })}
      />,
    );
    expect(screen.getByText("Not reported")).not.toHaveClass("font-mono");
  });

  it("renders a genuine zero in the FIGURE face, not as prose", () => {
    // The pairing half. A rule of "anything falsy is prose" would satisfy the
    // assertion above while setting a real zero in the non-measurement style.
    render(
      <MetaInsightsPanel
        view={view({ pages: [page({ tiles: [tile({ reading: { kind: "value", value: 0 } })] })] })}
      />,
    );
    expect(screen.getByText("0")).toHaveClass("font-mono");
  });
});
