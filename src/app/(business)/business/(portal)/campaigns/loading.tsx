import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for campaigns: header, the earning-rule card, seven status
// filter chips (All / Active / Scheduled / Draft / Paused / Ended / Archived),
// then campaign cards grouped by status in a 3-up grid.
//
// The earning-rule card has three possible shapes depending on whether a rule
// exists and whether the editor opened itself. The skeleton uses the settled
// "rule exists" height (104px), which is the steady state for any store that
// has finished setting up; the taller editing form only appears for a store
// with no rule at all, and that store is looking at an onboarding task rather
// than a page load.

function CampaignCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-md3-md border border-outline-variant p-4">
      <div className="flex items-start justify-between gap-2">
        <SkeletonText size="title-m" className="w-32" />
        <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <SkeletonText size="body-s" className="w-full" />
      <div className="mt-auto flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-20 rounded-full" />
        <Skeleton className="h-8 w-20 rounded-full" />
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your campaigns" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SkeletonText size="headline-s" className="w-44" />
          <SkeletonText size="body-s" className="w-64" />
        </div>
        <Skeleton className="h-10 w-36 shrink-0 rounded-full" />
      </div>

      {/* Earning rule card. */}
      <div className="flex flex-col gap-3 rounded-md3-md border border-outline-variant p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <SkeletonText size="title-s" className="w-40" />
            <SkeletonText size="body-s" className="w-56" />
          </div>
          <Skeleton className="h-8 w-16 shrink-0 rounded-full" />
        </div>
        <Skeleton className="h-5 w-32 rounded-full" />
      </div>

      {/* Seven status chips. */}
      <div className="flex flex-wrap gap-2">
        {["w-14", "w-20", "w-24", "w-20", "w-20", "w-16", "w-24"].map((width, i) => (
          <Skeleton key={i} className={`h-8 rounded-full ${width}`} />
        ))}
      </div>

      {/* One status group of campaign cards. */}
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <SkeletonText size="title-s" className="w-24" />
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <CampaignCardSkeleton />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SkeletonScreen>
  );
}
