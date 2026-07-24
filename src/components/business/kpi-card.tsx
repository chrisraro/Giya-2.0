import { Card } from "@/components/ui/card";
import type { MockKpi } from "@/lib/mock/business";
import { cn } from "@/lib/utils";

export interface KpiCardProps {
  kpi: MockKpi;
  className?: string;
}

/** Single dashboard metric tile: label caption, mono figure, delta caption. */
export function KpiCard({ kpi, className }: KpiCardProps) {
  return (
    <Card className={cn("flex flex-col gap-1 bg-surface-container-low p-4", className)}>
      <p className="text-body-s text-on-surface-variant">{kpi.label}</p>
      <p className="font-mono text-headline-s text-on-surface">{kpi.value}</p>
      <p className="text-body-s text-secondary">{kpi.delta}</p>
    </Card>
  );
}
