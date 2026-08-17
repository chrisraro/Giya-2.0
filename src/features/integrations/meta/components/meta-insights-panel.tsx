import { Card } from "@/components/ui/card";

import { INSIGHTS_PAGE_COPY, INSIGHTS_SURFACE_COPY, TILE_UNREPORTED_LABEL } from "../copy";
import type { MetaInsightTile, MetaInsightsView, MetaPageInsights } from "../types";

// =============================================================================
// The audience and engagement tiles (doc 32 section 11.2, doc 42 V1).
// =============================================================================
//
// A SERVER COMPONENT. There is no "use client" here and there must not be one:
// nothing on this panel is interactive, the data arrives already resolved from
// server/insights.ts, and shipping a client bundle for four read-only numbers
// would put JavaScript on the critical path of a screen whose whole job is to
// be readable on a slow phone.
//
// -----------------------------------------------------------------------------
// THE RULE THIS COMPONENT ENFORCES AT THE LAST POSSIBLE MOMENT
// -----------------------------------------------------------------------------
//
// A tile renders a number ONLY when `reading.kind === 'value'`. Anything else
// renders words. The server already refuses to invent a figure; this is the
// second half of the same fence, and it is here because a `?? 0`, a `|| "-"` or
// a `Number(reading.value)` written in a hurry in this file would undo all of
// it. The sum type means such a line does not type-check.
//
// A zero IS a figure and is rendered as one. "Not reported" for every falsy
// reading would hide a genuinely quiet month behind a failure message, which is
// the same lie pointing the other way.
//
// -----------------------------------------------------------------------------
// WHY EVERY DEGRADED STATE STILL NAMES THE PAGE
// -----------------------------------------------------------------------------
//
// A merchant with two connected Pages seeing one bare "Facebook is not
// responding" cannot tell which of them it is about. The heading renders for
// every state, not only the healthy one.
//
// Colours are MD3 role tokens throughout, so both themes follow the palette
// with no per-theme branch in this file. Nothing here animates, so there is no
// `useReducedMotion` to gate.

/** Grouped digits. `en-PH` matches the date formatting on the connection card. */
function formatFigure(value: number): string {
  return value.toLocaleString("en-PH");
}

function InsightTile({ tile }: { tile: MetaInsightTile }) {
  const { reading } = tile;

  return (
    <div className="flex flex-col gap-1 rounded-md3-md border border-outline-variant bg-surface-container-low p-4">
      <p className="text-body-s text-on-surface-variant">{tile.label}</p>

      {/*
        ONE branch on the discriminant, deciding the words AND the type face
        together. An earlier version computed a `reported` boolean for the
        class and switched on `reading.kind` again for the text: two
        independent decisions about the same fact, which is how a tile ends up
        setting "Not reported" in the mono figure face, or a real figure in
        prose. A mutation test found that the second decision was untested,
        which is exactly what two branches on one fact buys you.

        The unreported reading is deliberately NOT in the mono face: a merchant
        scanning the row can tell a number from a non-number before reading
        either.
      */}
      {reading.kind === "value" ? (
        <p className="font-mono text-headline-s text-on-surface">{formatFigure(reading.value)}</p>
      ) : (
        <p className="text-body-m text-on-surface-variant">{TILE_UNREPORTED_LABEL}</p>
      )}
    </div>
  );
}

function PageInsights({ page }: { page: MetaPageInsights }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-title-s text-on-surface">{page.pageName}</h3>

      {page.capability === "ready" ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {page.tiles.map((tile) => (
            <InsightTile key={tile.metric} tile={tile} />
          ))}
        </div>
      ) : (
        // Informational, not an error: for four of these five states nothing
        // is broken, and for the fifth there is nothing the merchant can do.
        // No red, no alert role, no warning icon.
        <p className="rounded-md3-sm bg-surface-container-highest p-3 text-body-s text-on-surface-variant">
          {INSIGHTS_PAGE_COPY[page.capability]}
        </p>
      )}
    </section>
  );
}

export interface MetaInsightsPanelProps {
  readonly view: MetaInsightsView;
}

export function MetaInsightsPanel({ view }: MetaInsightsPanelProps) {
  return (
    <Card variant="outlined" className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-title-m text-on-surface">Facebook audience and engagement</h2>
        {view.state === "pages" ? (
          <p className="text-body-s text-on-surface-variant">{view.periodLabel}</p>
        ) : null}
      </div>

      {view.state === "pages" ? (
        <div className="flex flex-col gap-5">
          {view.pages.map((page) => (
            <PageInsights key={page.connectionId} page={page} />
          ))}
        </div>
      ) : (
        <p className="rounded-md3-sm bg-surface-container-highest p-4 text-body-m text-on-surface-variant">
          {INSIGHTS_SURFACE_COPY[view.state]}
        </p>
      )}

      <p className="text-body-s text-on-surface-variant">
        These figures come from Facebook and can lag by a few hours. A tile that reads
        &quot;{TILE_UNREPORTED_LABEL}&quot; means Facebook did not send that number, not that it was
        zero.
      </p>
    </Card>
  );
}
