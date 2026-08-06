import { Skeleton, SkeletonScreen, SkeletonText } from "@/components/ui/skeleton";

// Route skeleton for /profile/devices.
//
// The page is `force-dynamic` (it reads the caller's own device rows), so this
// is seen on every navigation here, not only on a cold one. The shapes match the
// real screen: the back link and heading, an explainer line, then bordered rows
// carrying a summary, a "last used" line and a text button, and the standing
// note about what removing a device does and does not do.

export default function Loading() {
  return (
    <SkeletonScreen label="your devices" className="mx-auto max-w-md px-4 pt-6 pb-8">
      <div className="flex h-12 items-center">
        <SkeletonText size="label-l" className="w-20" />
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <SkeletonText size="headline-m" className="w-32" />
        <SkeletonText size="body-m" className="w-full" />
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="flex items-start justify-between gap-3 rounded-md3-md border border-outline-variant p-4"
          >
            <div className="flex flex-1 flex-col gap-2">
              <SkeletonText size="label-l" className="w-40" />
              <SkeletonText size="body-s" className="w-28" />
            </div>
            <Skeleton className="h-10 w-24 rounded-full" />
          </div>
        ))}
      </div>

      {/* The standing note under the list. */}
      <div className="mt-4 flex flex-col gap-2">
        <SkeletonText size="body-s" className="w-full" />
        <SkeletonText size="body-s" className="w-3/4" />
      </div>
    </SkeletonScreen>
  );
}
