/**
 * The shapes the business dashboard renders. Deliberately free of Supabase
 * types: everything here is already formatted for a tile, a bar or a feed row,
 * so the presentation layer has no arithmetic left to get wrong.
 */

/**
 * The second line of a KPI tile.
 *
 * `tone` exists so the UI can tell a MEASURED change apart from the honest
 * absence of one. A brand new merchant has no previous period to compare
 * against, and the only correct rendering of that is a calm, uncoloured
 * sentence saying so. Painting "No comparison yet" in the same accent as a
 * real "+12%" would teach people that the accent means nothing.
 */
export interface KpiDelta {
  text: string;
  tone: "trend" | "muted";
}

/** One dashboard metric tile: caption, figure, and the line underneath it. */
export interface DashboardKpi {
  label: string;
  /** Already formatted for display (thousands separators, `+` suffix when capped). */
  value: string;
  delta: KpiDelta;
}

/** One bar of the visits chart. `day` is the axis caption, e.g. `Mon`. */
export interface DailyCount {
  day: string;
  value: number;
}

/** One row of the recent-activity feed, already worded and timestamped. */
export interface ActivityItem {
  id: string;
  /** Material Symbols glyph name. */
  icon: string;
  text: string;
  timeLabel: string;
}

/** Everything the dashboard page renders below the verification banner. */
export interface BusinessDashboard {
  kpis: DashboardKpi[];
  visitsByDay: DailyCount[];
  /** Accessible description of the chart, built from the same data. */
  visitsChartLabel: string;
  activity: ActivityItem[];
  /**
   * True when the ledger read hit its row ceiling, so every ledger-derived
   * figure is a floor rather than a count. Surfaced, never hidden.
   */
  ledgerCapped: boolean;
}
