import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for the business reward catalogue.
//
// Three filter chips (All / Active / Turned off) at h-8, then a 3-up card grid.
// Cards are ~230px: title row, badge row, description, a two-column definition
// list of stats, a campaign chip and a row of small action buttons.

function RewardCardSkeleton() {
  return (
    <div className="flex h-full flex-col gap-3 rounded-md3-md border border-outline-variant p-4">
      <div className="flex items-start justify-between gap-2">
        <SkeletonText size="title-m" className="w-32" />
        <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <SkeletonText size="body-s" className="w-full" />
      {/* Two label/value pairs across two columns. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <SkeletonText size="body-s" className="w-20" />
        <SkeletonText size="body-s" className="w-16" />
        <SkeletonText size="body-s" className="w-20" />
        <SkeletonText size="body-s" className="w-16" />
      </div>
      <Skeleton className="h-5 w-28 rounded-full" />
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-8 w-24 rounded-full" />
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your rewards" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SkeletonText size="headline-s" className="w-36" />
          <SkeletonText size="body-s" className="w-64" />
        </div>
        <Skeleton className="h-10 w-32 shrink-0 rounded-full" />
      </div>

      <div className="flex flex-wrap gap-2">
        {["w-14", "w-20", "w-24"].map((width, i) => (
          <Skeleton key={i} className={`h-8 rounded-full ${width}`} />
        ))}
      </div>

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i}>
            <RewardCardSkeleton />
          </li>
        ))}
      </ul>
    </SkeletonScreen>
  );
}
