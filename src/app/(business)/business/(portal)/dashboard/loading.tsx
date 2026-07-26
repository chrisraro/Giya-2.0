import { Skeleton, SkeletonCircle, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for the business dashboard.
//
// No page heading bone: the portal's h1 lives in the Topbar, which is part of
// PortalShell in the (portal) layout and therefore OUTSIDE this loading
// boundary. It stays on screen with the sidebar while this renders.
//
// The KPI row is exactly four cards (visits, points issued, redemptions,
// customers) and each is 104px: p-4 + a 16px label + 4 + a 32px mono figure +
// 4 + a 16px delta line. Four is not a guess, it is the length of the KPI
// array in features/analytics/server/dashboard.ts.
//
// The verification banner is deliberately not represented. It renders only for
// draft and pending_verification businesses, so a bone for it would be wrong
// for every verified store and right for a minority. Omitting it means the
// banner pushes content down once, on the rare page load that has one, rather
// than reserving dead space on every load that does not.

/** 104px stat card: label, mono figure, delta. */
function KpiSkeleton() {
  return (
    <div className="flex flex-col gap-1 rounded-md3-md bg-surface-container-low p-4">
      <SkeletonText size="body-s" className="w-24" />
      <SkeletonText size="headline-s" className="w-16" />
      <SkeletonText size="body-s" className="w-20" />
    </div>
  );
}

export default function Loading() {
  return (
    <SkeletonScreen label="your dashboard" className="flex flex-col gap-6">
      {/* Review queue tile: same 104px height, in its own responsive grid. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1 rounded-md3-md border border-outline-variant bg-surface-container-low p-4">
          <SkeletonText size="body-s" className="w-28" />
          <SkeletonText size="headline-s" className="w-12" />
          <SkeletonText size="body-s" className="w-24" />
        </div>
      </div>

      {/* Four KPIs: 2 columns on small screens, 4 from lg. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>

      {/* Visits chart card: 56px header block + a 160px plot + 16px bottom pad. */}
      <div className="rounded-md3-md border border-outline-variant">
        <div className="flex flex-col gap-1 p-4">
          <SkeletonText size="title-m" className="w-32" />
        </div>
        <div className="p-4 pt-0">
          <Skeleton className="h-40 w-full rounded-md3-sm" />
        </div>
      </div>

      {/* Recent activity: 36px rows at gap-3. */}
      <div className="rounded-md3-md border border-outline-variant">
        <div className="flex flex-col gap-1 p-4">
          <SkeletonText size="title-m" className="w-32" />
        </div>
        <div className="p-4 pt-0">
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <SkeletonCircle className="size-9" />
                <div className="min-w-0 flex-1">
                  <SkeletonText size="body-m" className="w-56" />
                </div>
                <SkeletonText size="body-s" className="w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </SkeletonScreen>
  );
}
