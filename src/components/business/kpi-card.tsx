import { Card } from "@/components/ui/card";
import type { DashboardKpi } from "@/features/analytics/types";
import { cn } from "@/lib/utils";

export interface KpiCardProps {
  kpi: DashboardKpi;
  className?: string;
}

/**
 * Single dashboard metric tile: label caption, mono figure, delta caption.
 *
 * The delta's `tone` decides its colour, and that is the whole point of the
 * field. A measured change earns the accent; "No comparison yet" gets the
 * ordinary variant text, because it is not a measurement and must not read
 * like one. Both tones occupy the same line, so a merchant with no history
 * still gets tiles of equal height rather than a ragged grid.
 */
export function KpiCard({ kpi, className }: KpiCardProps) {
  return (
    <Card className={cn("flex flex-col gap-1 bg-surface-container-low p-4", className)}>
      <p className="text-body-s text-on-surface-variant">{kpi.label}</p>
      <p className="font-mono text-headline-s text-on-surface">{kpi.value}</p>
      <p
        className={cn(
          "text-body-s",
          kpi.delta.tone === "trend" ? "text-secondary" : "text-on-surface-variant",
        )}
      >
        {kpi.delta.text}
      </p>
    </Card>
  );
}
