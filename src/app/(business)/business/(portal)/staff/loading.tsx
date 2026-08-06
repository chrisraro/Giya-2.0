import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for the staff roster - a Card of stacked rows, not a table,
// so the skeleton is stacked rows too (see customers/loading.tsx's own note
// on why a skeleton's shape should match its screen's real DOM shape).

const ROWS = [0, 1, 2];

export default function Loading() {
  return (
    <SkeletonScreen label="your staff" className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <SkeletonText size="headline-s" className="w-24" />
          <SkeletonText size="body-s" className="w-64" />
        </div>
        <Skeleton className="h-10 w-24 rounded-full" />
      </div>

      <div className="flex flex-col divide-y divide-outline-variant rounded-md3-md border border-outline-variant">
        {ROWS.map((row) => (
          <div key={row} className="flex items-center justify-between gap-3 p-4">
            <div className="flex flex-col gap-2">
              <SkeletonText size="body-l" className="w-40" />
              <SkeletonText size="body-s" className="w-28" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-16 rounded-full" />
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
