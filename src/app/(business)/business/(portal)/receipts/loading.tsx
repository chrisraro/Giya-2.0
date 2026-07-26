import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for the receipt review queue.
//
// This is a money path and the queue is the thing a store owner opens most
// often, so the shape has to be right. Three status tabs (Needs review /
// Approved / Rejected) at h-9 -- note h-9, not the h-8 the customers and
// rewards pages use for their pills; the queue tabs are genuinely a different
// size and copying the wrong one would shift the list below.
//
// Rows are 72px on desktop (p-4 + a 40px two-line block) and stack to 104px
// below sm, which the responsive classes here reproduce.

export default function Loading() {
  return (
    <SkeletonScreen label="the receipt queue" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SkeletonText size="headline-s" className="w-36" />
          <SkeletonText size="body-s" className="w-80" />
        </div>
        <SkeletonText size="body-s" className="w-24" />
      </div>

      {/* Status tabs: h-9 pills. */}
      <div className="flex flex-wrap gap-2">
        {["w-32", "w-28", "w-24"].map((width, i) => (
          <Skeleton key={i} className={`h-9 rounded-full ${width}`} />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-3 rounded-md3-md border border-outline-variant p-4 sm:flex-row sm:items-center sm:gap-4"
          >
            <div className="min-w-0 flex-1">
              <SkeletonText size="title-m" className="w-48" />
              <SkeletonText size="body-s" className="w-32" />
            </div>
            <div className="shrink-0 sm:w-32">
              <SkeletonText size="title-m" className="w-20 sm:ml-auto" />
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:w-72 sm:justify-end">
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonScreen>
  );
}
