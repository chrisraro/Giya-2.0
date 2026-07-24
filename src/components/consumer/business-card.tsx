import { Card } from "@/components/ui/card";
import type { MockBusiness } from "@/lib/mock/consumer";

/** Outlined row card for a nearby business: name, type/city, distance chip, points rate. */
export function BusinessCard({ business }: { business: MockBusiness }) {
  return (
    <Card variant="outlined" className="flex items-center gap-3 p-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-title-m text-on-surface">{business.name}</p>
        <p className="mt-0.5 truncate text-body-s text-on-surface-variant">
          {business.type} · {business.city}
        </p>
        <p className="mt-1.5 text-label-m text-on-surface-variant">{business.pointsRate}</p>
      </div>
      <span className="shrink-0 rounded-full border border-outline px-3 py-1 text-label-m text-on-surface-variant">
        {business.distanceKm} km
      </span>
    </Card>
  );
}
