import "server-only";

import {
  META_INSIGHTS_SCOPE,
  MetaError,
  readPageInsights,
  type MetaInsightMetric,
} from "@/lib/integrations/meta";

import { INSIGHTS_PERIOD_LABEL } from "../copy";
import type {
  MetaConnectionCapability,
  MetaInsightTile,
  MetaInsightsView,
  MetaPageInsights,
} from "../types";
import { capabilityFor, pageNameOf, resolveConnections } from "./capability";
import { withPageToken } from "./tokens";

// =============================================================================
// The audience and engagement tiles (doc 42 V1, doc 32 section 11.2).
// =============================================================================
//
// `readPageInsights` has existed and been tested since the connection slice
// landed, called by nothing but its own test. This is the module that calls it.
//
// -----------------------------------------------------------------------------
// THE ONE RULE THIS FILE IS FOR: EMPTY IS NOT FAILED
// -----------------------------------------------------------------------------
//
// A merchant reads these numbers and decides where their week goes. Meta does
// not return a metric it cannot serve; it OMITS it. So the naive mapping
//
//     value = response[metric] ?? 0
//
// renders "0 impressions" for "we could not read impressions", which is not a
// blank tile, it is a false report that their reach collapsed. `reading` is a
// sum type for that reason and not a `number | null`: a component cannot render
// the failure case as the value case without deleting a branch, and deleting a
// branch is a thing a reviewer sees.
//
// The rule cuts both ways and the test suite asserts both directions. A real
// zero is DATA. A rule of "treat falsy as unreported" would hide a genuine
// quiet month behind "we could not read this", which is the same lie pointing
// the other way.
//
// -----------------------------------------------------------------------------
// WHY A METRIC IS NEVER READ WITHOUT THE SCOPE
// -----------------------------------------------------------------------------
//
// `capabilityFor` asks `debug_token` what the token carries before any insights
// call is made. Firing the read anyway and interpreting the refusal would work,
// and would also charge a circuit-breaker failure to every other tenant on the
// platform for a question we could have answered locally. The breaker opens
// after five consecutive failures; one merchant who declined `read_insights` on
// the consent screen should not be able to close the integration for everyone.
//
// -----------------------------------------------------------------------------
// NOTHING HERE THROWS
// -----------------------------------------------------------------------------
//
// Doc 42: insights tiles "never block core loops". This runs inside the render
// of a page that also carries the campaign composer. Every failure is a value.

/** The window every tile describes. `INSIGHTS_PERIOD_LABEL` is its prose. */
const INSIGHTS_PERIOD = "days_28" as const;

/**
 * The four tiles, their Meta metric names, and the words a merchant reads.
 *
 * The labels are WRITTEN, not derived. Prettifying `page_impressions_unique`
 * gives "Page Impressions Unique", which is Meta's vocabulary for an internal
 * counter, not a sentence about somebody's shop. Order is the render order.
 */
export const INSIGHT_TILES = [
  { metric: "page_impressions", label: "Impressions" },
  { metric: "page_impressions_unique", label: "People reached" },
  { metric: "page_post_engagements", label: "Post engagements" },
  { metric: "page_views_total", label: "Page views" },
] as const;

/**
 * Turn Meta's answer into exactly four tiles.
 *
 * ALWAYS FOUR. A metric Meta omitted still gets its tile, reading "unreported",
 * because a tile that silently disappears is a tile the merchant assumes they
 * never had rather than one they could not read this time.
 */
function toTiles(metrics: readonly MetaInsightMetric[]): readonly MetaInsightTile[] {
  const byName = new Map(metrics.map((metric) => [metric.name, metric]));

  return INSIGHT_TILES.map(({ metric, label }) => {
    const series = byName.get(metric);
    // The LAST point. Meta returns the series in ascending time order, and for
    // a `days_28` window the newest point is the one the tile is about.
    const latest = series?.values[series.values.length - 1];

    if (latest === undefined) {
      // Either the metric was omitted entirely, or it came back with an empty
      // series. Both mean the same thing to a merchant: no figure to show.
      return { metric, label, reading: { kind: "unreported" } };
    }

    if (typeof latest.value !== "number") {
      // A breakdown object, e.g. `{"organic": 12, "paid": 3}`. Summing it
      // would put a number under this label that Meta never stated.
      return { metric, label, reading: { kind: "unreported" } };
    }

    // Reached only when Meta reported a number, INCLUDING zero. This is the
    // branch that keeps a real quiet month from reading as a failure.
    return { metric, label, reading: { kind: "value", value: latest.value } };
  });
}

/** Map a failure at the Meta boundary onto the state the merchant is shown. */
function capabilityForReadFailure(error: unknown): MetaConnectionCapability {
  const code = error instanceof MetaError ? error.code : "unknown";
  // The only code that says anything about the CREDENTIAL rather than about
  // Meta's health. Everything else, including a schema surprise, is "we could
  // not read this right now", which claims nothing about the merchant.
  if (code === "META_AUTH_FAILED") return "needs_reconnect";
  console.warn(`[integrations/meta] page insights could not be read (${code})`);
  return "unavailable";
}

/**
 * Every connected Page's tiles, or the honest reason there are none.
 *
 * One entry per Page with its OWN capability: a merchant with two Pages can
 * genuinely have granted `read_insights` on one and declined it on the other,
 * and a single collapsed answer would have to lie about one of them.
 */
export async function loadInsightsView(input: {
  readonly businessId: string;
}): Promise<MetaInsightsView> {
  const resolved = await resolveConnections(input.businessId);
  if (resolved.state !== "pages") {
    return { state: resolved.state, pages: [], periodLabel: INSIGHTS_PERIOD_LABEL };
  }

  const pages: MetaPageInsights[] = [];

  for (const connection of resolved.connections) {
    const capability = await capabilityFor(input.businessId, connection, META_INSIGHTS_SCOPE);

    if (capability !== "ready") {
      // No tiles at all. Four tiles reading zero would be precisely the defect
      // this module is written to prevent.
      pages.push({
        connectionId: connection.id,
        pageName: pageNameOf(connection),
        capability,
        tiles: [],
      });
      continue;
    }

    let tiles: readonly MetaInsightTile[] = [];
    let readCapability: MetaConnectionCapability = "ready";

    try {
      const result = await withPageToken(
        { connectionId: connection.id, businessId: input.businessId },
        // Refresh-on-read lives inside `withPageToken`, so doc 42's "the
        // insights client re-exchanges any token older than 45d before use" is
        // satisfied by calling through it rather than by a scheduled queue.
        (pageAccessToken) =>
          readPageInsights({
            pageId: connection.externalAccountId,
            pageAccessToken,
            metrics: INSIGHT_TILES.map((tile) => tile.metric),
            period: INSIGHTS_PERIOD,
          }),
      );

      if (result.ok) {
        tiles = toTiles(result.data);
      } else if (result.failure === "expired") {
        readCapability = "needs_reconnect";
      } else if (result.failure === "undecryptable" || result.failure === "not_found") {
        readCapability = "unreadable";
      } else {
        readCapability = "unavailable";
      }
    } catch (error) {
      readCapability = capabilityForReadFailure(error);
    }

    pages.push({
      connectionId: connection.id,
      pageName: pageNameOf(connection),
      capability: readCapability,
      tiles: readCapability === "ready" ? tiles : [],
    });
  }

  return { state: "pages", pages, periodLabel: INSIGHTS_PERIOD_LABEL };
}
